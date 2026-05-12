const PLACEHOLDER_RE =
  /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/** Where a saved director template applies (API + UI filter lists per area). */
export const EMAIL_TEMPLATE_SCOPES = ["championships", "house_league"] as const;
export type EmailTemplateScope = (typeof EMAIL_TEMPLATE_SCOPES)[number];

/**
 * Normalize paste-from-Word quirks so `{{key}}` matches the interpolation regex:
 * strips zero‑width chars, maps common fullwidth braces to ASCII.
 */
export function normalizeEmailTemplateText(template: string): string {
  return template
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\uFF5B/g, "{") // fullwidth LEFT CURLY BRACKET `｛`
    .replace(/\uFF5D/g, "}"); // fullwidth RIGHT CURLY BRACKET `｝`
}

/**
 * Replace `{{key}}` segments in template with matching values from `vars`.
 * Unknown keys are left unchanged so drafts stay readable until values exist.
 */
export function interpolateEmailTemplate(
  template: string,
  vars: Record<string, string | undefined | null>,
): string {
  const text = normalizeEmailTemplateText(template);
  return text.replace(
    PLACEHOLDER_RE,
    (full: string, key: string) => {
      const v = vars[key];
      if (v !== undefined && v !== null && v !== "") return v;
      return full;
    },
  );
}

/** Suggested placeholders for authoring templates (shown in director UI help). */
export const EMAIL_TEMPLATE_VARIABLE_DESCRIPTIONS: {
  key: string;
  description: string;
}[] = [
  {
    key: "playerName",
    description:
      "The roster player receiving this email (filled per recipient on send).",
  },
  {
    key: "playerName2",
    description:
      "Next participant in your selected recipient list excluding the current recipient (for opponents/teammates).",
  },
  {
    key: "playerName3",
    description:
      "Third participant in the same ordering (often doubles lineups).",
  },
  {
    key: "playerName4",
    description:
      "Fourth participant in the same ordering when four people apply.",
  },
  {
    key: "date",
    description: "Today’s calendar date (YYYY-MM-DD in the server timezone).",
  },
  {
    key: "championshipName",
    description:
      "Championship title when using the Championships page test dialog.",
  },
  {
    key: "matchupBracket",
    description:
      "Abbreviated entrants (e.g. J. Doe vs Q. Roe) when opened from the bracket.",
  },
  {
    key: "matchupFull",
    description:
      "Full entrants line when opened from the bracket mail icon.",
  },
  {
    key: "matchDueDate",
    description:
      "This match’s due date (YYYY-MM-DD) when set on the bracket, else empty.",
  },
  {
    key: "matchRound",
    description:
      "Bracket round label (e.g. round of 16, semis, final) when sending from a championship match.",
  },
  {
    key: "matchDate",
    description:
      "House league booked match calendar date (YYYY-MM-DD), filled from the conversion snapshot.",
  },
  {
    key: "matchSlot",
    description:
      "Courts/time window string for that booking (same as Club Locker slot).",
  },
  {
    key: "matchTimeSlot",
    description: "Alias of matchSlot for readability in templates.",
  },
  {
    key: "opponentName",
    description:
      "The other roster player’s display name on this court booking.",
  },
  {
    key: "boxNumber",
    description: "League box number for this matchup.",
  },
  {
    key: "weekNumber",
    description: "House league season week number for this matchup.",
  },
  {
    key: "courtLabel",
    description: "Court 1 / Court 2 (or stadium label) resolved from booking config.",
  },
];
