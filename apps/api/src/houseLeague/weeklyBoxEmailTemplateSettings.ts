import { eq } from "drizzle-orm";
import {
  DEFAULT_WEEKLY_BOX_MANAGED_BODY_TEMPLATE,
  DEFAULT_WEEKLY_BOX_SUBJECT_TEMPLATE,
  DEFAULT_WEEKLY_BOX_UNMANAGED_BODY_TEMPLATE,
  DEFAULT_WEEKLY_MATCHUP_MANAGED_BODY_TEMPLATE,
  DEFAULT_WEEKLY_MATCHUP_SUBJECT_TEMPLATE,
  DEFAULT_WEEKLY_MATCHUP_UNMANAGED_BODY_TEMPLATE,
  isWeeklyEmailRecipientMode,
  type WeeklyEmailRecipientMode,
} from "@squash/shared";
import { getSetting, setSetting } from "../automation/settings.js";
import { externalizeEmlTemplateAssets } from "./boxEmlAssets.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { appSettings } from "../db/schema.js";
import type { BoxEmlTemplatePair } from "./boxEmlTemplateSettings.js";

export const WEEKLY_BOX_EMAIL_TEMPLATE_KEYS = {
  managedBodyTemplate: "house_league.weekly_box_body_template",
  managedSubjectTemplate: "house_league.weekly_box_subject_template",
  unmanagedBodyTemplate: "house_league.weekly_box_body_template_unmanaged",
  unmanagedSubjectTemplate: "house_league.weekly_box_subject_template_unmanaged",
  matchupManagedBodyTemplate: "house_league.weekly_matchup_body_template",
  matchupManagedSubjectTemplate: "house_league.weekly_matchup_subject_template",
  matchupUnmanagedBodyTemplate: "house_league.weekly_matchup_body_template_unmanaged",
  matchupUnmanagedSubjectTemplate: "house_league.weekly_matchup_subject_template_unmanaged",
} as const;

export const WEEKLY_BOX_EMAIL_SETTING_KEYS = {
  enabled: "house_league.weekly_box_email_enabled",
  seasonId: "house_league.weekly_box_email_season_id",
  recipientMode: "house_league.weekly_box_recipient_mode",
  fromEmail: "house_league.weekly_box_from_email",
  fromName: "house_league.weekly_box_from_name",
  alternateFromEmailsJson: "house_league.weekly_box_alternate_from_emails_json",
  /** @deprecated Migrated to alternateFromEmailsJson on read */
  legacyExtraToEmailsJson: "house_league.weekly_box_extra_to_emails_json",
} as const;

export type HouseLeagueWeeklyEmailTemplateSettings = {
  perBox: {
    managed: BoxEmlTemplatePair;
    unmanaged: BoxEmlTemplatePair;
  };
  perMatchup: {
    managed: BoxEmlTemplatePair;
    unmanaged: BoxEmlTemplatePair;
  };
};

/** @deprecated Use HouseLeagueWeeklyEmailTemplateSettings */
export type HouseLeagueWeeklyBoxEmailTemplateSettings = HouseLeagueWeeklyEmailTemplateSettings;

export type HouseLeagueWeeklyBoxEmailSettingsPayload = {
  enabled: boolean;
  seasonId: string | null;
  recipientMode: WeeklyEmailRecipientMode;
  fromEmail: string;
  fromName: string;
  alternateFromEmails: string[];
  templates: HouseLeagueWeeklyEmailTemplateSettings;
};

function parseEmailListJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function loadAlternateFromEmails(db: Db): string[] {
  const newRaw = getSetting(
    db,
    WEEKLY_BOX_EMAIL_SETTING_KEYS.alternateFromEmailsJson,
    "",
  ).trim();
  if (newRaw !== "" && newRaw !== "[]") {
    return parseEmailListJson(newRaw);
  }
  const legacy = parseEmailListJson(
    getSetting(db, WEEKLY_BOX_EMAIL_SETTING_KEYS.legacyExtraToEmailsJson, "[]"),
  );
  if (legacy.length > 0) {
    setSetting(
      db,
      WEEKLY_BOX_EMAIL_SETTING_KEYS.alternateFromEmailsJson,
      JSON.stringify(legacy),
    );
  }
  return legacy;
}

