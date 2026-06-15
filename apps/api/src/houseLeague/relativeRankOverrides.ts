import { eq } from "drizzle-orm";
import {
  applyAnchoredBoxSeatsToRoster,
  parseRelativeRankOverridesJson,
  pruneRelativeRankOverrides,
  sanitizeSeatOverridesForGroundTruth,
  serializeRelativeRankOverrides,
} from "@squash/shared";
import type { Db } from "../db/client.js";
import { seasons } from "../db/schema.js";
import type { LiveBoxLeaguePlayer } from "../booking/liveWeekPlan.js";
import type { BoxRelativeRankIdentifiedPlayer } from "@squash/shared";
import { loadSeasonStartGroundTruthPlayers } from "./seasonStartRoster.js";

export function loadRelativeRankOverridesForSeason(
  db: Db,
  seasonId: string,
): Map<number, number> {
  const row = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
  if (!row) return new Map();
  return parseRelativeRankOverridesJson(row.relativeRankOverridesJson);
}

export function saveRelativeRankOverridesForSeason(
  db: Db,
  seasonId: string,
  overrides: ReadonlyMap<number, number>,
): void {
  db.update(seasons)
    .set({
      relativeRankOverridesJson: JSON.stringify(
        serializeRelativeRankOverrides(overrides),
      ),
    })
    .where(eq(seasons.id, seasonId))
    .run();
}

export function applySeasonRelativeRankOverrides(
  roster: readonly LiveBoxLeaguePlayer[],
  groundTruth: readonly BoxRelativeRankIdentifiedPlayer[],
  overrides: ReadonlyMap<number, number>,
): LiveBoxLeaguePlayer[] {
  const pruned = pruneRelativeRankOverrides(overrides, roster);
  if (pruned.size === 0 && groundTruth.length === 0) return [...roster];
  return applyAnchoredBoxSeatsToRoster(
    roster,
    groundTruth.length > 0 ? groundTruth : undefined,
    pruned,
  );
}

export function loadAndApplyRelativeRankOverrides(
  db: Db,
  seasonId: string,
  roster: readonly LiveBoxLeaguePlayer[],
): LiveBoxLeaguePlayer[] {
  const raw = loadRelativeRankOverridesForSeason(db, seasonId);
  const groundTruth = loadSeasonStartGroundTruthPlayers(db, seasonId);
  let pruned = pruneRelativeRankOverrides(raw, roster);
  pruned = sanitizeSeatOverridesForGroundTruth(roster, groundTruth, pruned);
  if (pruned.size !== raw.size) {
    saveRelativeRankOverridesForSeason(db, seasonId, pruned);
  }
  return applySeasonRelativeRankOverrides(roster, groundTruth, pruned);
}

export function loadSeatOverridesForSeason(
  db: Db,
  seasonId: string,
): Map<number, number> {
  return loadRelativeRankOverridesForSeason(db, seasonId);
}

export function sanitizeRelativeRankOverridesForLiveSeason(
  db: Db,
  seasonId: string,
  roster: readonly LiveBoxLeaguePlayer[],
  raw?: ReadonlyMap<number, number>,
): Map<number, number> {
  const overrides = raw ?? loadRelativeRankOverridesForSeason(db, seasonId);
  const groundTruth = loadSeasonStartGroundTruthPlayers(db, seasonId);
  let pruned = pruneRelativeRankOverrides(overrides, roster);
  if (groundTruth.length > 0) {
    pruned = sanitizeSeatOverridesForGroundTruth(roster, groundTruth, pruned);
  }
  const changed =
    pruned.size !== overrides.size ||
    [...overrides.entries()].some(([id, seat]) => pruned.get(id) !== seat);
  if (changed) {
    saveRelativeRankOverridesForSeason(db, seasonId, pruned);
  }
  return pruned;
}
