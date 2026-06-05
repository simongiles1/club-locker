import {
  seatOrderInBox,
  type BoxRelativeRankIdentifiedPlayer,
} from "./boxRelativeRank.js";

/** Minimal US Squash player row for season-start roster diff. */
export type SeasonStartRosterPlayer = BoxRelativeRankIdentifiedPlayer & {
  firstName: string;
  lastName: string;
};

export type SeasonStartRosterChangeKind =
  | "unchanged"
  | "moved"
  | "removedFromLive"
  | "addedOnLive";

export type SeasonStartRosterDiffRow = {
  playerId: number;
  firstName: string;
  lastName: string;
  changeKind: SeasonStartRosterChangeKind;
  groundTruthBox: number | null;
  groundTruthSeat: number | null;
  liveBox: number | null;
  liveSeat: number | null;
};

export type SeasonStartRosterDiffSummary = {
  unchanged: number;
  moved: number;
  removedFromLive: number;
  addedOnLive: number;
  hasChanges: boolean;
  hasGroundTruth: boolean;
};

export type SeasonStartRosterDiffResult = {
  rows: SeasonStartRosterDiffRow[];
  summary: SeasonStartRosterDiffSummary;
};

/** Box numbers that have at least one roster change vs season-start ground truth. */
export function boxNumbersWithSeasonStartChanges(
  diff: SeasonStartRosterDiffResult,
): number[] {
  const boxes = new Set<number>();
  for (const row of diff.rows) {
    if (row.changeKind === "unchanged") continue;
    if (
      row.groundTruthBox != null &&
      Number.isFinite(row.groundTruthBox) &&
      row.groundTruthBox > 0
    ) {
      boxes.add(row.groundTruthBox);
    }
    if (
      row.liveBox != null &&
      Number.isFinite(row.liveBox) &&
      row.liveBox > 0
    ) {
      boxes.add(row.liveBox);
    }
  }
  return [...boxes].sort((a, b) => a - b);
}

