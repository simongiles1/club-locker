import { eq } from "drizzle-orm";
import { z } from "zod";
import { interpolateEmailTemplate } from "@squash/shared";
import type { Db } from "../db/client.js";
import { emailOutbox, emailTemplates, players } from "../db/schema.js";
import { nowForAutomation } from "../automation/clock.js";
import { calendarDateLocal } from "./reminderDates.js";

const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

export const houseLeagueReminderTestSendBody = z
  .object({
    templateId: z.string().min(1),
    toEmail: z.string().email().optional(),
    playerId: z.string().min(1).optional(),
    vars: z.record(z.string()).optional(),
    delayMinutes: z.number().int().positive().max(7 * 24 * 60).optional(),
    delayHours: z.number().int().positive().max(168).optional(),
    sendAt: z.string().min(4).optional(),
  })
  .superRefine((data, ctx) => {
    const timers = [data.delayMinutes, data.delayHours, data.sendAt].filter(
      (x) => x !== undefined,
    );
    if (timers.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provide exactly one of delayMinutes, delayHours, sendAt",
      });
      return;
    }
    if (!data.toEmail?.trim() && !data.playerId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provide toEmail and/or playerId",
      });
    }
  });

export type HouseLeagueReminderTestSendInput = z.infer<
  typeof houseLeagueReminderTestSendBody
>;

export function queueHouseLeagueReminderTestSend(
  db: Db,
  raw: unknown,
): { ok: true; id: string; scheduledSendAt: string } | { ok: false; error: string } {
  const parsed = houseLeagueReminderTestSendBody.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".") || "request"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: msg };
  }
  const body = parsed.data;
  const toEmail = body.toEmail?.trim();
  const playerId = body.playerId?.trim();

  let toAddress = toEmail ?? "";
  let playerName = "Test player";
  if (playerId) {
    const prow = db.select().from(players).where(eq(players.id, playerId)).get();
    if (!prow) return { ok: false, error: "player_not_found" };
    playerName = prow.displayName;
    if (!toAddress && prow.email?.trim()) {
      toAddress = prow.email.trim();
    }
  }
  if (!toAddress) return { ok: false, error: "missing_recipient_email" };

  const templateRow = db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.id, body.templateId))
    .get();
  if (!templateRow || templateRow.scope !== "house_league") {
    return { ok: false, error: "invalid_template" };
  }

  const now = nowForAutomation(db);
  let scheduledMs: number;
  if (body.sendAt) {
    const t = new Date(body.sendAt).getTime();
    if (!Number.isFinite(t)) return { ok: false, error: "invalid_sendAt" };
    if (t <= now.getTime()) return { ok: false, error: "sendAt_must_be_future" };
    if (t - now.getTime() > MAX_DELAY_MS)
      return { ok: false, error: "sendAt_beyond_max_delay" };
    scheduledMs = t;
  } else if (body.delayHours != null) {
    scheduledMs = now.getTime() + body.delayHours * 3600 * 1000;
  } else if (body.delayMinutes != null) {
    scheduledMs = now.getTime() + body.delayMinutes * 60 * 1000;
  } else {
    return { ok: false, error: "no_delay" };
  }

  const scheduledSendAt = new Date(scheduledMs).toISOString();

  const v = body.vars ?? {};
  const vars: Record<string, string | undefined | null> = {
    playerName: v.playerName ?? playerName,
    playerName2: v.playerName2 ?? "",
    date: calendarDateLocal(now),
    matchDate: v.matchDate ?? "2099-04-29",
    matchSlot: v.matchSlot ?? "18:00-19:00",
    matchTimeSlot: v.matchTimeSlot ?? v.matchSlot ?? "18:00-19:00",
    opponentName: v.opponentName ?? "Opponent",
    boxNumber: v.boxNumber ?? "1",
    weekNumber: v.weekNumber ?? "1",
    courtLabel: v.courtLabel ?? "Court 1",
    championshipName: v.championshipName ?? "",
    matchupBracket: v.matchupBracket ?? "",
    matchupFull: v.matchupFull ?? "",
    matchDueDate: v.matchDueDate ?? "",
    matchRound: v.matchRound ?? "",
  };

  const subject = interpolateEmailTemplate(templateRow.subjectTemplate, vars);
  const bodyText = interpolateEmailTemplate(templateRow.bodyTemplate, vars);

  const id = crypto.randomUUID();
  db.insert(emailOutbox)
    .values({
      id,
      kind: "house_league_reminder_test",
      seasonId: null,
      status: "scheduled",
      scheduledSendAt,
      toAddress,
      subject,
      body: bodyText,
      metaJson: JSON.stringify({
        purpose: "test_scheduled_reminder",
        templateId: body.templateId,
        playerId: playerId ?? undefined,
      }),
    })
    .run();

  return { ok: true, id, scheduledSendAt };
}
