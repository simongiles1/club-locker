import { eq } from "drizzle-orm";
import {
  DEFAULT_BOX_EML_BODY_TEMPLATE,
  DEFAULT_BOX_EML_SUBJECT_TEMPLATE,
  DEFAULT_BOX_MODIFICATION_EML_BODY_TEMPLATE,
  DEFAULT_BOX_MODIFICATION_EML_SUBJECT_TEMPLATE,
  upgradeBoxModificationEmlBodyTemplate,
  upgradeLegacyBoxEmlBodyTemplate,
  type BoxEmlTemplatePurpose,
} from "@squash/shared";
import { getSetting, setSetting } from "../automation/settings.js";
import { externalizeEmlTemplateAssets } from "./boxEmlAssets.js";
import type { Db } from "../db/client.js";
import { appSettings } from "../db/schema.js";

export type { BoxEmlTemplatePurpose };

export type BoxEmlTemplatePair = {
  bodyTemplate: string;
  subjectTemplate: string;
};

export const BOX_EML_TEMPLATE_KEYS_SEASON_START = {
  managedBodyTemplate: "house_league.box_eml_body_template",
  managedSubjectTemplate: "house_league.box_eml_subject_template",
  unmanagedBodyTemplate: "house_league.box_eml_body_template_unmanaged",
  unmanagedSubjectTemplate: "house_league.box_eml_subject_template_unmanaged",
} as const;

export const BOX_EML_TEMPLATE_KEYS_MODIFICATION = {
  managedBodyTemplate: "house_league.box_eml_mod_body_template",
  managedSubjectTemplate: "house_league.box_eml_mod_subject_template",
  unmanagedBodyTemplate: "house_league.box_eml_mod_body_template_unmanaged",
  unmanagedSubjectTemplate: "house_league.box_eml_mod_subject_template_unmanaged",
} as const;

/** @deprecated Use BOX_EML_TEMPLATE_KEYS_SEASON_START */
export const BOX_EML_TEMPLATE_KEYS = BOX_EML_TEMPLATE_KEYS_SEASON_START;

export type HouseLeagueBoxEmlTemplateSettings = {
  managed: BoxEmlTemplatePair;
  unmanaged: BoxEmlTemplatePair;
};

export type PartialHouseLeagueBoxEmlTemplateSettings = {
  managed?: Partial<BoxEmlTemplatePair>;
  unmanaged?: Partial<BoxEmlTemplatePair>;
};

function keysForPurpose(purpose: BoxEmlTemplatePurpose) {
  return purpose === "box_modification"
    ? BOX_EML_TEMPLATE_KEYS_MODIFICATION
    : BOX_EML_TEMPLATE_KEYS_SEASON_START;
}

function defaultsForPurpose(purpose: BoxEmlTemplatePurpose): {
  body: string;
  subject: string;
} {
  return purpose === "box_modification"
    ? {
        body: DEFAULT_BOX_MODIFICATION_EML_BODY_TEMPLATE,
        subject: DEFAULT_BOX_MODIFICATION_EML_SUBJECT_TEMPLATE,
      }
    : {
        body: DEFAULT_BOX_EML_BODY_TEMPLATE,
        subject: DEFAULT_BOX_EML_SUBJECT_TEMPLATE,
      };
}

function readBodyTemplate(
  db: Db,
  key: string,
  fallback: string,
  purpose: BoxEmlTemplatePurpose,
): string {
  let bodyTemplate = getSetting(db, key, fallback);
  const upgraded =
    (purpose === "season_start"
      ? upgradeLegacyBoxEmlBodyTemplate(bodyTemplate)
      : null) ??
    (purpose === "box_modification"
      ? upgradeBoxModificationEmlBodyTemplate(bodyTemplate)
      : null);
  if (upgraded) {
    setSetting(db, key, upgraded);
    bodyTemplate = upgraded;
  }
  return bodyTemplate;
}

