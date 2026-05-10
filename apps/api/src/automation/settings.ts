import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appSettings } from "../db/schema.js";

export const AUTOMATION_DEFAULTS = {
  "automation.test_mode": "off",
  "automation.auto_send_test": "off",
  "automation.auto_send_prod": "off",
  "automation.auto_apply_confidence_min": "medium",
  "automation.imap_paused": "off",
  "automation.scheduler_paused": "off",
  "clock.virtual_now_iso": new Date().toISOString(),
} as const;

export type AutomationSettingKey = keyof typeof AUTOMATION_DEFAULTS;

export function seedAutomationSettings(db: Db): void {
  for (const [key, value] of Object.entries(AUTOMATION_DEFAULTS)) {
    const existing = db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .get();
    if (existing) continue;
    db.insert(appSettings)
      .values({
        key,
        value,
        updatedAt: new Date().toISOString(),
      })
      .run();
  }
}

export function getSetting(db: Db, key: string, fallback = ""): string {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  return row?.value ?? fallback;
}

export function setSetting(db: Db, key: string, value: string): void {
  const now = new Date().toISOString();
  const existing = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  if (existing) {
    db.update(appSettings)
      .set({ value, updatedAt: now })
      .where(eq(appSettings.key, key))
      .run();
    return;
  }
  db.insert(appSettings).values({ key, value, updatedAt: now }).run();
}

export function isSettingOn(db: Db, key: string): boolean {
  return getSetting(db, key, "off") === "on";
}

export type ConfidenceLevel = "low" | "medium" | "high";

const confidenceOrder: Record<ConfidenceLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export function confidenceAllowsAutoApply(
  db: Db,
  confidence: ConfidenceLevel,
): boolean {
  const threshold = getSetting(
    db,
    "automation.auto_apply_confidence_min",
    "medium",
  ) as ConfidenceLevel;
  return confidenceOrder[confidence] >= confidenceOrder[threshold];
}

export function isTestMode(db: Db): boolean {
  return isSettingOn(db, "automation.test_mode");
}

export function shouldAutoSendForCurrentMode(db: Db): boolean {
  return isTestMode(db)
    ? isSettingOn(db, "automation.auto_send_test")
    : isSettingOn(db, "automation.auto_send_prod");
}
