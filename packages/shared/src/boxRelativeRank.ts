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

export type BoxUiSeatRow = {
  seat: number;
  playerId: number | null;
  open: boolean;
  /** New player not yet assigned to a vacated season-start seat. */
  unassigned?: boolean;
};

/** Director seat overrides keyed by US Squash player id → fixed seat 1–6 within box. */
export type BoxSeatOverrides = ReadonlyMap<number, number>;

export type AssignBoxDisplaySlotsOptions = {
  /** When false, vacated season-start seats stay open until a director override places a new player. */
  fillVacantWithNewPlayers?: boolean;
};

function gtReturningPlayerIdsInBox(
  boxNumber: number,
  groundTruth: readonly BoxRelativeRankIdentifiedPlayer[],
): Set<number> {
  const out = new Set<number>();
  for (const p of groundTruth) {
    if (p.level === boxNumber) out.add(p.id);
  }
  return out;
}

function assignBoxDisplaySlots(
  boxNumber: number,
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  gt: readonly BoxRelativeRankIdentifiedPlayer[],
  seatOverrides?: BoxSeatOverrides,
  options?: AssignBoxDisplaySlotsOptions,
): BoxDisplaySlot[] {
  const fillVacant = options?.fillVacantWithNewPlayers !== false;
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
    if (fillVacant) {
      const vacantIdx = slots.findIndex(
        (s) => s !== null && "vacant" in s && s.vacant,
      );
      if (vacantIdx >= 0) {
        const seat = vacantIdx + 1;
        slots[vacantIdx] = { seat, playerId: p.id };
        placedIds.add(p.id);
        continue;
      }
    }
    const freeIdx = slots.findIndex((s) => s === null);
    if (freeIdx < 0) break;
    const seat = freeIdx + 1;
    slots[freeIdx] = { seat, playerId: p.id };
    placedIds.add(p.id);
  }

  if (seatOverrides && seatOverrides.size > 0) {
    applyDirectorSeatOverrides(slots, boxNumber, roster, gt, seatOverrides);
  }

  return slots;
}

/** Merge director seat overrides onto season-start slot assignments (swap when target occupied). */
function applyDirectorSeatOverrides(
  slots: BoxDisplaySlot[],
  boxNumber: number,
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  gt: readonly BoxRelativeRankIdentifiedPlayer[],
  seatOverrides: BoxSeatOverrides,
): void {
  const returning = gtReturningPlayerIdsInBox(boxNumber, gt);
  const inBoxIds = new Set(
    roster.filter((p) => p.level === boxNumber).map((p) => p.id),
  );
  const seatToPlayer = new Map<number, number>();
  for (const slot of slots) {
    if (slot != null && "playerId" in slot) {
      seatToPlayer.set(slot.seat, slot.playerId);
    }
  }

  for (const [playerId, targetSeat] of seatOverrides) {
    if (
      returning.has(playerId) ||
      !inBoxIds.has(playerId) ||
      typeof targetSeat !== "number" ||
      !Number.isFinite(targetSeat) ||
      targetSeat < 1 ||
      targetSeat > BOX_SEAT_MAX
    ) {
      continue;
    }
    const seat = Math.trunc(targetSeat);
    const slot = slots[seat - 1];
    if (slot == null || !("vacant" in slot) || !slot.vacant) {
      continue;
    }
    let currentSeat: number | null = null;
    for (const [s, id] of seatToPlayer) {
      if (id === playerId) {
        currentSeat = s;
        break;
      }
    }
    if (currentSeat === seat) continue;

    if (currentSeat != null) seatToPlayer.delete(currentSeat);
    seatToPlayer.set(seat, playerId);
  }

  for (let i = 0; i < BOX_SEAT_MAX; i++) {
    const seat = i + 1;
    const playerId = seatToPlayer.get(seat);
    if (playerId != null) {
      slots[i] = { seat, playerId };
    } else {
      const prior = slots[i];
      slots[i] =
        prior != null && "vacant" in prior && prior.vacant
          ? { seat, vacant: true }
          : null;
    }
  }
}

function groundTruthHadBox(
  boxNumber: number,
  groundTruth: readonly BoxRelativeRankIdentifiedPlayer[],
): boolean {
  return groundTruth.some((p) => p.level === boxNumber);
}

/** Vacated season-start seats still available for a newly added player. */
export function assignableVacantSeasonStartSeats(
  boxNumber: number,
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  groundTruth: readonly BoxRelativeRankIdentifiedPlayer[],
  seatOverrides?: BoxSeatOverrides,
): number[] {
  const base = assignBoxDisplaySlots(
    boxNumber,
    roster,
    groundTruth,
    undefined,
    { fillVacantWithNewPlayers: false },
  );
  const returning = gtReturningPlayerIdsInBox(boxNumber, groundTruth);
  const out: number[] = [];
  for (let seat = 1; seat <= BOX_SEAT_MAX; seat++) {
    const slot = base[seat - 1];
    if (slot == null || !("vacant" in slot) || !slot.vacant) continue;
    let taken = false;
    if (seatOverrides) {
      for (const [pid, s] of seatOverrides) {
        if (s !== seat || returning.has(pid)) continue;
        if (roster.some((p) => p.id === pid && p.level === boxNumber)) {
          taken = true;
          break;
        }
      }
    }
    if (!taken) out.push(seat);
  }
  return out;
}

export function isReturningSeasonStartPlayerInBox(
  playerId: number,
  boxNumber: number,
  groundTruth: readonly BoxRelativeRankIdentifiedPlayer[],
): boolean {
  return groundTruth.some((p) => p.id === playerId && p.level === boxNumber);
}

