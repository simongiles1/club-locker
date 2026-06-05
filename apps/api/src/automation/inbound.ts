import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { AppConfig } from "../config.js";
import { championships, championshipEntries, championshipMatches, emailOutbox, inboundActions, inboundEmails, players } from "../db/schema.js";
import { mailboxScopeFromAliasTag } from "../emails/mailboxScope.js";
import type { AiAgent } from "./aiAgent.js";
import { runWithExecution, type ExecutionTrigger, type StepRuntimeMode } from "./executions.js";
import { confidenceAllowsAutoApply, shouldAutoSendForCurrentMode } from "./settings.js";

function entryDisplayLabel(db: Db, entryId: string): string {
  const entry = db
    .select()
    .from(championshipEntries)
    .where(eq(championshipEntries.id, entryId))
    .get();
  if (!entry) return "?";
  const p1 = db.select().from(players).where(eq(players.id, entry.playerId)).get();
  if (!entry.partnerPlayerId) {
    return p1?.displayName ?? "?";
  }
  const p2 = db
    .select()
    .from(players)
    .where(eq(players.id, entry.partnerPlayerId))
    .get();
  return `${p1?.displayName ?? "?"} & ${p2?.displayName ?? "?"}`;
}

function senderTouchesEntry(
  playerId: string,
  entry:
    | { playerId: string; partnerPlayerId: string | null }
    | undefined,
): boolean {
  if (!entry) return false;
  return (
    entry.playerId === playerId ||
    entry.partnerPlayerId === playerId
  );
}

/** Open matches where the sender is on the top or bottom slot (player or doubles partner). */
function loadOpenMatchesForSender(db: Db, playerId: string) {
  const rows = db
    .select({
      id: championshipMatches.id,
      championshipId: championshipMatches.championshipId,
      round: championshipMatches.round,
      dueDate: championshipMatches.dueDate,
      topEntryId: championshipMatches.topEntryId,
      bottomEntryId: championshipMatches.bottomEntryId,
      championshipName: championships.name,
    })
    .from(championshipMatches)
    .innerJoin(championships, eq(championshipMatches.championshipId, championships.id))
    .where(
      and(
        isNull(championshipMatches.winnerEntryId),
        isNotNull(championshipMatches.topEntryId),
        isNotNull(championshipMatches.bottomEntryId),
      ),
    )
    .all();

  const out: {
    id: string;
    championshipId: string;
    round: number;
    dueDate: string | null;
    championshipName: string;
    summary: string;
  }[] = [];

  for (const m of rows) {
    if (!m.topEntryId || !m.bottomEntryId) continue;
    const top = db
      .select()
      .from(championshipEntries)
      .where(eq(championshipEntries.id, m.topEntryId))
      .get();
    const bottom = db
      .select()
      .from(championshipEntries)
      .where(eq(championshipEntries.id, m.bottomEntryId))
      .get();
    if (!senderTouchesEntry(playerId, top) && !senderTouchesEntry(playerId, bottom)) {
      continue;
    }
    const topLabel = entryDisplayLabel(db, m.topEntryId);
    const bottomLabel = entryDisplayLabel(db, m.bottomEntryId);
    out.push({
      id: m.id,
      championshipId: m.championshipId,
      round: m.round,
      dueDate: m.dueDate ?? null,
      championshipName: m.championshipName,
      summary: `${topLabel} vs ${bottomLabel}`,
    });
  }
  return out;
}

export type ProcessInboundInput = {
  messageId: string;
  fromAddress: string;
  toAddress: string;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  receivedAt?: string;
};

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function stripPlusTag(email: string): string {
  const [localPart, domain] = normalizeEmail(email).split("@");
  if (!localPart || !domain) return normalizeEmail(email);
  const local = localPart.includes("+") ? localPart.split("+")[0] : localPart;
  return `${local}@${domain}`;
}

function aliasTagFromToAddress(toAddress: string): string | null {
  const [localPart] = normalizeEmail(toAddress).split("@");
  if (!localPart || !localPart.includes("+")) return null;
  const tag = localPart.split("+")[1]?.trim();
  return tag || null;
}

