import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { AppConfig } from "../config.js";
import type { EmailAdapter } from "../adapters/email.js";
import { championshipDraws, championshipMatchFollowups, championshipMatches, championships } from "../db/schema.js";
import { getChampionshipDetail, buildMatchAnnouncementDraft } from "../championships/service.js";
import { stageAndMaybeSend } from "./emailOutboxStage.js";
import { nowForAutomation } from "./clock.js";
import { runWithExecution, type ExecutionTrigger, type StepRuntimeMode } from "./executions.js";
import { shouldAutoSendForCurrentMode } from "./settings.js";
import { processScheduledOutbox } from "../houseLeague/scheduledOutbox.js";
import { processHouseLeagueMatchReminders } from "../houseLeague/matchReminderScheduler.js";

type FollowupKind =
  | "round_announce"
  | "deadline_3d"
  | "deadline_chase"
  | "result_chase";

type SchedulerResult = {
  staged: number;
  sent: number;
  skipped: number;
};

function dueDateForMatch(match: typeof championshipMatches.$inferSelect, championshipRoundOneDueDate: string | null): string | null {
  if (match.dueDate) return match.dueDate;
  if (match.round === 1) return championshipRoundOneDueDate;
  return null;
}

export async function runSchedulerTick(
  db: Db,
  config: AppConfig,
  emailAdapter: EmailAdapter,
  trigger: ExecutionTrigger = { kind: "cron" },
  mode: StepRuntimeMode = "normal",
): Promise<SchedulerResult> {
  return runWithExecution(
    db,
    config,
    "scheduler_tick",
    trigger,
    {},
    async (ctx) => {
      const now = nowForAutomation(db);
      const autoSend = shouldAutoSendForCurrentMode(db) && mode !== "replay";
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
      const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
      const fortyEightHoursMs = 48 * 60 * 60 * 1000;
      const result: SchedulerResult = { staged: 0, sent: 0, skipped: 0 };

      const schedOutbox = await ctx.step(
        "scheduled_outbox",
        {},
        async () => processScheduledOutbox(db, emailAdapter, now),
      );
      result.sent += schedOutbox.sent;
      result.skipped += schedOutbox.failed;

      const published = await ctx.step("load_published_draws", {}, async () =>
        db
          .select({
            championshipId: championships.id,
            seasonId: championships.seasonId,
            championshipName: championships.name,
            roundOneDueDate: championships.roundOneDueDate,
            drawId: championshipDraws.id,
          })
          .from(championships)
          .innerJoin(
            championshipDraws,
            and(
              eq(championshipDraws.championshipId, championships.id),
              eq(championshipDraws.status, "published"),
            ),
          )
          .where(eq(championships.status, "published"))
          .all(),
      );

      for (const row of published) {
        const detail = getChampionshipDetail(db, row.championshipId);
        if (!detail?.activeDraw) {
          result.skipped += 1;
          continue;
        }
        for (const match of detail.activeDraw.matches) {
          if (match.topIsBye || match.bottomIsBye) {
            result.skipped += 1;
            continue;
          }
          if (!match.topEntryId || !match.bottomEntryId) {
            result.skipped += 1;
            continue;
          }
          const dueDate = dueDateForMatch(match, row.roundOneDueDate);
          const followups = db
            .select()
            .from(championshipMatchFollowups)
            .where(eq(championshipMatchFollowups.matchId, match.id))
            .orderBy(desc(championshipMatchFollowups.createdAt))
            .all();
          const hasKind = (kind: FollowupKind) =>
            followups.some((f) => f.kind === kind);
          const lastKindAt = (kind: FollowupKind) =>
            followups.find((f) => f.kind === kind)?.sentAt ?? null;

          const announceNeeded = !hasKind("round_announce");
          const dueTs = dueDate ? new Date(dueDate).getTime() : null;
          const deadlineWindowReached =
            dueTs !== null && dueTs - now.getTime() <= threeDaysMs;
          const deadline3dNeeded =
            deadlineWindowReached && !match.scheduledAt && !hasKind("deadline_3d");
          const lastDeadlineChaseAt = lastKindAt("deadline_chase");
          const nextChaseDue =
            lastDeadlineChaseAt != null
              ? new Date(lastDeadlineChaseAt).getTime() + twoDaysMs <= now.getTime()
              : deadlineWindowReached;
          const deadlineChaseNeeded =
            deadlineWindowReached &&
            !match.scheduledAt &&
            nextChaseDue &&
            !deadline3dNeeded;
          const scheduledTs = match.scheduledAt
            ? new Date(match.scheduledAt).getTime()
            : null;
          const lastResultChaseAt = lastKindAt("result_chase");
          const resultChaseRecent =
            lastResultChaseAt != null &&
            new Date(lastResultChaseAt).getTime() + fortyEightHoursMs > now.getTime();
          const resultChaseNeeded =
            scheduledTs != null &&
            scheduledTs + fortyEightHoursMs <= now.getTime() &&
            !match.winnerEntryId &&
            !resultChaseRecent;

          const actions: {
            kind: FollowupKind;
            outboxKind: string;
            subject: string;
            body: string;
            toAddress: string;
            meta: Record<string, unknown>;
          }[] = [];

          if (announceNeeded) {
            const announcement = buildMatchAnnouncementDraft({
              detail,
              match,
              round: match.round,
              dueDate,
            });
            if ("reason" in announcement) {
              result.skipped += 1;
            } else {
              actions.push({
                kind: "round_announce",
                outboxKind: "championship_round_announce",
                subject: announcement.subject,
                body: announcement.body,
                toAddress: announcement.recipients.join(", "),
                meta: {
                  championshipId: row.championshipId,
                  matchId: match.id,
                  round: match.round,
                  dueDate,
                },
              });
            }
          }

          if (deadline3dNeeded) {
            actions.push({
              kind: "deadline_3d",
              outboxKind: "championship_deadline_3d",
              subject: `${row.championshipName} — reminder to schedule your match`,
              body: `Reminder: your match is due by ${dueDate}. Please reply-all with your planned match time.`,
              toAddress: await resolveMatchRecipients(db, detail, match.id),
              meta: { championshipId: row.championshipId, matchId: match.id, dueDate },
            });
          } else if (deadlineChaseNeeded) {
            actions.push({
              kind: "deadline_chase",
              outboxKind: "championship_deadline_chase",
              subject: `${row.championshipName} — follow-up to schedule match`,
              body: `Follow-up: we still need your planned match time. Deadline remains ${dueDate}.`,
              toAddress: await resolveMatchRecipients(db, detail, match.id),
              meta: { championshipId: row.championshipId, matchId: match.id, dueDate },
            });
          }

          if (resultChaseNeeded) {
            actions.push({
              kind: "result_chase",
              outboxKind: "championship_result_chase",
              subject: `${row.championshipName} — please report your match result`,
              body: `It has been over 48 hours since your scheduled match time (${match.scheduledAt}). Please reply with the result.`,
              toAddress: await resolveMatchRecipients(db, detail, match.id),
              meta: { championshipId: row.championshipId, matchId: match.id, scheduledAt: match.scheduledAt },
            });
          }

          for (const action of actions) {
            const outcome = await ctx.step(
              `stage_${action.kind}`,
              { matchId: match.id, kind: action.kind },
              async () =>
                stageAndMaybeSend(db, emailAdapter, autoSend, {
                  kind: action.outboxKind,
                  seasonId: row.seasonId ?? null,
                  toAddress: action.toAddress,
                  subject: action.subject,
                  body: action.body,
                  meta: action.meta,
                }),
            );
            if (mode !== "replay") {
              db.insert(championshipMatchFollowups)
                .values({
                  id: crypto.randomUUID(),
                  matchId: match.id,
                  kind: action.kind,
                  sentAt: now.toISOString(),
                })
                .run();
            }
            result.staged += 1;
            if (outcome.sent) result.sent += 1;
          }
        }
      }

      const hl = await ctx.step(
        "house_league_match_reminders",
        {},
        async () =>
          processHouseLeagueMatchReminders(
            db,
            config,
            emailAdapter,
            now,
            autoSend,
            mode,
          ),
      );
      result.staged += hl.staged;
      result.sent += hl.sent;
      result.skipped += hl.skipped;

      return result;
    },
    { mode },
  );
}

async function resolveMatchRecipients(
  _db: Db,
  detail: NonNullable<ReturnType<typeof getChampionshipDetail>>,
  matchId: string,
): Promise<string> {
  const match = detail.activeDraw?.matches.find((m) => m.id === matchId);
  if (!match || !match.topEntryId || !match.bottomEntryId) return "unknown@example.test";
  const entries = new Map(detail.entries.map((e) => [e.id, e]));
  const top = entries.get(match.topEntryId);
  const bottom = entries.get(match.bottomEntryId);
  const recipients = [top?.playerEmail, top?.partnerEmail, bottom?.playerEmail, bottom?.partnerEmail]
    .filter((addr): addr is string => Boolean(addr));
  return recipients.join(", ") || "unknown@example.test";
}
