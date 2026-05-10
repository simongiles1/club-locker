import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { players } from "../db/schema.js";

export type ClubLockerPlayer = {
  externalId: string;
  displayName: string;
  email?: string;
  rating: number;
};

export interface ClubLockerAdapter {
  pullPlayers(): Promise<ClubLockerPlayer[]>;
}

export class MockClubLockerAdapter implements ClubLockerAdapter {
  constructor(private readonly sample: ClubLockerPlayer[]) {}
  async pullPlayers(): Promise<ClubLockerPlayer[]> {
    return this.sample;
  }
}

/** Placeholder for HTTP API once endpoints are known (discovery). */
export class HttpClubLockerAdapter implements ClubLockerAdapter {
  async pullPlayers(): Promise<ClubLockerPlayer[]> {
    throw new Error("HttpClubLockerAdapter not configured — complete discovery spike");
  }
}

/** Phase 2: Playwright-based read/write (stub). */
export class PlaywrightClubLockerAdapter implements ClubLockerAdapter {
  async pullPlayers(): Promise<ClubLockerPlayer[]> {
    throw new Error("PlaywrightClubLockerAdapter requires credentials and flow capture");
  }
}

export function createClubLockerAdapter(
  kind: "mock" | "http" | "playwright",
  _db: Db,
  mockSample: ClubLockerPlayer[] = [],
): ClubLockerAdapter {
  if (kind === "http") return new HttpClubLockerAdapter();
  if (kind === "playwright") return new PlaywrightClubLockerAdapter();
  return new MockClubLockerAdapter(mockSample);
}

export function upsertPlayersFromLocker(db: Db, rows: ClubLockerPlayer[]): number {
  let n = 0;
  for (const r of rows) {
    const existing = db
      .select()
      .from(players)
      .where(eq(players.externalId, r.externalId))
      .get();
    if (existing) {
      db.update(players)
        .set({
          displayName: r.displayName,
          email: r.email ?? existing.email,
          rating: String(r.rating),
        })
        .where(eq(players.id, existing.id))
        .run();
    } else {
      const id = crypto.randomUUID();
      db.insert(players)
        .values({
          id,
          externalId: r.externalId,
          displayName: r.displayName,
          email: r.email,
          rating: String(r.rating),
        })
        .run();
    }
    n++;
  }
  return n;
}
