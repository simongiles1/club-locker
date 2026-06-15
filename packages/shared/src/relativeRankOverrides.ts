import {
  assignableVacantSeasonStartSeats,
  computeBoxSeatByPlayerId,
  isReturningSeasonStartPlayerInBox,
  maxPlayerCurrentRankBelowBox,
  relativeRankInBox,
  type BoxRelativeRankIdentifiedPlayer,
} from "./boxRelativeRank.js";

/** Director-set fixed seat (1–6) within a box, keyed by US Squash player id. */
export type RelativeRankOverrides = ReadonlyMap<number, number>;

export function parseRelativeRankOverridesJson(
  raw: string | null | undefined,
): Map<number, number> {
  const out = new Map<number, number>();
  if (!raw?.trim()) return out;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(key);
      const rr = Number(value);
      if (
        Number.isFinite(id) &&
        id > 0 &&
        Number.isFinite(rr) &&
        rr >= 1 &&
        rr <= 6
      ) {
        out.set(id, Math.trunc(rr));
      }
    }
  } catch {
    /* ignore corrupt JSON */
  }
  return out;
}

export function serializeRelativeRankOverrides(
  overrides: ReadonlyMap<number, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, rr] of overrides) {
    if (Number.isFinite(id) && id > 0 && Number.isFinite(rr) && rr >= 1) {
      out[String(id)] = Math.trunc(rr);
    }
  }
  return out;
}

/** Drop overrides for players not on the roster or not in the box the override implies. */
export function pruneRelativeRankOverrides(
  overrides: ReadonlyMap<number, number>,
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
): Map<number, number> {
  const byId = new Map(roster.map((p) => [p.id, p]));
  const out = new Map<number, number>();
  for (const [id, rr] of overrides) {
    const p = byId.get(id);
    if (!p || typeof p.level !== "number" || !Number.isFinite(p.level) || p.level <= 0) {
      continue;
    }
    if (!Number.isFinite(rr) || rr < 1 || rr > 6) continue;
    out.set(id, Math.trunc(rr));
  }
  return out;
}

export function effectiveRelativeRankInBox(
  player: BoxRelativeRankIdentifiedPlayer,
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  overrides: RelativeRankOverrides,
  groundTruth?: readonly BoxRelativeRankIdentifiedPlayer[],
): number | null {
  if (typeof player.level !== "number" || !Number.isFinite(player.level) || player.level <= 0) {
    return null;
  }
  if (groundTruth?.length) {
    const seat = computeBoxSeatByPlayerId(
      player.level,
      roster,
      groundTruth,
      overrides,
    ).get(player.id);
    if (seat != null) return seat;
  }
  const override = overrides.get(player.id);
  if (override != null && Number.isFinite(override) && override >= 1) {
    return Math.trunc(override);
  }
  if (
    typeof player.playerCurrentRank !== "number" ||
    !Number.isFinite(player.playerCurrentRank)
  ) {
    return null;
  }
  return relativeRankInBox(player.playerCurrentRank, player.level, roster);
}

export function playersInBoxSortedByEffectiveRank<
  T extends BoxRelativeRankIdentifiedPlayer,
>(
  roster: readonly T[],
  level: number,
  overrides: RelativeRankOverrides,
  groundTruth?: readonly BoxRelativeRankIdentifiedPlayer[],
): T[] {
  return roster
    .filter(
      (p) =>
        typeof p.level === "number" && Number.isFinite(p.level) && p.level === level,
    )
    .sort((a, b) => {
      const ra =
        effectiveRelativeRankInBox(a, roster, overrides, groundTruth) ?? 99;
      const rb =
        effectiveRelativeRankInBox(b, roster, overrides, groundTruth) ?? 99;
      if (ra !== rb) return ra - rb;
      return a.id - b.id;
    });
}

/**
 * Apply season-start-anchored seats (and director overrides) to cumulative
 * `playerCurrentRank` for booking and schedule resolution.
 */
