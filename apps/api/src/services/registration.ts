import { eq, like, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { players, registrationQueue } from "../db/schema.js";

export function matchPlayerByEmailOrName(
  db: Db,
  email: string,
  nameGuess: string | null,
): { playerId: string; confidence: "high" | "medium" | "low" } | null {
  const normEmail = email.trim().toLowerCase();
  const byEmail = db
    .select()
    .from(players)
    .where(sql`lower(${players.email}) = ${normEmail}`)
    .all();
  if (byEmail.length === 1) {
    return { playerId: byEmail[0].id, confidence: "high" };
  }
  if (nameGuess) {
    const safe = nameGuess.replaceAll("%", "").trim();
    if (!safe) return null;
    const pattern = `%${safe}%`;
    const byName = db
      .select()
      .from(players)
      .where(like(players.displayName, pattern))
      .all();
    if (byName.length === 1) {
      return { playerId: byName[0].id, confidence: "medium" };
    }
    if (byName.length === 0) return null;
  }
  return null;
}

export function processRegistrationQueueItem(db: Db, id: string) {
  const row = db.select().from(registrationQueue).where(eq(registrationQueue.id, id)).get();
  if (!row) return { ok: false as const, error: "not_found" };
  const match = matchPlayerByEmailOrName(db, row.fromEmail, row.parsedName);
  if (!match) {
    db.update(registrationQueue)
      .set({ status: "needs_review" })
      .where(eq(registrationQueue.id, id))
      .run();
    return { ok: true as const, status: "needs_review" as const };
  }
  db.update(registrationQueue)
    .set({
      status: "matched",
      matchedPlayerId: match.playerId,
    })
    .where(eq(registrationQueue.id, id))
    .run();
  return { ok: true as const, status: "matched" as const, match };
}
