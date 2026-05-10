const PLACEHOLDER_RE =
  /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

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
];
