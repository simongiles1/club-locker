import { and, eq, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { AppConfig } from "../config.js";
import type { EmailAdapter } from "../adapters/email.js";
import { championshipEntries, championshipMatches, championships, emailOutbox, inboundActions, inboundEmails, players } from "../db/schema.js";
import { updateMatch } from "../championships/service.js";
import { runWithExecution, type StepRuntimeMode } from "./executions.js";
import { shouldAutoSendForCurrentMode } from "./settings.js";

type JsonRecord = Record<string, unknown>;

function parsePayload(raw: string | null): JsonRecord {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as JsonRecord;
  } catch {
    return {};
  }
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function stripPlusTag(email: string): string {
  const [localPart, domain] = normalizeEmail(email).split("@");
  if (!localPart || !domain) return normalizeEmail(email);
  const local = localPart.includes("+") ? localPart.split("+")[0] : localPart;
  return `${local}@${domain}`;
}

async function stageMaybeSend(
  db: Db,
  emailAdapter: EmailAdapter,
  autoSend: boolean,
  to: string,
  subject: string,
  body: string,
  meta: Record<string, unknown>,
): Promise<{ outboxId: string; sent: boolean }> {
  const id = crypto.randomUUID();
  db.insert(emailOutbox)
    .values({
      id,
      kind: "championship_signup_ack",
      seasonId: null,
      status: autoSend ? "approved" : "draft",
      toAddress: to,
      subject,
      body,
      metaJson: JSON.stringify(meta),
    })
    .run();
  if (!autoSend) return { outboxId: id, sent: false };
  const res = await emailAdapter.send({ to, subject, body, meta });
  if (!res.ok) {
    db.update(emailOutbox)
      .set({ status: "approved" })
      .where(eq(emailOutbox.id, id))
      .run();
    return { outboxId: id, sent: false };
  }
  const ts = new Date().toISOString();
  db.update(emailOutbox)
    .set({ status: "sent", sentAt: ts })
    .where(eq(emailOutbox.id, id))
    .run();
  return { outboxId: id, sent: true };
}

export async function approveInboundAction(
  db: Db,
  config: AppConfig,
  emailAdapter: EmailAdapter,
  actionId: string,
  mode: StepRuntimeMode = "normal",
): Promise<{ ok: true; actionId: string; appliedRefId: string | null }> {
  return runWithExecution(
    db,
    config,
    "apply_action",
    { kind: "manual", refId: actionId },
    { actionId },
    async (ctx) => {
      const action = await ctx.step("load_action", { actionId }, async () =>
        db.select().from(inboundActions).where(eq(inboundActions.id, actionId)).get(),
      );
      if (!action) throw new Error("inbound_action_not_found");
      const email = await ctx.step("load_email", { emailId: action.emailId }, async () =>
        db.select().from(inboundEmails).where(eq(inboundEmails.id, action.emailId)).get(),
      );
      if (!email) throw new Error("inbound_email_not_found");
      const payload = parsePayload(action.payloadJson);
      const autoSend = shouldAutoSendForCurrentMode(db) && mode !== "replay";

      const sender = normalizeEmail(email.fromAddress);
      const senderBase = stripPlusTag(sender);
      const senderPlayer = await ctx.step(
        "lookup_player",
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

      let appliedRefId: string | null = null;

      if (action.kind === "signup") {
        if (!senderPlayer) throw new Error("sender_not_matched_to_player");
        const requestedChampionshipId =
          typeof payload.championshipId === "string" ? payload.championshipId : null;
        const championship = await ctx.step(
          "resolve_championship",
          { requestedChampionshipId },
          async () => {
            if (requestedChampionshipId) {
              return db
                .select()
                .from(championships)
                .where(eq(championships.id, requestedChampionshipId))
                .get();
            }
            return db
              .select()
              .from(championships)
              .where(eq(championships.status, "registration"))
              .all()
              .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
          },
        );
        if (!championship) throw new Error("championship_not_found");
        const existing = await ctx.step(
          "check_existing_entry",
          { championshipId: championship.id, playerId: senderPlayer.id },
          async () =>
            db
              .select()
              .from(championshipEntries)
              .where(
                and(
                  eq(championshipEntries.championshipId, championship.id),
                  eq(championshipEntries.playerId, senderPlayer.id),
                ),
              )
              .get(),
        );
        if (!existing && mode !== "replay") {
          appliedRefId = crypto.randomUUID();
          db.insert(championshipEntries)
            .values({
              id: appliedRefId,
              championshipId: championship.id,
              playerId: senderPlayer.id,
              partnerPlayerId: null,
              seed: null,
            })
            .run();
        } else {
          appliedRefId = existing?.id ?? "replay_only_entry";
        }
        if (mode !== "replay") {
          await stageMaybeSend(
            db,
            emailAdapter,
            autoSend,
            email.fromAddress,
            `Signup received — ${championship.name}`,
            `Hi ${senderPlayer.displayName},\n\nYou're now entered in ${championship.name}.\n\nThanks!`,
            { inboundActionId: action.id, kind: "signup_ack" },
          );
        }
      } else if (action.kind === "schedule_match") {
        const matchId = typeof payload.matchId === "string" ? payload.matchId : null;
        const scheduledAt =
          typeof payload.scheduledAt === "string" ? payload.scheduledAt : null;
        if (!matchId || !scheduledAt) {
          throw new Error("schedule_match_payload_incomplete");
        }
        await ctx.step("update_match_schedule", { matchId, scheduledAt }, async () => {
          if (mode !== "replay") {
            db.update(championshipMatches)
              .set({ scheduledAt })
              .where(eq(championshipMatches.id, matchId))
              .run();
          }
          return { ok: true };
        });
        appliedRefId = matchId;
      } else if (action.kind === "report_result") {
        const matchId = typeof payload.matchId === "string" ? payload.matchId : null;
        if (!matchId) throw new Error("report_result_payload_missing_match_id");
        const match = await ctx.step("load_match", { matchId }, async () =>
          db.select().from(championshipMatches).where(eq(championshipMatches.id, matchId)).get(),
        );
        if (!match) throw new Error("match_not_found");
        const winnerEntryId =
          typeof payload.winnerEntryId === "string" ? payload.winnerEntryId : null;
        if (!winnerEntryId) throw new Error("report_result_payload_missing_winner_entry_id");
        await ctx.step("set_match_winner", { matchId, winnerEntryId }, async () => {
          if (mode !== "replay") {
            updateMatch(db, matchId, { winnerEntryId });
          }
          return { ok: true };
        });
        appliedRefId = matchId;
      } else {
        throw new Error("action_kind_unknown_cannot_apply");
      }

      await ctx.step(
        "mark_action_applied",
        { actionId: action.id, appliedRefId },
        async () => {
          if (mode !== "replay") {
            db.update(inboundActions)
              .set({
                status: "applied",
                appliedAt: new Date().toISOString(),
                appliedRefId,
              })
              .where(eq(inboundActions.id, action.id))
              .run();
          }
          return { ok: true };
        },
      );

      return { ok: true as const, actionId: action.id, appliedRefId };
    },
    { mode },
  );
}

export function rejectInboundAction(
  db: Db,
  actionId: string,
  reason?: string,
): { ok: true } {
  db.update(inboundActions)
    .set({
      status: "rejected",
      appliedRefId: reason ?? null,
    })
    .where(eq(inboundActions.id, actionId))
    .run();
  return { ok: true };
}
