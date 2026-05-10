import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Db } from "../db/client.js";
import type { AppConfig } from "../config.js";
import type { EmailAdapter } from "../adapters/email.js";
import type { AiAgent } from "./aiAgent.js";
import { processInboundEmail } from "./inbound.js";
import { isSettingOn } from "./settings.js";
import { approveInboundAction } from "./applyAction.js";

type PollerDeps = {
  db: Db;
  config: AppConfig;
  emailAdapter: EmailAdapter;
  aiAgent: AiAgent;
};

function parserAddress(input: unknown): string {
  const one = input as { value?: Array<{ address?: string }> } | undefined;
  if (one?.value?.[0]?.address) return one.value[0].address;
  const arr = input as Array<{ value?: Array<{ address?: string }> }> | undefined;
  if (Array.isArray(arr) && arr[0]?.value?.[0]?.address) {
    return arr[0].value[0].address;
  }
  return "";
}

function firstAddress(input: unknown): string {
  const value = input as { value?: Array<{ address?: string }> } | undefined;
  return value?.value?.[0]?.address ?? "";
}

/** Result of a single IMAP poll (manual endpoint returns this for troubleshooting). */
export type ImapPollOnceResult = {
  processed: number;
  /** Gmail account the poller is configured to use (same as GMAIL_USER). */
  imapUser: string | null;
  credsConfigured: boolean;
  connected: boolean;
  unseenCount: number;
  /** Messages matched UNSEEN but skipped (fetch had no body/envelope). */
  fetchSkippedCount: number;
  skipped?:
    | "not_running"
    | "imap_paused"
    | "imap_not_configured"
    | "not_connected";
  /** Set when the polled mailbox or processing throws. */
  errorMessage?: string;
};

