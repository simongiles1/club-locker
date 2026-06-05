import { isWednesdayLocal } from "@squash/shared";
import { eq } from "drizzle-orm";
import type { EmailAdapter } from "../adapters/email.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { seasons } from "../db/schema.js";
import type { StepRuntimeMode } from "../automation/executions.js";
import {
  getHouseLeagueWeeklyBoxEmailSettings,
  WEEKLY_BOX_EMAIL_SETTING_KEYS,
} from "./weeklyBoxEmailTemplateSettings.js";
import {
  resolveWeeklyTargetWeek,
  stageWeeklyBoxEmails,
} from "./weeklyBoxEmail.js";
import { resolveSeasonMeta } from "./boxEmlFiles.js";
import { createUssquashClient } from "../booking/clubLockerClient.js";

function resolveSeasonIdForWeeklyEmail(db: Db, config: AppConfig): string | null {
  const settings = getHouseLeagueWeeklyBoxEmailSettings(db, config);
  if (settings.seasonId) return settings.seasonId;

  const row = db
    .select()
    .from(seasons)
    .all()
    .filter((s) => s.houseLeagueEventId != null && s.houseLeagueEventId > 0)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  return row?.id ?? null;
}

export async function processWeeklyBoxEmails(
  db: Db,
  config: AppConfig,
  emailAdapter: EmailAdapter,
  now: Date,
  autoSend: boolean,
  mode: StepRuntimeMode,
  options?: { force?: boolean },
): Promise<{ staged: number; sent: number; skipped: number }> {
  const result = { staged: 0, sent: 0, skipped: 0 };
  const settings = getHouseLeagueWeeklyBoxEmailSettings(db, config);
  if (!settings.enabled) return result;

  if (!options?.force && !isWednesdayLocal(now)) return result;

  const seasonId = resolveSeasonIdForWeeklyEmail(db, config);
  if (!seasonId) return result;

  const client = createUssquashClient(config);
  const meta = await resolveSeasonMeta(db, client, config, seasonId);
  if ("error" in meta) return result;

  const target = resolveWeeklyTargetWeek(db, meta.startMondayISO, now);
  if (!target) return result;

  const out = await stageWeeklyBoxEmails(db, config, emailAdapter, {
    seasonId,
    weekNumber: target.weekNumber,
    autoSend,
    mode,
    force: options?.force,
  });

  return {
    staged: out.staged,
    sent: out.sent,
    skipped: out.skipped,
  };
}

/** Exported for tests — reads enabled flag only. */
export { WEEKLY_BOX_EMAIL_SETTING_KEYS };