export async function processInboundEmail(
  db: Db,
  config: AppConfig,
  aiAgent: AiAgent,
  input: ProcessInboundInput,
  trigger: ExecutionTrigger = { kind: "imap", refId: input.messageId },
  mode: StepRuntimeMode = "normal",
  autoApproveAction?: (actionId: string) => Promise<void>,
): Promise<{ emailId: string; actionId: string }> {
  /** When a prior run inserted `inbound_emails` but failed before `inbound_actions`, reuse that row. */
  let resumeEmailId: string | null = null;
  if (mode === "normal") {
    const existing = db
      .select()
      .from(inboundEmails)
      .where(eq(inboundEmails.messageId, input.messageId))
      .get();
    if (existing) {
      const existingAction = db
        .select()
        .from(inboundActions)
        .where(eq(inboundActions.emailId, existing.id))
        .all()
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      if (existingAction) {
        return { emailId: existing.id, actionId: existingAction.id };
      }
      resumeEmailId = existing.id;
    }
  }

  return runWithExecution(
    db,
    config,
    "inbound_email_processing",
    trigger,
    input,
    async (ctx) => {
      const nowIso = new Date().toISOString();
      const emailId = resumeEmailId ?? crypto.randomUUID();
      const aliasTag = await ctx.step("parse_alias", { toAddress: input.toAddress }, async () =>
        aliasTagFromToAddress(input.toAddress),
      );
      await ctx.step("insert_inbound_email", { messageId: input.messageId }, async () => {
        if (resumeEmailId) return { ok: true, resumed: true };
        db.insert(inboundEmails)
          .values({
            id: emailId,
            messageId: input.messageId,
            fromAddress: input.fromAddress,
            toAddress: input.toAddress,
            subject: input.subject ?? null,
            bodyText: input.bodyText ?? null,
            bodyHtml: input.bodyHtml ?? null,
            aliasTag,
            mailboxScope: mailboxScopeFromAliasTag(aliasTag),
            receivedAt: input.receivedAt ?? nowIso,
            processedAt: null,
          })
          .run();
        return { ok: true };
      });

      const sender = normalizeEmail(input.fromAddress);
      const senderBase = stripPlusTag(sender);
      const matchedPlayer = await ctx.step(
        "match_player_by_sender",
        { sender, senderBase },
        async () =>
          db
            .select()
            .from(players)
            .where(
              or(
                sql`lower(${players.email}) = ${sender}`,
                sql`lower(${players.email}) = ${senderBase}`,
              ),
            )
            .get(),
      );

      const activeChampionships = await ctx.step("load_active_championships", {}, async () =>
        db
          .select({
            id: championships.id,
            name: championships.name,
            divisionLabel: championships.divisionLabel,
          })
          .from(championships)
          .where(
            or(
              eq(championships.status, "registration"),
              eq(championships.status, "drawn"),
              eq(championships.status, "published"),
            ),
          )
          .all(),
      );

      const openMatches = await ctx.step(
        "load_open_matches",
        { playerId: matchedPlayer?.id ?? null },
        async () => {
          if (!matchedPlayer) return [];
          return loadOpenMatchesForSender(db, matchedPlayer.id);
        },
      );

      const classification = await ctx.aiStep(
        "gemini.classify",
        {
          fromAddress: input.fromAddress,
          subject: input.subject ?? "",
        },
        async () =>
          aiAgent.classifyEmail({
            fromEmail: input.fromAddress,
            toEmail: input.toAddress,
            subject: input.subject ?? "",
            body: input.bodyText ?? input.bodyHtml ?? "",
            context: {
              activeChampionships,
              senderPlayerId: matchedPlayer?.id ?? null,
              openMatches,
            },
          }),
      );

      const actionId = crypto.randomUUID();
      await ctx.step(
        "insert_inbound_action",
        { actionKind: classification.kind, confidence: classification.confidence },
        async () => {
          db.insert(inboundActions)
            .values({
              id: actionId,
              emailId,
              kind: classification.kind,
              payloadJson: JSON.stringify(classification.payload),
              confidence: classification.confidence,
              status: "pending",
            })
            .run();
          return { ok: true };
        },
      );

      await ctx.step("stage_optional_reply", { hasReply: !!classification.replyDraft }, async () => {
        if (!classification.replyDraft) return { staged: false };
        db.insert(emailOutbox)
          .values({
            id: crypto.randomUUID(),
            kind: "championship_ai_reply",
            seasonId: null,
            status: "draft",
            toAddress: input.fromAddress,
            subject: `Re: ${input.subject ?? "club championship update"}`,
            body: classification.replyDraft,
            metaJson: JSON.stringify({
              inboundEmailId: emailId,
              inboundActionId: actionId,
            }),
          })
          .run();
        return { staged: true };
      });

      await ctx.step(
        "auto_apply_if_enabled",
        {
          mode,
          confidence: classification.confidence,
          autoSend: shouldAutoSendForCurrentMode(db),
          kind: classification.kind,
        },
        async () => {
          if (mode !== "normal") return { autoApplied: false, reason: "not_normal_mode" };
          if (!autoApproveAction) return { autoApplied: false, reason: "no_auto_approver" };
          if (classification.kind === "unknown") {
            return { autoApplied: false, reason: "unknown_kind" };
          }
          if (
            !confidenceAllowsAutoApply(
              db,
              classification.confidence as "low" | "medium" | "high",
            )
          ) {
            return { autoApplied: false, reason: "confidence_below_threshold" };
          }
          /* Schedule updates are DB-only (no outbox). Do not require auto-send toggles. */
          const scheduleEmailOnlyKinds =
            classification.kind === "signup" || classification.kind === "report_result";
          if (scheduleEmailOnlyKinds && !shouldAutoSendForCurrentMode(db)) {
            return { autoApplied: false, reason: "auto_send_off" };
          }
          await autoApproveAction(actionId);
          return { autoApplied: true };
        },
      );

      await ctx.step("mark_processed", { emailId }, async () => {
        db.update(inboundEmails)
          .set({ processedAt: new Date().toISOString(), errorMessage: null })
          .where(eq(inboundEmails.id, emailId))
          .run();
        return { ok: true };
      });

      return { emailId, actionId };
    },
    { mode },
  );
}
