import { interpolateEmailTemplate } from "@squash/shared";
import { and, eq } from "drizzle-orm";
import type { EmailAdapter } from "../adapters/email.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  emailTemplates,
  houseLeagueBookedOccurrences,
  houseLeagueMatchReminderSends,
  players,
} from "../db/schema.js";
import { stageAndMaybeSend } from "../automation/emailOutboxStage.js";
import type { StepRuntimeMode } from "../automation/executions.js";
import { calendarDateLocal, playDateAlignedWithReminderDay } from "./reminderDates.js";
import {
  getHouseLeagueEmailReminderSettings,
} from "./emailReminderSettings.js";

function courtLabel(config: AppConfig, courtId: number): string {
  if (courtId === config.US_SQUASH_COURT_1_ID) return "Court 1";
  if (courtId === config.US_SQUASH_COURT_2_ID) return "Court 2";
  return `Court ${courtId}`;
}

export async function processHouseLeagueMatchReminders(
  db: Db,
  config: AppConfig,
  emailAdapter: EmailAdapter,
  now: Date,
  autoSend: boolean,
  mode: StepRuntimeMode,
): Promise<{ staged: number; sent: number; skipped: number }> {
  const result = { staged: 0, sent: 0, skipped: 0 };
  const { enabled, daysBefore, templateId } = getHouseLeagueEmailReminderSettings(db);

  if (!enabled || templateId === null || templateId === "") {
    return result;
  }

  const templateRow = db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.id, templateId))
    .get();

  if (!templateRow || templateRow.scope !== "house_league") {
    return result;
  }

  const targetPlayDate = playDateAlignedWithReminderDay(daysBefore, now);

  const occRows = db
    .select()
    .from(houseLeagueBookedOccurrences)
    .where(eq(houseLeagueBookedOccurrences.playDate, targetPlayDate))
    .all();

  if (occRows.length === 0) return result;

  const pmap = new Map(db.select().from(players).all().map((p) => [p.id, p]));

  for (const occ of occRows) {
    for (const pid of [occ.player1Id, occ.player2Id] as const) {
      const existing = db
        .select()
        .from(houseLeagueMatchReminderSends)
        .where(
          and(
            eq(houseLeagueMatchReminderSends.occurrenceId, occ.id),
            eq(houseLeagueMatchReminderSends.playerId, pid),
          ),
        )
        .get();
      if (existing) {
        result.skipped += 1;
        continue;
      }

      const playerRow = pmap.get(pid);
      const opponentId = pid === occ.player1Id ? occ.player2Id : occ.player1Id;
      const opponentRow = pmap.get(opponentId);
      if (!playerRow?.email?.trim()) {
        result.skipped += 1;
        continue;
      }

      const vars: Record<string, string | undefined | null> = {
        playerName: playerRow.displayName,
        playerName2: opponentRow?.displayName ?? "",
        date: calendarDateLocal(now),
        matchDate: occ.playDate,
        matchSlot: occ.slot,
        matchTimeSlot: occ.slot,
        boxNumber: String(occ.boxNumber),
        weekNumber: String(occ.weekNumber),
        opponentName: opponentRow?.displayName ?? "",
        courtLabel: courtLabel(config, occ.courtId),
      };

      const subject = interpolateEmailTemplate(templateRow.subjectTemplate, vars);
      const body = interpolateEmailTemplate(templateRow.bodyTemplate, vars);

      const outcome = await stageAndMaybeSend(db, emailAdapter, autoSend, {
        kind: "house_league_match_reminder",
        seasonId: occ.seasonId,
        toAddress: playerRow.email!.trim(),
        subject,
        body,
        meta: {
          occurrenceId: occ.id,
          playerId: pid,
          opponentId,
          purpose: "house_league_scheduled_reminder",
        },
      });

      if (mode !== "replay") {
        db.insert(houseLeagueMatchReminderSends)
          .values({
            id: crypto.randomUUID(),
            occurrenceId: occ.id,
            playerId: pid,
            sentAt: now.toISOString(),
          })
          .run();
      }

      result.staged += 1;
      if (outcome.sent) result.sent += 1;
    }
  }

  return result;
}
