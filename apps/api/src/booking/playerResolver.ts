import type { InferSelectModel } from "drizzle-orm";
import type { players } from "../db/schema.js";

export type PlayerRow = InferSelectModel<typeof players>;

/**
 * Resolves the Club Locker (external) id for a player. Placeholder: extend with
 * US Squash member lookup when the lookup API is available.
 */
export function getClubLockerIdForPlayer(
  p: PlayerRow,
  _context?: { seasonId: string; week: number },
): { externalId: string; source: "db" } | { error: string } {
  if (!p.externalId || p.externalId.trim() === "") {
    return {
      error: `Player "${p.displayName}" (${p.id}) has no external_id — sync from Club Locker or set external_id.`,
    };
  }
  return { externalId: p.externalId, source: "db" };
}

/**
 * Parse Club Locker user id. Supports numeric strings; mock `ext-12` -> `100012`.
 */
export function clubLockerNumericId(
  p: PlayerRow,
  override?: string,
): number {
  const s = (override ?? p.externalId ?? "").trim();
  if (/^\d+$/.test(s)) {
    return Number(s);
  }
  const m = s.match(/^ext-(\d+)$/i);
  if (m) {
    return 100_000 + Number(m[1]);
  }
  return 0;
}

export function buildUssquashPlayerFromRow(
  p: PlayerRow,
  externalIdOverride?: string,
): {
  type: "member";
  confirmed: boolean;
  id: number;
  text: string;
  rating: number | null;
  name: string;
  adultJunior: "Adult";
  location: string;
  country: string;
  mainAffiliation: string;
  mainAffiliationId: number;
} {
  const id = clubLockerNumericId(p, externalIdOverride);
  const rating = Number.parseFloat(p.rating);
  return {
    type: "member",
    confirmed: false,
    id: id || 0,
    text: p.displayName,
    rating: Number.isNaN(rating) ? null : rating,
    name: `${p.displayName} (CL id ${id})`,
    adultJunior: "Adult",
    location: "—",
    country: "—",
    mainAffiliation: "—",
    mainAffiliationId: 0,
  };
}
