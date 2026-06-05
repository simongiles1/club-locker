/** Minimal player fields needed for cross-box relative rank (1–6 within a box). */
export type BoxRelativeRankPlayer = {
  level: number;
  playerCurrentRank: number;
};

/** Player row with id — needed for sort-order seat within a box. */
export type BoxRelativeRankIdentifiedPlayer = BoxRelativeRankPlayer & {
  id: number;
};

/**
 * Max `playerCurrentRank` among players in boxes (`level`) strictly below `boxLevel`.
 * Box 3's first seat uses global rank 13 when boxes 1–2 hold six players each → offset 12.
 */
export function maxPlayerCurrentRankBelowBox(
  players: readonly BoxRelativeRankPlayer[],
  boxLevel: number,
): number {
  let max = 0;
  for (const p of players) {
    if (
      typeof p.level === "number" &&
      Number.isFinite(p.level) &&
      p.level < boxLevel &&
      typeof p.playerCurrentRank === "number" &&
      Number.isFinite(p.playerCurrentRank) &&
      p.playerCurrentRank > max
    ) {
      max = p.playerCurrentRank;
    }
  }
  return max;
}

/** Seat number within a box (1–6) from US Squash cumulative `playerCurrentRank`. */
export function relativeRankInBox(
  playerCurrentRank: number,
  boxLevel: number,
  allPlayers: readonly BoxRelativeRankPlayer[],
): number {
  return playerCurrentRank - maxPlayerCurrentRankBelowBox(allPlayers, boxLevel);
}

/**
 * 1-based position within a box from sort order of `playerCurrentRank` among
 * players in that box only. Unlike {@link relativeRankInBox}, this does not
 * depend on roster size in lower boxes (global rank offset).
 */
export function seatOrderInBox(
  playerId: number,
  boxLevel: number,
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
): number | null {
  if (
    typeof playerId !== "number" ||
    !Number.isFinite(playerId) ||
    playerId <= 0 ||
    typeof boxLevel !== "number" ||
    !Number.isFinite(boxLevel)
  ) {
    return null;
  }

  const inBox = roster
    .filter(
      (p) =>
        p.level === boxLevel &&
        typeof p.playerCurrentRank === "number" &&
        Number.isFinite(p.playerCurrentRank),
    )
    .sort((a, b) => {
      if (a.playerCurrentRank !== b.playerCurrentRank) {
        return a.playerCurrentRank - b.playerCurrentRank;
      }
      return a.id - b.id;
    });

  const idx = inBox.findIndex((p) => p.id === playerId);
  return idx >= 0 ? idx + 1 : null;
}

export type BoxRelativeRankNamedPlayer = BoxRelativeRankPlayer & {
  firstName: string;
  lastName: string;
};

/** Shown in box-change emails when a season-start seat has no player in that box on Club Locker. */
export const OPEN_BOX_SEAT_LABEL = "(open)";

const BOX_SEAT_MAX = 6;

export type BoxScheduleSeatAssignment = {
  seat: number;
  displayName: string;
};

type BoxDisplaySlot =
  | { seat: number; playerId: number }
  | { seat: number; vacant: true }
  | null;

function assignBoxDisplaySlots(
  boxNumber: number,
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  gt: readonly BoxRelativeRankIdentifiedPlayer[],
): BoxDisplaySlot[] {
  const slots: BoxDisplaySlot[] = Array.from(
    { length: BOX_SEAT_MAX },
    () => null,
  );
  const placedIds = new Set<number>();

  for (let seat = 1; seat <= BOX_SEAT_MAX; seat++) {
    const gtOccupant = gt.find(
      (p) =>
        p.level === boxNumber && seatOrderInBox(p.id, boxNumber, gt) === seat,
    );
    if (!gtOccupant) continue;

    const livePlayer = roster.find((p) => p.id === gtOccupant.id);
    if (livePlayer && livePlayer.level === boxNumber) {
      slots[seat - 1] = { seat, playerId: livePlayer.id };
      placedIds.add(livePlayer.id);
    } else {
      slots[seat - 1] = { seat, vacant: true };
    }
  }

  const liveInBox = roster.filter((p) => p.level === boxNumber);
  const unplaced = liveInBox
    .filter((p) => !placedIds.has(p.id))
    .sort((a, b) => {
      const sa = seatOrderInBox(a.id, boxNumber, roster) ?? 99;
      const sb = seatOrderInBox(b.id, boxNumber, roster) ?? 99;
      if (sa !== sb) return sa - sb;
      return a.id - b.id;
    });

  for (const p of unplaced) {
    const vacantIdx = slots.findIndex(
      (s) => s !== null && "vacant" in s && s.vacant,
    );
    if (vacantIdx >= 0) {
      const seat = vacantIdx + 1;
      slots[vacantIdx] = { seat, playerId: p.id };
      placedIds.add(p.id);
      continue;
    }
    const freeIdx = slots.findIndex((s) => s === null);
    if (freeIdx < 0) break;
    const seat = freeIdx + 1;
    slots[freeIdx] = { seat, playerId: p.id };
    placedIds.add(p.id);
  }

  return slots;
}

/** Display seat (1–6) per live player for box schedule emails (season-start anchored). */
export function displaySeatByPlayerIdInBox(input: {
  boxNumber: number;
  roster: readonly BoxRelativeRankIdentifiedPlayer[];
  groundTruthRoster: readonly BoxRelativeRankIdentifiedPlayer[];
}): Map<number, number> {
  const { boxNumber, roster, groundTruthRoster: gt } = input;
  const out = new Map<number, number>();
  for (const slot of assignBoxDisplaySlots(boxNumber, roster, gt)) {
    if (slot != null && "playerId" in slot) {
      out.set(slot.playerId, slot.seat);
    }
  }
  return out;
}