export function applyAnchoredBoxSeatsToRoster<
  T extends BoxRelativeRankIdentifiedPlayer,
>(
  roster: readonly T[],
  groundTruth?: readonly BoxRelativeRankIdentifiedPlayer[],
  overrides?: RelativeRankOverrides,
): T[] {
  const gt = groundTruth ?? [];
  const ovr = sanitizeSeatOverridesForGroundTruth(roster, gt, overrides ?? new Map());
  if (!gt.length) {
    return applyRelativeRankOverrides(roster, ovr);
  }

  const levels = [
    ...new Set(
      roster
        .map((p) => p.level)
        .filter((l) => typeof l === "number" && Number.isFinite(l) && l > 0),
    ),
  ].sort((a, b) => a - b);

  let result = [...roster];
  for (const level of levels) {
    const seatByPlayer = computeBoxSeatByPlayerId(level, result, gt, ovr);
    if (seatByPlayer.size === 0) continue;
    const offset = maxPlayerCurrentRankBelowBox(result, level);
    result = result.map((p) => {
      const seat = seatByPlayer.get(p.id);
      if (seat == null) return p;
      const rank = offset + seat;
      return rank !== p.playerCurrentRank ? { ...p, playerCurrentRank: rank } : p;
    });
  }
  return result;
}

/**
 * Patch cumulative `playerCurrentRank` for players with director overrides only.
 * Other players keep Club Locker ranks (including offset math for lower boxes).
 */
export function applyRelativeRankOverrides<
  T extends BoxRelativeRankIdentifiedPlayer,
>(roster: readonly T[], overrides: RelativeRankOverrides): T[] {
  if (overrides.size === 0) return [...roster];
  return roster.map((p) => {
    const rr = overrides.get(p.id);
    if (
      rr == null ||
      typeof p.level !== "number" ||
      !Number.isFinite(p.level) ||
      p.level <= 0
    ) {
      return p;
    }
    const offset = maxPlayerCurrentRankBelowBox(roster, p.level);
    const rank = offset + Math.trunc(rr);
    return rank !== p.playerCurrentRank ? { ...p, playerCurrentRank: rank } : p;
  });
}

/** Drop overrides for returning season-start players (they keep GT seats). */
export function sanitizeSeatOverridesForGroundTruth(
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  groundTruth: readonly BoxRelativeRankIdentifiedPlayer[],
  overrides: RelativeRankOverrides,
): Map<number, number> {
  if (!groundTruth.length) return new Map(overrides);
  const next = new Map<number, number>();
  for (const [playerId, seat] of overrides) {
    const p = roster.find((r) => r.id === playerId);
    if (!p || typeof p.level !== "number" || !Number.isFinite(p.level)) continue;
    if (isReturningSeasonStartPlayerInBox(playerId, p.level, groundTruth)) continue;
    if (seat < 1 || seat > 6) continue;
    const withoutSelf = new Map(overrides);
    withoutSelf.delete(playerId);
    const assignable = assignableVacantSeasonStartSeats(
      p.level,
      roster,
      groundTruth,
      withoutSelf,
    );
    if (!assignable.includes(Math.trunc(seat))) continue;
    next.set(playerId, Math.trunc(seat));
  }
  return next;
}

/** Swap a player to the next season-start seat up/down; returns override map for the box. */
export function reorderPlayerSeatInBox(
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  groundTruth: readonly BoxRelativeRankIdentifiedPlayer[],
  overrides: RelativeRankOverrides,
  playerId: number,
  direction: "up" | "down",
): Map<number, number> | null {
  const player = roster.find((p) => p.id === playerId);
  if (!player || typeof player.level !== "number" || !Number.isFinite(player.level)) {
    return null;
  }
  const level = player.level;
  if (level <= 0) return null;

  if (isReturningSeasonStartPlayerInBox(playerId, level, groundTruth)) {
    return null;
  }

  const vacant = assignableVacantSeasonStartSeats(
    level,
    roster,
    groundTruth,
    overrides,
  );
  const current = overrides.get(playerId);
  const next = sanitizeSeatOverridesForGroundTruth(
    roster,
    groundTruth,
    overrides,
  );

  if (direction === "up") {
    if (current != null) {
      const lower = vacant.filter((s) => s < current);
      if (lower.length === 0) return null;
      next.set(playerId, Math.max(...lower));
    } else {
      if (vacant.length === 0) return null;
      next.set(playerId, Math.min(...vacant));
    }
  } else {
    if (current == null) return null;
    const higher = vacant.filter((s) => s > current);
    if (higher.length > 0) {
      next.set(playerId, Math.min(...higher));
    } else {
      next.delete(playerId);
    }
  }
  return next;
}