function defaultFromEmail(config: AppConfig): string {
  return config.GMAIL_USER?.trim() || "";
}

function defaultFromName(config: AppConfig): string {
  return config.GMAIL_FROM_NAME?.trim() || "Martin";
}

function ensureTemplatePairSeeded(
  db: Db,
  bodyKey: string,
  subjectKey: string,
  bodyDefault: string,
  subjectDefault: string,
): void {
  const bodyRow = db.select().from(appSettings).where(eq(appSettings.key, bodyKey)).get();
  if (bodyRow) return;
  const now = new Date().toISOString();
  db.insert(appSettings)
    .values({ key: bodyKey, value: bodyDefault, updatedAt: now })
    .run();
  db.insert(appSettings)
    .values({ key: subjectKey, value: subjectDefault, updatedAt: now })
    .run();
}

export function seedHouseLeagueWeeklyBoxEmailSettings(db: Db): void {
  const now = new Date().toISOString();
  const flagDefaults: [string, string][] = [
    [WEEKLY_BOX_EMAIL_SETTING_KEYS.enabled, "off"],
    [WEEKLY_BOX_EMAIL_SETTING_KEYS.seasonId, ""],
    [WEEKLY_BOX_EMAIL_SETTING_KEYS.recipientMode, "per_box"],
  ];
  for (const [key, value] of flagDefaults) {
    const existing = db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .get();
    if (existing) continue;
    db.insert(appSettings).values({ key, value, updatedAt: now }).run();
  }
  ensureTemplatePairSeeded(
    db,
    WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.managedBodyTemplate,
    WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.managedSubjectTemplate,
    DEFAULT_WEEKLY_BOX_MANAGED_BODY_TEMPLATE,
    DEFAULT_WEEKLY_BOX_SUBJECT_TEMPLATE,
  );
  ensureTemplatePairSeeded(
    db,
    WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.unmanagedBodyTemplate,
    WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.unmanagedSubjectTemplate,
    DEFAULT_WEEKLY_BOX_UNMANAGED_BODY_TEMPLATE,
    DEFAULT_WEEKLY_BOX_SUBJECT_TEMPLATE,
  );
  ensureTemplatePairSeeded(
    db,
    WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.matchupManagedBodyTemplate,
    WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.matchupManagedSubjectTemplate,
    DEFAULT_WEEKLY_MATCHUP_MANAGED_BODY_TEMPLATE,
    DEFAULT_WEEKLY_MATCHUP_SUBJECT_TEMPLATE,
  );
  ensureTemplatePairSeeded(
    db,
    WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.matchupUnmanagedBodyTemplate,
    WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.matchupUnmanagedSubjectTemplate,
    DEFAULT_WEEKLY_MATCHUP_UNMANAGED_BODY_TEMPLATE,
    DEFAULT_WEEKLY_MATCHUP_SUBJECT_TEMPLATE,
  );
}

function readTemplatePair(db: Db, bodyKey: string, subjectKey: string, bodyFallback: string, subjectFallback: string): BoxEmlTemplatePair {
  let bodyTemplate = getSetting(db, bodyKey, bodyFallback);
  if (
    bodyKey === WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.matchupManagedBodyTemplate &&
    bodyTemplate.includes("{{weekPlayDateLabel}}")
  ) {
    bodyTemplate = bodyTemplate.replace(
      /<p style="[^"]*">\{\{weekPlayDateLabel\}\}<\/p>\s*/g,
      "",
    );
    setSetting(db, bodyKey, bodyTemplate);
  }
  return {
    bodyTemplate,
    subjectTemplate: getSetting(db, subjectKey, subjectFallback),
  };
}