function ensureUnmanagedTemplatesSeeded(
  db: Db,
  purpose: BoxEmlTemplatePurpose,
): void {
  const keys = keysForPurpose(purpose);
  const defaults = defaultsForPurpose(purpose);
  const managedBody = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, keys.managedBodyTemplate))
    .get();
  const unmanagedBody = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, keys.unmanagedBodyTemplate))
    .get();
  if (unmanagedBody) return;

  const now = new Date().toISOString();
  const bodyFallback =
    managedBody?.value?.trim() || defaults.body;
  const managedSubject = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, keys.managedSubjectTemplate))
    .get();
  const subjectFallback =
    managedSubject?.value?.trim() || defaults.subject;

  db.insert(appSettings)
    .values({
      key: keys.unmanagedBodyTemplate,
      value: bodyFallback,
      updatedAt: now,
    })
    .run();
  db.insert(appSettings)
    .values({
      key: keys.unmanagedSubjectTemplate,
      value: subjectFallback,
      updatedAt: now,
    })
    .run();
}

export function seedHouseLeagueBoxEmlTemplateSettings(
  db: Db,
  purpose: BoxEmlTemplatePurpose = "season_start",
): void {
  const keys = keysForPurpose(purpose);
  const defaults = defaultsForPurpose(purpose);
  const now = new Date().toISOString();
  const seedPairs: [string, string][] = [
    [keys.managedBodyTemplate, defaults.body],
    [keys.managedSubjectTemplate, defaults.subject],
  ];
  for (const [key, value] of seedPairs) {
    const existing = db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .get();
    if (existing) continue;
    db.insert(appSettings).values({ key, value, updatedAt: now }).run();
  }
  ensureUnmanagedTemplatesSeeded(db, purpose);
}

export function seedAllHouseLeagueBoxEmlTemplateSettings(db: Db): void {
  seedHouseLeagueBoxEmlTemplateSettings(db, "season_start");
  seedHouseLeagueBoxEmlTemplateSettings(db, "box_modification");
}

export function getHouseLeagueBoxEmlTemplateSettings(
  db: Db,
  purpose: BoxEmlTemplatePurpose = "season_start",
): HouseLeagueBoxEmlTemplateSettings {
  const keys = keysForPurpose(purpose);
  const defaults = defaultsForPurpose(purpose);
  seedHouseLeagueBoxEmlTemplateSettings(db, purpose);
  return {
    managed: {
      bodyTemplate: readBodyTemplate(
        db,
        keys.managedBodyTemplate,
        defaults.body,
        purpose,
      ),
      subjectTemplate: getSetting(
        db,
        keys.managedSubjectTemplate,
        defaults.subject,
      ),
    },
    unmanaged: {
      bodyTemplate: readBodyTemplate(
        db,
        keys.unmanagedBodyTemplate,
        defaults.body,
        purpose,
      ),
      subjectTemplate: getSetting(
        db,
        keys.unmanagedSubjectTemplate,
        defaults.subject,
      ),
    },
  };
}

export function templatePairForManagedBox(
  settings: HouseLeagueBoxEmlTemplateSettings,
  managed: boolean,
): BoxEmlTemplatePair {
  return managed ? settings.managed : settings.unmanaged;
}

export function patchHouseLeagueBoxEmlTemplateSettings(
  db: Db,
  patch: {
    managed?: Partial<BoxEmlTemplatePair>;
    unmanaged?: Partial<BoxEmlTemplatePair>;
  },
  purpose: BoxEmlTemplatePurpose = "season_start",
): HouseLeagueBoxEmlTemplateSettings {
  const keys = keysForPurpose(purpose);
  const cur = getHouseLeagueBoxEmlTemplateSettings(db, purpose);
  for (const variant of ["managed", "unmanaged"] as const) {
    const part = patch[variant];
    if (!part) continue;
    const variantKeys =
      variant === "managed"
        ? {
            body: keys.managedBodyTemplate,
            subject: keys.managedSubjectTemplate,
          }
        : {
            body: keys.unmanagedBodyTemplate,
            subject: keys.unmanagedSubjectTemplate,
          };
    if (part.bodyTemplate !== undefined) {
      const body = externalizeEmlTemplateAssets(
        db,
        part.bodyTemplate.trim(),
      );
      if (!body) throw new Error("body_template_required");
      setSetting(db, variantKeys.body, body);
    }
    if (part.subjectTemplate !== undefined) {
      const subject = part.subjectTemplate.trim();
      if (!subject) throw new Error("subject_template_required");
      setSetting(db, variantKeys.subject, subject);
    }
  }
  return getHouseLeagueBoxEmlTemplateSettings(db, purpose);
}
