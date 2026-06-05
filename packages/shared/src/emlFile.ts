/** Outlook-importable unsent draft (.eml) with HTML body. */
export function buildOutlookEmlFile(params: {
  fromName: string;
  fromEmail: string;
  toAddresses: readonly string[];
  subject: string;
  htmlBody: string;
}): string {
  const date = new Date().toUTCString();
  const to = [...params.toAddresses].filter(Boolean).join(", ");
  const from =
    params.fromName.trim() !== ""
      ? `${params.fromName.trim()} <${params.fromEmail.trim()}>`
      : params.fromEmail.trim();

  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${params.subject}`,
    `Date: ${date}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "X-Unsent: 1",
    "",
    params.htmlBody,
  ];
  return lines.join("\r\n");
}

export function mergeUniqueEmailAddresses(
  ...groups: readonly (readonly string[])[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const raw of group) {
      const em = raw?.trim();
      if (!em) continue;
      const key = em.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(em);
    }
  }
  return out;
}

export function weeklyBoxEmlFilename(boxNumber: number, weekNumber: number): string {
  return `box-${String(boxNumber).padStart(2, "0")}-week-${weekNumber}.eml`;
}

export function weeklyMatchupEmlFilename(
  boxNumber: number,
  weekNumber: number,
  matchIndex: number,
): string {
  return `box-${String(boxNumber).padStart(2, "0")}-week-${weekNumber}-match-${matchIndex}.eml`;
}

export type WeeklyEmailRecipientMode = "per_box" | "per_matchup";

export function isWeeklyEmailRecipientMode(raw: string): raw is WeeklyEmailRecipientMode {
  return raw === "per_box" || raw === "per_matchup";
}

/** Dedupe row for one email to an entire box. */
export const WEEKLY_EMAIL_PER_BOX_MATCH_INDEX = 0;