export function getHouseLeagueWeeklyEmailTemplateSettings(
  db: Db,
): HouseLeagueWeeklyEmailTemplateSettings {
  seedHouseLeagueWeeklyBoxEmailSettings(db);
  return {
    perBox: {
      managed: readTemplatePair(
        db,
        WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.managedBodyTemplate,
        WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.managedSubjectTemplate,
        DEFAULT_WEEKLY_BOX_MANAGED_BODY_TEMPLATE,
        DEFAULT_WEEKLY_BOX_SUBJECT_TEMPLATE,
      ),
      unmanaged: readTemplatePair(
        db,
        WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.unmanagedBodyTemplate,
        WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.unmanagedSubjectTemplate,
        DEFAULT_WEEKLY_BOX_UNMANAGED_BODY_TEMPLATE,
        DEFAULT_WEEKLY_BOX_SUBJECT_TEMPLATE,
      ),
    },
    perMatchup: {
      managed: readTemplatePair(
        db,
        WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.matchupManagedBodyTemplate,
        WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.matchupManagedSubjectTemplate,
        DEFAULT_WEEKLY_MATCHUP_MANAGED_BODY_TEMPLATE,
        DEFAULT_WEEKLY_MATCHUP_SUBJECT_TEMPLATE,
      ),
      unmanaged: readTemplatePair(
        db,
        WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.matchupUnmanagedBodyTemplate,
        WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.matchupUnmanagedSubjectTemplate,
        DEFAULT_WEEKLY_MATCHUP_UNMANAGED_BODY_TEMPLATE,
        DEFAULT_WEEKLY_MATCHUP_SUBJECT_TEMPLATE,
      ),
    },
  };
}

/** @deprecated */
export const getHouseLeagueWeeklyBoxEmailTemplateSettings = getHouseLeagueWeeklyEmailTemplateSettings;

export function getHouseLeagueWeeklyBoxEmailSettings(
  db: Db,
  config: AppConfig,
): HouseLeagueWeeklyBoxEmailSettingsPayload {
  seedHouseLeagueWeeklyBoxEmailSettings(db);
  const enabled =
    getSetting(db, WEEKLY_BOX_EMAIL_SETTING_KEYS.enabled, "off") === "on";
  const sid = getSetting(db, WEEKLY_BOX_EMAIL_SETTING_KEYS.seasonId, "").trim();
  const modeRaw = getSetting(db, WEEKLY_BOX_EMAIL_SETTING_KEYS.recipientMode, "per_box");
  const recipientMode: WeeklyEmailRecipientMode = isWeeklyEmailRecipientMode(modeRaw)
    ? modeRaw
    : "per_box";
  const fromEmail =
    getSetting(db, WEEKLY_BOX_EMAIL_SETTING_KEYS.fromEmail, "").trim() ||
    defaultFromEmail(config);
  const fromName =
    getSetting(db, WEEKLY_BOX_EMAIL_SETTING_KEYS.fromName, "").trim() ||
    defaultFromName(config);
  const alternateFromEmails = loadAlternateFromEmails(db);
  return {
    enabled,
    seasonId: sid === "" ? null : sid,
    recipientMode,
    fromEmail,
    fromName,
    alternateFromEmails,
    templates: getHouseLeagueWeeklyEmailTemplateSettings(db),
  };
}

export function weeklyTemplatePairForManagedBox(
  settings: HouseLeagueWeeklyEmailTemplateSettings,
  mode: WeeklyEmailRecipientMode,
  managed: boolean,
): BoxEmlTemplatePair {
  const group = mode === "per_matchup" ? settings.perMatchup : settings.perBox;
  return managed ? group.managed : group.unmanaged;
}