/**
 * Seat labels for a box roster list in schedule / EML emails.
 * Uses sort-order seats (1–N within the box), not cumulative US Squash rank.
 * When `groundTruthRoster` is provided (box-change emails), returning players
 * keep season-start seats; new players fill vacated seats first; remaining empty
 * seats are {@link OPEN_BOX_SEAT_LABEL}.
 */
export function buildBoxScheduleSeatPlayers(input: {
  boxNumber: number;
  roster: readonly BoxRelativeRankIdentifiedPlayer[];
  displayName: (player: BoxRelativeRankIdentifiedPlayer) => string;
  groundTruthRoster?: readonly BoxRelativeRankIdentifiedPlayer[];
}): BoxScheduleSeatAssignment[] {
  const { boxNumber, roster, displayName, groundTruthRoster } = input;

  if (!groundTruthRoster?.length) {
    const inBox = roster.filter((p) => p.level === boxNumber);
    const out: BoxScheduleSeatAssignment[] = [];
    for (const p of inBox) {
      const seat = seatOrderInBox(p.id, boxNumber, roster);
      if (seat == null || seat < 1 || seat > BOX_SEAT_MAX) continue;
      out.push({ seat, displayName: displayName(p) });
    }
    out.sort((a, b) => a.seat - b.seat);
    return out;
  }

  const gt = groundTruthRoster;
  const hasGtInBox = gt.some((p) => p.level === boxNumber);
  if (!hasGtInBox) {
    return buildBoxScheduleSeatPlayers({
      boxNumber,
      roster,
      displayName,
    });
  }

  const slots = assignBoxDisplaySlots(boxNumber, roster, gt);
  const out: BoxScheduleSeatAssignment[] = [];

  for (let seat = 1; seat <= BOX_SEAT_MAX; seat++) {
    const slot = slots[seat - 1];
    if (slot != null && "playerId" in slot) {
      const livePlayer = roster.find((p) => p.id === slot.playerId);
      if (livePlayer && livePlayer.level === boxNumber) {
        out.push({ seat, displayName: displayName(livePlayer) });
        continue;
      }
    }
    out.push({ seat, displayName: OPEN_BOX_SEAT_LABEL });
  }

  return out;
}

/**
 * Live player assigned to a fixed schedule seat (1–6) within a box.
 * With season-start ground truth, vacant seats stay empty (no rank compression).
 */
export function livePlayerAtScheduleSeat(
  boxNumber: number,
  seat: number,
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  groundTruthRoster?: readonly BoxRelativeRankIdentifiedPlayer[],
): BoxRelativeRankIdentifiedPlayer | null {
  if (
    typeof boxNumber !== "number" ||
    !Number.isFinite(boxNumber) ||
    typeof seat !== "number" ||
    seat < 1 ||
    seat > BOX_SEAT_MAX
  ) {
    return null;
  }

  if (groundTruthRoster?.length) {
    const slots = assignBoxDisplaySlots(boxNumber, roster, groundTruthRoster);
    const slot = slots[seat - 1];
    if (slot == null || !("playerId" in slot)) return null;
    return roster.find((p) => p.id === slot.playerId) ?? null;
  }

  for (const p of roster) {
    if (p.level !== boxNumber) continue;
    if (seatOrderInBox(p.id, boxNumber, roster) === seat) return p;
  }
  return null;
}

/** True when season-start seat is vacant on the live roster (open slot). */
export function isScheduleSeatVacantInBox(
  boxNumber: number,
  seat: number,
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  groundTruthRoster: readonly BoxRelativeRankIdentifiedPlayer[],
): boolean {
  const slots = assignBoxDisplaySlots(boxNumber, roster, groundTruthRoster);
  const slot = slots[seat - 1];
  return slot != null && "vacant" in slot && slot.vacant;
}

/**
 * Whether a weekly rotation pairing should still have a managed court booking.
 * Skips pairings where either schedule seat is open or has no live player.
 */
export function scheduleMatchPairNeedsCourtBooking(
  boxNumber: number,
  pair: [number, number],
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  groundTruthRoster?: readonly BoxRelativeRankIdentifiedPlayer[],
): boolean {
  if (groundTruthRoster?.length) {
    if (isScheduleSeatVacantInBox(boxNumber, pair[0], roster, groundTruthRoster)) {
      return false;
    }
    if (isScheduleSeatVacantInBox(boxNumber, pair[1], roster, groundTruthRoster)) {
      return false;
    }
  }
  return (
    livePlayerAtScheduleSeat(boxNumber, pair[0], roster, groundTruthRoster) !=
      null &&
    livePlayerAtScheduleSeat(boxNumber, pair[1], roster, groundTruthRoster) !=
      null
  );
}

/** Relative rank (1–6) → display name for one box level. */
export function playerNamesByRelativeRankInBox(
  allPlayers: readonly BoxRelativeRankNamedPlayer[],
  boxLevel: number,
): Map<number, string> {
  const offset = maxPlayerCurrentRankBelowBox(allPlayers, boxLevel);
  const out = new Map<number, string>();
  for (const p of allPlayers) {
    if (p.level !== boxLevel) continue;
    if (
      typeof p.playerCurrentRank !== "number" ||
      !Number.isFinite(p.playerCurrentRank)
    ) {
      continue;
    }
    const rr = p.playerCurrentRank - offset;
    if (rr <= 0) continue;
    const name = `${p.firstName.trim()} ${p.lastName.trim()}`.trim();
    if (name) out.set(rr, name);
  }
  return out;
}