export class ImapAutomationPoller {
  private readonly deps: PollerDeps;
  private client: ImapFlow | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: PollerDeps) {
    this.deps = deps;
  }

  /** Drop the active client after a socket/IMAP error so polls can reconnect. */
  private invalidateClientIfCurrent(client: ImapFlow, reason: unknown): void {
    if (this.client !== client) return;
    this.client = null;
    console.warn("[imap] connection lost:", reason);
    void client.logout().catch(() => {});
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.connect();
    } catch (err) {
      console.warn("[imap] start: connect failed:", err);
    }
    const intervalMs = Math.max(this.deps.config.AUTOMATION_TICK_INTERVAL_MS, 30_000);
    this.timer = setInterval(() => {
      void this.pollOnce("cron_fallback").catch((e) =>
        console.warn("[imap] cron poll failed:", e),
      );
    }, intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // ignore disconnect errors during shutdown
      }
      this.client = null;
    }
  }

  async pollOnce(
    triggerKind: "imap_exists" | "cron_fallback" | "manual",
  ): Promise<ImapPollOnceResult> {
    const cfg = this.deps.config;
    const imapUser = cfg.GMAIL_USER ?? null;
    const credsConfigured = Boolean(cfg.GMAIL_USER && cfg.GMAIL_APP_PASSWORD);

    const base = (partial: Partial<ImapPollOnceResult>): ImapPollOnceResult => ({
      processed: partial.processed ?? 0,
      imapUser: partial.imapUser ?? imapUser,
      credsConfigured: partial.credsConfigured ?? credsConfigured,
      connected: partial.connected ?? false,
      unseenCount: partial.unseenCount ?? 0,
      fetchSkippedCount: partial.fetchSkippedCount ?? 0,
      skipped: partial.skipped,
      errorMessage: partial.errorMessage,
    });

    if (!this.running && triggerKind !== "manual") {
      return base({ skipped: "not_running", connected: !!this.client });
    }
    if (isSettingOn(this.deps.db, "automation.imap_paused")) {
      return base({ skipped: "imap_paused", connected: !!this.client });
    }
    if (!credsConfigured) {
      return base({
        skipped: "imap_not_configured",
        connected: false,
      });
    }

    let client: ImapFlow | null;
    try {
      client = await this.ensureConnected();
    } catch (err) {
      console.warn("[imap] connect failed:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      return base({ connected: false, errorMessage });
    }
    if (!client) {
      return base({ skipped: "not_connected", connected: false });
    }

    let lastUnseenCount = 0;
    let fetchSkippedCount = 0;
    try {
      const searchResult = await client.search({ seen: false });
      const uids = Array.isArray(searchResult) ? searchResult : [];
      lastUnseenCount = uids.length;
      let processed = 0;
      fetchSkippedCount = 0;
      for (const uid of uids) {
        const msg = (await client.fetchOne(uid, {
          uid: true,
          envelope: true,
          source: true,
          internalDate: true,
        })) as {
          uid?: number;
          envelope?: { from?: unknown; to?: unknown; subject?: string };
          source?: Buffer;
          internalDate?: Date;
        } | null;
        if (!msg?.source || !msg.envelope) {
          fetchSkippedCount++;
          continue;
        }
        const parsed = await simpleParser(msg.source);
        const from = parserAddress(parsed.from) || firstAddress(msg.envelope.from);
        const to = parserAddress(parsed.to) || firstAddress(msg.envelope.to);
        await processInboundEmail(
          this.deps.db,
          this.deps.config,
          this.deps.aiAgent,
          {
            messageId: parsed.messageId ?? `imap-${msg.uid}-${Date.now()}`,
            fromAddress: from || "unknown@example.test",
            toAddress:
              to || this.deps.config.GMAIL_USER || "unknown@example.test",
            subject: parsed.subject ?? msg.envelope.subject ?? "",
            bodyText: parsed.text ?? "",
            bodyHtml: parsed.html ? String(parsed.html) : "",
            receivedAt:
              parsed.date?.toISOString() ??
              msg.internalDate?.toISOString() ??
              new Date().toISOString(),
          },
          { kind: "imap", refId: parsed.messageId ?? String(msg.uid ?? "") },
          "normal",
          async (actionId) => {
            await approveInboundAction(
              this.deps.db,
              this.deps.config,
              this.deps.emailAdapter,
              actionId,
            );
          },
        );
        await client.messageFlagsAdd(uid, ["\\Seen"]);
        processed++;
      }
      return base({
        processed,
        connected: true,
        unseenCount: lastUnseenCount,
        fetchSkippedCount,
      });
    } catch (err) {
      console.warn("[imap] poll failed:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      return base({
        connected: true,
        errorMessage,
        unseenCount: lastUnseenCount,
        fetchSkippedCount,
      });
    }
  }

  private async connect(): Promise<void> {
    if (this.client) return;
    const cfg = this.deps.config;
    if (!cfg.GMAIL_USER || !cfg.GMAIL_APP_PASSWORD) {
      console.warn("[imap] skipped: missing GMAIL_USER or GMAIL_APP_PASSWORD");
      return;
    }
    const client = new ImapFlow({
      host: cfg.GMAIL_IMAP_HOST,
      port: cfg.GMAIL_IMAP_PORT,
      secure: true,
      auth: {
        user: cfg.GMAIL_USER,
        pass: cfg.GMAIL_APP_PASSWORD,
      },
      logger: false,
    });
    client.on("error", (err) => {
      this.invalidateClientIfCurrent(client, err);
    });
    try {
      await client.connect();
      await client.mailboxOpen("INBOX");
    } catch (err) {
      console.warn("[imap] connect failed:", err);
      void client.logout().catch(() => {});
      return;
    }
    client.on("exists", () => {
      void this.pollOnce("imap_exists").catch((e) =>
        console.warn("[imap] exists poll failed:", e),
      );
    });
    this.client = client;
  }

  private async ensureConnected(): Promise<ImapFlow | null> {
    if (!this.client) {
      await this.connect();
    }
    return this.client;
  }
}