/** Final season-start-anchored seat (1–6) per player in a box. */
export function computeBoxSeatByPlayerId(
  boxNumber: number,
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  groundTruth?: readonly BoxRelativeRankIdentifiedPlayer[],
  seatOverrides?: BoxSeatOverrides,
): Map<number, number> {
  const out = new Map<number, number>();
  if (groundTruth?.length && groundTruthHadBox(boxNumber, groundTruth)) {
    for (const slot of assignBoxDisplaySlots(
      boxNumber,
      roster,
      groundTruth,
      seatOverrides,
    )) {
      if (slot != null && "playerId" in slot) {
        out.set(slot.playerId, slot.seat);
      }
    }
    return out;
  }

  for (const p of roster) {
    if (p.level !== boxNumber) continue;
    const override = seatOverrides?.get(p.id);
    if (override != null && override >= 1 && override <= BOX_SEAT_MAX) {
      out.set(p.id, Math.trunc(override));
      continue;
    }
    const seat = seatOrderInBox(p.id, boxNumber, roster);
    if (seat != null) out.set(p.id, seat);
  }
  return out;
}

/** Rows for the Boxes UI — six season-start slots when ground truth exists for the box. */
export function buildBoxUiSeatRows(
  boxNumber: number,
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  groundTruth?: readonly BoxRelativeRankIdentifiedPlayer[],
  seatOverrides?: BoxSeatOverrides,
): BoxUiSeatRow[] {
  if (!groundTruth?.length || !groundTruthHadBox(boxNumber, groundTruth)) {
    const seatByPlayer = computeBoxSeatByPlayerId(
      boxNumber,
      roster,
      groundTruth,
      seatOverrides,
    );
    return [...seatByPlayer.entries()]
      .sort(([, a], [, b]) => a - b)
      .map(([playerId, seat]) => ({
        seat,
        playerId,
        open: false,
      }));
  }

  const slots = assignBoxDisplaySlots(
    boxNumber,
    roster,
    groundTruth,
    seatOverrides,
    { fillVacantWithNewPlayers: false },
  );
  const rows: BoxUiSeatRow[] = [];
  const seatedIds = new Set<number>();
  for (let seat = 1; seat <= BOX_SEAT_MAX; seat++) {
    const slot = slots[seat - 1];
    if (slot != null && "playerId" in slot) {
      const live = roster.find((p) => p.id === slot.playerId);
      if (live && live.level === boxNumber) {
        rows.push({ seat, playerId: slot.playerId, open: false });
        seatedIds.add(slot.playerId);
        continue;
      }
    }
    rows.push({ seat, playerId: null, open: true });
  }
  for (const p of roster) {
    if (p.level !== boxNumber || seatedIds.has(p.id)) continue;
    rows.push({
      seat: 0,
      playerId: p.id,
      open: false,
      unassigned: true,
    });
  }
  return rows;
}

/** Lowest vacant season-start seat in a box, or null when none. */
export function firstVacantSeatInBox(
  boxNumber: number,
  roster: readonly BoxRelativeRankIdentifiedPlayer[],
  groundTruth: readonly BoxRelativeRankIdentifiedPlayer[],
  seatOverrides?: BoxSeatOverrides,
): number | null {
  if (!groundTruthHadBox(boxNumber, groundTruth)) return null;
  const rows = buildBoxUiSeatRows(boxNumber, roster, groundTruth, seatOverrides);
  const open = rows.find((r) => r.open);
  return open?.seat ?? null;
}

/** Display seat (1–6) per live player for box schedule emails (season-start anchored). */
export function displaySeatByPlayerIdInBox(input: {
  boxNumber: number;
  roster: readonly BoxRelativeRankIdentifiedPlayer[];
  groundTruthRoster: readonly BoxRelativeRankIdentifiedPlayer[];
  seatOverrides?: BoxSeatOverrides;
}): Map<number, number> {
  return computeBoxSeatByPlayerId(
    input.boxNumber,
    input.roster,
    input.groundTruthRoster,
    input.seatOverrides,
  );
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
  seatOverrides?: BoxSeatOverrides;
}): BoxScheduleSeatAssignment[] {
  const { boxNumber, roster, displayName, groundTruthRoster, seatOverrides } =
    input;

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

  const slots = assignBoxDisplaySlots(
    boxNumber,
    roster,
    gt,
    seatOverrides,
  );
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
  seatOverrides?: BoxSeatOverrides,
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
    const seatByPlayer = computeBoxSeatByPlayerId(
      boxNumber,
      roster,
      groundTruthRoster,
      seatOverrides,
    );
    for (const [playerId, s] of seatByPlayer) {
      if (s === seat) return roster.find((p) => p.id === playerId) ?? null;
    }
    return null;
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
  seatOverrides?: BoxSeatOverrides,
): boolean {
  const rows = buildBoxUiSeatRows(
    boxNumber,
    roster,
    groundTruthRoster,
    seatOverrides,
  );
  const row = rows.find((r) => r.seat === seat);
  return row?.open === true;
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
  seatOverrides?: BoxSeatOverrides,
): boolean {
  if (groundTruthRoster?.length) {
    if (
      isScheduleSeatVacantInBox(
        boxNumber,
        pair[0],
        roster,
        groundTruthRoster,
        seatOverrides,
      )
    ) {
      return false;
    }
    if (
      isScheduleSeatVacantInBox(
        boxNumber,
        pair[1],
        roster,
        groundTruthRoster,
        seatOverrides,
      )
    ) {
      return false;
    }
  }
  return (
    livePlayerAtScheduleSeat(
      boxNumber,
      pair[0],
      roster,
      groundTruthRoster,
      seatOverrides,
    ) != null &&
    livePlayerAtScheduleSeat(
      boxNumber,
      pair[1],
      roster,
      groundTruthRoster,
      seatOverrides,
    ) != null
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