/** Swap a player up/down within their box; returns a new override map (all seats in box set). */
export function reorderRelativeRankInBox(
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  overrides: RelativeRankOverrides,
  playerId: number,
  direction: "up" | "down",
  groundTruth?: readonly BoxRelativeRankIdentifiedPlayer[],
): Map<number, number> | null {
  if (groundTruth?.length) {
    const player = roster.find((p) => p.id === playerId);
    if (
      player &&
      typeof player.level === "number" &&
      groundTruth.some((p) => p.level === player.level)
    ) {
      return reorderPlayerSeatInBox(
        roster,
        groundTruth,
        overrides,
        playerId,
        direction,
      );
    }
  }

  const player = roster.find((p) => p.id === playerId);
  if (!player || typeof player.level !== "number" || !Number.isFinite(player.level)) {
    return null;
  }
  const level = player.level;
  if (level <= 0) return null;

  const inBox = playersInBoxSortedByEffectiveRank(roster, level, overrides);
  const idx = inBox.findIndex((p) => p.id === playerId);
  if (idx < 0) return null;
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= inBox.length) return null;

  const orderedIds = inBox.map((p) => p.id);
  [orderedIds[idx], orderedIds[swapIdx]] = [orderedIds[swapIdx]!, orderedIds[idx]!];

  const next = new Map(overrides);
  orderedIds.forEach((id, index) => {
    next.set(id, index + 1);
  });
  return next;
}

/** Reassign cumulative ranks within one box (draft / season-start rosters). */
export function applyBoxPlayerOrder<
  T extends BoxRelativeRankIdentifiedPlayer,
>(players: readonly T[], level: number, orderedIds: number[]): T[] {
  const offset = maxPlayerCurrentRankBelowBox(players, level);
  const idToRank = new Map(
    orderedIds.map((id, index) => [id, offset + index + 1]),
  );
  return players.map((p) => {
    if (p.level !== level) return p;
    const rank = idToRank.get(p.id);
    if (rank == null) return p;
    return { ...p, playerCurrentRank: rank };
  });
}

export function reorderPlayerWithinBoxByCurrentRank<
  T extends BoxRelativeRankIdentifiedPlayer,
>(players: readonly T[], playerId: number, direction: "up" | "down"): T[] | null {
  const player = players.find((p) => p.id === playerId);
  if (!player || typeof player.level !== "number" || !Number.isFinite(player.level)) {
    return null;
  }
  const level = player.level;
  if (level <= 0) return null;

  const inBox = players
    .filter(
      (p) =>
        typeof p.level === "number" && Number.isFinite(p.level) && p.level === level,
    )
    .sort((a, b) => {
      const ra = a.playerCurrentRank ?? 0;
      const rb = b.playerCurrentRank ?? 0;
      if (ra !== rb) return ra - rb;
      return a.id - b.id;
    });

  const idx = inBox.findIndex((p) => p.id === playerId);
  if (idx < 0) return null;
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= inBox.length) return null;

  const orderedIds = inBox.map((p) => p.id);
  [orderedIds[idx], orderedIds[swapIdx]] = [orderedIds[swapIdx]!, orderedIds[idx]!];
  return applyBoxPlayerOrder(players, level, orderedIds);
}