function joinModificationPhrases(phrases: string[]): string {
  if (phrases.length === 0) return "";
  if (phrases.length === 1) return phrases[0]!;
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases.at(-1)}`;
}

function describeBoxModificationPhrase(
  boxNumber: number,
  row: SeasonStartRosterDiffRow,
): string | null {
  const name = playerDisplayName(row);
  if (!name) return null;

  switch (row.changeKind) {
    case "removedFromLive":
      return row.groundTruthBox === boxNumber ? `${name} withdrawing` : null;
    case "addedOnLive":
      return row.liveBox === boxNumber ? `${name} joining` : null;
    case "moved":
      if (row.groundTruthBox === boxNumber && row.liveBox !== boxNumber) {
        return `${name} withdrawing`;
      }
      if (row.liveBox === boxNumber && row.groundTruthBox !== boxNumber) {
        return `${name} joining`;
      }
      return null;
    default:
      return null;
  }
}

/**
 * Clause for box-change email intros, e.g.
 * ` due to Anthony Berg withdrawing` or
 * ` due to Anthony Berg withdrawing and Jane Doe joining`.
 * Empty when there is nothing to describe for this box.
 */
export function formatBoxModificationReasonClause(
  boxNumber: number,
  diff: SeasonStartRosterDiffResult,
): string {
  const withdrawals: string[] = [];
  const joinings: string[] = [];
  for (const row of diff.rows) {
    const phrase = describeBoxModificationPhrase(boxNumber, row);
    if (!phrase) continue;
    if (phrase.endsWith(" withdrawing")) withdrawals.push(phrase);
    else joinings.push(phrase);
  }
  const phrases = [...withdrawals, ...joinings];
  if (phrases.length === 0) return "";
  return ` due to ${joinModificationPhrases(phrases)}`;
}

function playerDisplayName(p: Pick<SeasonStartRosterPlayer, "firstName" | "lastName">): string {
  return `${p.firstName.trim()} ${p.lastName.trim()}`.trim();
}

function validBoxLevel(level: unknown): level is number {
  return typeof level === "number" && Number.isFinite(level) && !Number.isNaN(level);
}

function seatInBox(
  player: SeasonStartRosterPlayer,
  roster: readonly SeasonStartRosterPlayer[],
): number | null {
  if (!validBoxLevel(player.level)) return null;
  return seatOrderInBox(player.id, player.level, roster);
}

function indexById(
  players: readonly SeasonStartRosterPlayer[],
): Map<number, SeasonStartRosterPlayer> {
  const map = new Map<number, SeasonStartRosterPlayer>();
  for (const p of players) {
    if (typeof p.id === "number" && Number.isFinite(p.id) && p.id > 0) {
      map.set(p.id, p);
    }
  }
  return map;
}

/**
 * Compare season-start ground truth roster against live Club Locker roster.
 * Seat comparison uses sort-order position within each box (1–N), not
 * cumulative US Squash `playerCurrentRank` across the league.
 */
export function compareSeasonStartRosters(
  groundTruth: readonly SeasonStartRosterPlayer[],
  live: readonly SeasonStartRosterPlayer[],
): SeasonStartRosterDiffResult {
  const gtById = indexById(groundTruth);
  const liveById = indexById(live);
  const rows: SeasonStartRosterDiffRow[] = [];

  if (gtById.size === 0) {
    return {
      rows: [],
      summary: {
        unchanged: 0,
        moved: 0,
        removedFromLive: 0,
        addedOnLive: 0,
        hasChanges: false,
        hasGroundTruth: false,
      },
    };
  }

  let unchanged = 0;
  let moved = 0;
  let removedFromLive = 0;
  let addedOnLive = 0;

  for (const [playerId, gt] of gtById) {
    const livePlayer = liveById.get(playerId);
    const gtBox = validBoxLevel(gt.level) ? gt.level : null;
    const gtSeat = seatInBox(gt, groundTruth);

    if (!livePlayer) {
      removedFromLive += 1;
      rows.push({
        playerId,
        firstName: gt.firstName,
        lastName: gt.lastName,
        changeKind: "removedFromLive",
        groundTruthBox: gtBox,
        groundTruthSeat: gtSeat,
        liveBox: null,
        liveSeat: null,
      });
      continue;
    }

    const liveBox = validBoxLevel(livePlayer.level) ? livePlayer.level : null;
    const liveSeat = seatInBox(livePlayer, live);

    if (gtBox === liveBox && gtSeat === liveSeat) {
      unchanged += 1;
      rows.push({
        playerId,
        firstName: gt.firstName,
        lastName: gt.lastName,
        changeKind: "unchanged",
        groundTruthBox: gtBox,
        groundTruthSeat: gtSeat,
        liveBox,
        liveSeat,
      });
    } else {
      moved += 1;
      rows.push({
        playerId,
        firstName: gt.firstName,
        lastName: gt.lastName,
        changeKind: "moved",
        groundTruthBox: gtBox,
        groundTruthSeat: gtSeat,
        liveBox,
        liveSeat,
      });
    }
  }

  for (const [playerId, livePlayer] of liveById) {
    if (gtById.has(playerId)) continue;
    addedOnLive += 1;
    const liveBox = validBoxLevel(livePlayer.level) ? livePlayer.level : null;
    const liveSeat = seatInBox(livePlayer, live);
    rows.push({
      playerId,
      firstName: livePlayer.firstName,
      lastName: livePlayer.lastName,
      changeKind: "addedOnLive",
      groundTruthBox: null,
      groundTruthSeat: null,
      liveBox,
      liveSeat,
    });
  }

  rows.sort((a, b) => {
    const kindOrder: Record<SeasonStartRosterChangeKind, number> = {
      moved: 0,
      addedOnLive: 1,
      removedFromLive: 2,
      unchanged: 3,
    };
    const ko = kindOrder[a.changeKind] - kindOrder[b.changeKind];
    if (ko !== 0) return ko;
    const na = playerDisplayName(a);
    const nb = playerDisplayName(b);
    return na.localeCompare(nb, undefined, { sensitivity: "base" });
  });

  const hasChanges = moved + removedFromLive + addedOnLive > 0;

  return {
    rows,
    summary: {
      unchanged,
      moved,
      removedFromLive,
      addedOnLive,
      hasChanges,
      hasGroundTruth: true,
    },
  };
}
