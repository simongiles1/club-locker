import { and, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { emailOutbox, inboundActions, inboundEmails } from "../db/schema.js";

export type EmailListingArea = "house_league" | "championships";

const HL_OUTBOX_KINDS = [
  "house_league_match_reminder",
  "house_league_reminder_test",
  "weekly_box",
  "houseleague_roster_accounting",
] as const;

function houseLeagueOutboxWhere(seasonId?: string) {
  const kindMatch = or(
    inArray(emailOutbox.kind, [...HL_OUTBOX_KINDS]),
    like(emailOutbox.kind, "house_league%"),
    like(emailOutbox.kind, "houseleague%"),
  );
  if (!seasonId) return kindMatch;
  return and(
    kindMatch,
    or(isNull(emailOutbox.seasonId), eq(emailOutbox.seasonId, seasonId)),
  );
}

function championshipsOutboxWhere(seasonId?: string) {
  const kindMatch = like(emailOutbox.kind, "championship%");
  if (!seasonId) return kindMatch;
  return and(
    kindMatch,
    or(isNull(emailOutbox.seasonId), eq(emailOutbox.seasonId, seasonId)),
  );
}

export function listOutboundForArea(
  db: Db,
  area: EmailListingArea,
  opts: { seasonId?: string; limit: number },
) {
  const where =
    area === "house_league"
      ? houseLeagueOutboxWhere(opts.seasonId)
      : championshipsOutboxWhere(opts.seasonId);
  return db
    .select()
    .from(emailOutbox)
    .where(where)
    .orderBy(desc(emailOutbox.createdAt))
    .limit(opts.limit)
    .all();
}

export function listInboundForArea(
  db: Db,
  area: EmailListingArea,
  opts: { limit: number },
) {
  const scopeWhere =
    area === "house_league"
      ? or(
          eq(inboundEmails.mailboxScope, "house_league"),
          isNull(inboundEmails.mailboxScope),
        )
      : eq(inboundEmails.mailboxScope, "championships");

  const emails = db
    .select()
    .from(inboundEmails)
    .where(scopeWhere)
    .orderBy(desc(inboundEmails.receivedAt))
    .limit(opts.limit)
    .all();

  return emails.map((email) => {
    const action = db
      .select()
      .from(inboundActions)
      .where(eq(inboundActions.emailId, email.id))
      .all()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    return { email, action: action ?? null };
  });
}
