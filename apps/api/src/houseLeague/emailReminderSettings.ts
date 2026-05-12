import { eq } from "drizzle-orm";
import { getSetting, setSetting } from "../automation/settings.js";
import type { Db } from "../db/client.js";
import { appSettings, emailTemplates } from "../db/schema.js";
import { clampInt } from "./reminderDates.js";

export const HL_REMINDER_KEYS = {
  enabled: "house_league.match_reminder_enabled",
  daysBefore: "house_league.match_reminder_days_before",
  templateId: "house_league.match_reminder_template_id",
} as const;

export function seedHouseLeagueEmailReminderSettings(db: Db): void {
  const defaults: [string, string][] = [
    [HL_REMINDER_KEYS.enabled, "off"],
    [HL_REMINDER_KEYS.daysBefore, "3"],
    [HL_REMINDER_KEYS.templateId, ""],
  ];
  const now = new Date().toISOString();
  for (const [key, value] of defaults) {
    const existing = db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .get();
    if (existing) continue;
    db.insert(appSettings).values({ key, value, updatedAt: now }).run();
  }
}

export type HouseLeagueEmailReminderSettingsPayload = {
  enabled: boolean;
  daysBefore: number;
  templateId: string | null;
};

export function getHouseLeagueEmailReminderSettings(
  db: Db,
): HouseLeagueEmailReminderSettingsPayload {
  const enabled = getSetting(db, HL_REMINDER_KEYS.enabled, "off") === "on";
  const daysRaw = Number.parseInt(
    getSetting(db, HL_REMINDER_KEYS.daysBefore, "3"),
    10,
  );
  const daysBefore = clampInt(Number.isFinite(daysRaw) ? daysRaw : 3, 0, 14);
  const tid = getSetting(db, HL_REMINDER_KEYS.templateId, "").trim();
  return {
    enabled,
    daysBefore,
    templateId: tid === "" ? null : tid,
  };
}

export function patchHouseLeagueEmailReminderSettings(
  db: Db,
  patch: Partial<{
    enabled: boolean;
    daysBefore: number;
    templateId: string | null;
  }>,
): HouseLeagueEmailReminderSettingsPayload {
  const cur = getHouseLeagueEmailReminderSettings(db);

  let nextTemplate = cur.templateId;
  let nextDays = cur.daysBefore;
  let nextEnabled = cur.enabled;

  if (patch.enabled !== undefined) {
    nextEnabled = patch.enabled;
    setSetting(db, HL_REMINDER_KEYS.enabled, patch.enabled ? "on" : "off");
  }
  if (patch.daysBefore !== undefined) {
    nextDays = clampInt(patch.daysBefore, 0, 14);
    setSetting(db, HL_REMINDER_KEYS.daysBefore, String(nextDays));
  }
  if (patch.templateId !== undefined) {
    const t = patch.templateId?.trim();
    if (!t || t === "") {
      nextTemplate = null;
      setSetting(db, HL_REMINDER_KEYS.templateId, "");
    } else {
      const row = db.select().from(emailTemplates).where(eq(emailTemplates.id, t)).get();
      if (!row || row.scope !== "house_league") {
        throw new Error("invalid_template");
      }
      nextTemplate = t;
      setSetting(db, HL_REMINDER_KEYS.templateId, t);
    }
  }

  return {
    enabled: nextEnabled,
    daysBefore: nextDays,
    templateId: nextTemplate,
  };
}
