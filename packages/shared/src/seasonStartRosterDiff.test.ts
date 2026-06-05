import { describe, expect, it } from "vitest";
import {
  boxNumbersWithSeasonStartChanges,
  compareSeasonStartRosters,
  formatBoxModificationReasonClause,
  type SeasonStartRosterPlayer,
} from "./seasonStartRosterDiff.js";

function p(
  id: number,
  level: number,
  playerCurrentRank: number,
  firstName: string,
  lastName: string,
): SeasonStartRosterPlayer {
  return { id, level, playerCurrentRank, firstName, lastName };
}

describe("compareSeasonStartRosters", () => {
  const groundTruth: SeasonStartRosterPlayer[] = [
    ...[1, 2, 3, 4, 5, 6].map((r) => p(r, 1, r, "Box1", `P${r}`)),
    ...[7, 8, 9, 10, 11, 12].map((r) => p(r + 100, 2, r, "Box2", `P${r - 6}`)),
  ];

  it("returns no ground truth when empty", () => {
    const result = compareSeasonStartRosters([], groundTruth);
    expect(result.summary.hasGroundTruth).toBe(false);
    expect(result.summary.hasChanges).toBe(false);
    expect(result.rows).toHaveLength(0);
  });

  it("marks identical rosters unchanged", () => {
    const result = compareSeasonStartRosters(groundTruth, groundTruth);
    expect(result.summary.hasChanges).toBe(false);
    expect(result.summary.unchanged).toBe(12);
    expect(result.summary.moved).toBe(0);
  });

  it("detects moved player (different box)", () => {
    const live = groundTruth.map((row) =>
      row.id === 3 ? { ...row, level: 2, playerCurrentRank: 13 } : row,
    );
    const result = compareSeasonStartRosters(groundTruth, live);
    expect(result.summary.hasChanges).toBe(true);
    const moved = result.rows.find((r) => r.playerId === 3);
    expect(moved?.changeKind).toBe("moved");
    expect(moved?.groundTruthBox).toBe(1);
    expect(moved?.groundTruthSeat).toBe(3);
    expect(moved?.liveBox).toBe(2);
    expect(moved?.liveSeat).toBe(7);
    expect(result.rows.filter((r) => r.changeKind === "moved").length).toBeGreaterThan(
      0,
    );
  });

  it("detects removed from live", () => {
    const live = groundTruth.filter((row) => row.id !== 5);
    const result = compareSeasonStartRosters(groundTruth, live);
    expect(result.summary.removedFromLive).toBe(1);
    expect(result.rows.find((r) => r.playerId === 5)?.changeKind).toBe(
      "removedFromLive",
    );
    expect(boxNumbersWithSeasonStartChanges(result)).toEqual([1]);
  });

  it("formats box modification reason clause for withdrawal", () => {
    const live = groundTruth.filter((row) => row.id !== 5);
    const result = compareSeasonStartRosters(groundTruth, live);
    const removed = result.rows.find((r) => r.playerId === 5)!;
    expect(formatBoxModificationReasonClause(1, result)).toBe(
      ` due to ${removed.firstName} ${removed.lastName} withdrawing`,
    );
  });

  it("formats combined withdrawal and joining for one box", () => {
    const live = [
      ...groundTruth.filter((row) => row.id !== 5),
      p(999, 1, 6, "New", "Player"),
    ];
    const result = compareSeasonStartRosters(groundTruth, live);
    expect(formatBoxModificationReasonClause(1, result)).toBe(
      " due to Box1 P5 withdrawing and New Player joining",
    );
  });

  it("detects added on live", () => {
    const live = [
      ...groundTruth,
      p(999, 3, 13, "New", "Player"),
    ];
    const result = compareSeasonStartRosters(groundTruth, live);
    expect(result.summary.addedOnLive).toBe(1);
    expect(result.rows.find((r) => r.playerId === 999)?.changeKind).toBe(
      "addedOnLive",
    );
  });

  it("detects seat change within same box as moved", () => {
    const live = groundTruth.map((row) => {
      if (row.id === 1) return { ...row, playerCurrentRank: 2 };
      if (row.id === 2) return { ...row, playerCurrentRank: 1 };
      return row;
    });
    const result = compareSeasonStartRosters(groundTruth, live);
    expect(result.summary.moved).toBe(2);
    expect(result.rows.find((r) => r.playerId === 1)?.changeKind).toBe("moved");
    expect(result.rows.find((r) => r.playerId === 1)?.groundTruthSeat).toBe(1);
    expect(result.rows.find((r) => r.playerId === 1)?.liveSeat).toBe(2);
  });

  it("ignores global rank offset when in-box sort order is unchanged", () => {
    const live = groundTruth.filter((row) => row.id !== 6);
    const box2Leader = live.find((r) => r.id === 107);
    expect(box2Leader?.level).toBe(2);
    expect(box2Leader?.playerCurrentRank).toBe(7);

    const result = compareSeasonStartRosters(groundTruth, live);
    expect(result.summary.moved).toBe(0);
    expect(result.rows.find((r) => r.playerId === 107)?.changeKind).toBe(
      "unchanged",
    );
  });

  it("reports within-box seat numbers not cumulative global rank", () => {
    const result = compareSeasonStartRosters(groundTruth, groundTruth);
    const box2Top = result.rows.find((r) => r.playerId === 107);
    expect(box2Top?.groundTruthSeat).toBe(1);
    expect(box2Top?.groundTruthBox).toBe(2);
    expect(box2Top?.groundTruthSeat).not.toBe(7);
  });

  it("reports added player at vacated sort-order seat when replacing a withdrawal", () => {
    const box20 = 20;
    const offset = 19 * 6;
    const gt: SeasonStartRosterPlayer[] = [
      ...[1, 2, 3, 4, 5, 6].map((seat) =>
        p(offset + seat, box20, offset + seat, "Box20", `P${seat}`),
      ),
    ];
    const andrewId = offset + 5;
    const parsaId = 999_020;
    const live = [
      ...gt.filter((row) => row.id !== andrewId),
      p(parsaId, box20, offset + 5, "Parsa", "Shalchi"),
    ];
    const result = compareSeasonStartRosters(gt, live);
    expect(result.rows.find((r) => r.playerId === andrewId)?.changeKind).toBe(
      "removedFromLive",
    );
    expect(result.rows.find((r) => r.playerId === andrewId)?.groundTruthSeat).toBe(
      5,
    );
    const parsa = result.rows.find((r) => r.playerId === parsaId);
    expect(parsa?.changeKind).toBe("addedOnLive");
    expect(parsa?.liveSeat).toBe(5);
  });
});
