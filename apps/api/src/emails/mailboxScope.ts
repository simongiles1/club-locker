/**
 * Routes inbound mail between UI areas using Gmail-style +tags on the mailbox address.
 * Writes `inbound_emails.mailbox_scope` at ingest time — no classifier needed.
 */
export function mailboxScopeFromAliasTag(
  aliasTag: string | null | undefined,
): "house_league" | "championships" | null {
  if (aliasTag == null || aliasTag.trim() === "") return null;
  const t = aliasTag
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");

  const hlHints = new Set(["hl", "houseleague", "house_league", "boxleague", "box_league"]);
  if (hlHints.has(t)) return "house_league";

  const chHints = new Set([
    "champ",
    "champs",
    "championship",
    "championships",
    "bracket",
  ]);
  if (chHints.has(t)) return "championships";

  return null;
}