export function patchHouseLeagueWeeklyBoxEmailSettings(
  db: Db,
  config: AppConfig,
  patch: {
    enabled?: boolean;
    seasonId?: string | null;
    recipientMode?: WeeklyEmailRecipientMode;
    fromEmail?: string;
    fromName?: string;
    alternateFromEmails?: string[];
    /** @deprecated Use alternateFromEmails */
    extraToEmails?: string[];
    templates?: {
      perBox?: {
        managed?: Partial<BoxEmlTemplatePair>;
        unmanaged?: Partial<BoxEmlTemplatePair>;
      };
      perMatchup?: {
        managed?: Partial<BoxEmlTemplatePair>;
        unmanaged?: Partial<BoxEmlTemplatePair>;
      };
      /** Legacy: maps to perBox */
      managed?: Partial<BoxEmlTemplatePair>;
      unmanaged?: Partial<BoxEmlTemplatePair>;
    };
  },
): HouseLeagueWeeklyBoxEmailSettingsPayload {
  if (patch.enabled !== undefined) {
    setSetting(
      db,
      WEEKLY_BOX_EMAIL_SETTING_KEYS.enabled,
      patch.enabled ? "on" : "off",
    );
  }
  if (patch.seasonId !== undefined) {
    const sid = patch.seasonId?.trim() ?? "";
    setSetting(db, WEEKLY_BOX_EMAIL_SETTING_KEYS.seasonId, sid);
  }
  if (patch.recipientMode !== undefined) {
    setSetting(db, WEEKLY_BOX_EMAIL_SETTING_KEYS.recipientMode, patch.recipientMode);
  }
  if (patch.fromEmail !== undefined) {
    setSetting(db, WEEKLY_BOX_EMAIL_SETTING_KEYS.fromEmail, patch.fromEmail.trim());
  }
  if (patch.fromName !== undefined) {
    setSetting(db, WEEKLY_BOX_EMAIL_SETTING_KEYS.fromName, patch.fromName.trim());
  }
  const alternatePatch =
    patch.alternateFromEmails ?? patch.extraToEmails;
  if (alternatePatch !== undefined) {
    const cleaned = alternatePatch.map((x) => x.trim()).filter(Boolean);
    setSetting(
      db,
      WEEKLY_BOX_EMAIL_SETTING_KEYS.alternateFromEmailsJson,
      JSON.stringify(cleaned),
    );
  }
  if (patch.templates) {
    const legacyPerBox =
      patch.templates.perBox ??
      (patch.templates.managed || patch.templates.unmanaged
        ? {
            managed: patch.templates.managed,
            unmanaged: patch.templates.unmanaged,
          }
        : undefined);
    const applyPair = (
      scope: "perBox" | "perMatchup",
      variant: "managed" | "unmanaged",
      part: Partial<BoxEmlTemplatePair> | undefined,
    ) => {
      if (!part) return;
      const keys =
        scope === "perBox"
          ? variant === "managed"
            ? {
                body: WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.managedBodyTemplate,
                subject: WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.managedSubjectTemplate,
              }
            : {
                body: WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.unmanagedBodyTemplate,
                subject: WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.unmanagedSubjectTemplate,
              }
          : variant === "managed"
            ? {
                body: WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.matchupManagedBodyTemplate,
                subject: WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.matchupManagedSubjectTemplate,
              }
            : {
                body: WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.matchupUnmanagedBodyTemplate,
                subject: WEEKLY_BOX_EMAIL_TEMPLATE_KEYS.matchupUnmanagedSubjectTemplate,
              };
      if (part.bodyTemplate !== undefined) {
        const body = externalizeEmlTemplateAssets(db, part.bodyTemplate.trim());
        if (!body) throw new Error("body_template_required");
        setSetting(db, keys.body, body);
      }
      if (part.subjectTemplate !== undefined) {
        const subject = part.subjectTemplate.trim();
        if (!subject) throw new Error("subject_template_required");
        setSetting(db, keys.subject, subject);
      }
    };
    if (legacyPerBox) {
      applyPair("perBox", "managed", legacyPerBox.managed);
      applyPair("perBox", "unmanaged", legacyPerBox.unmanaged);
    }
    if (patch.templates.perMatchup) {
      applyPair("perMatchup", "managed", patch.templates.perMatchup.managed);
      applyPair("perMatchup", "unmanaged", patch.templates.perMatchup.unmanaged);
    }
  }
  return getHouseLeagueWeeklyBoxEmailSettings(db, config);
}
