import { describe, expect, it } from "vitest";
import {
  applyRelativeRankOverrides,
  effectiveRelativeRankInBox,
  parseRelativeRankOverridesJson,
  pruneRelativeRankOverrides,
  reorderRelativeRankInBox,
  reorderPlayerWithinBoxByCurrentRank,
  sanitizeSeatOverridesForGroundTruth,
  serializeRelativeRankOverrides,
} from "./relativeRankOverrides.js";

const roster = [
  { id: 1, level: 1, playerCurrentRank: 1 },
  { id: 2, level: 1, playerCurrentRank: 2 },
  { id: 3, level: 2, playerCurrentRank: 7 },
  { id: 4, level: 2, playerCurrentRank: 8 },
];

describe("relativeRankOverrides", () => {
  it("parses and serializes override JSON", () => {
    const map = parseRelativeRankOverridesJson('{"1":2,"2":1,"bad":0}');
    expect(map.get(1)).toBe(2);
    expect(map.get(2)).toBe(1);
    expect(map.has("bad" as unknown as number)).toBe(false);
    expect(serializeRelativeRankOverrides(map)).toEqual({ "1": 2, "2": 1 });
  });

  it("uses override before Club Locker rank for effective RR", () => {
    const overrides = new Map([
      [1, 2],
      [2, 1],
    ]);
    expect(effectiveRelativeRankInBox(roster[0]!, roster, overrides)).toBe(2);
    expect(effectiveRelativeRankInBox(roster[1]!, roster, overrides)).toBe(1);
  });

  it("reorders overrides within a box", () => {
    const overrides = new Map<number, number>();
    const next = reorderRelativeRankInBox(roster, overrides, 3, "down");
    expect(next?.get(3)).toBe(2);
    expect(next?.get(4)).toBe(1);
  });

  it("applies overrides to cumulative playerCurrentRank", () => {
    const overrides = new Map([
      [1, 2],
      [2, 1],
    ]);
    const applied = applyRelativeRankOverrides(roster, overrides);
    expect(applied.find((p) => p.id === 1)?.playerCurrentRank).toBe(2);
    expect(applied.find((p) => p.id === 2)?.playerCurrentRank).toBe(1);
    expect(applied.find((p) => p.id === 3)?.playerCurrentRank).toBe(7);
  });

  it("prunes overrides for players no longer on roster", () => {
    const pruned = pruneRelativeRankOverrides(
      new Map([
        [1, 1],
        [99, 2],
      ]),
      roster,
    );
    expect(pruned.size).toBe(1);
    expect(pruned.get(1)).toBe(1);
  });

  it("reorders draft roster by playerCurrentRank", () => {
    const next = reorderPlayerWithinBoxByCurrentRank(roster, 1, "down");
    expect(next?.find((p) => p.id === 1)?.playerCurrentRank).toBe(2);
    expect(next?.find((p) => p.id === 2)?.playerCurrentRank).toBe(1);
  });

  it("sanitizes overrides for returning players and non-vacant seats", () => {
    const gt = [7, 8, 9, 10, 11, 12].map((r, i) => ({
      id: 200 + i,
      level: 2,
      playerCurrentRank: r,
    }));
    const live = [
      ...gt.filter((p) => p.id !== 200 && p.id !== 201),
      { id: 999, level: 2, playerCurrentRank: 13 },
    ];
    const dirty = new Map([
      [202, 2],
      [203, 3],
      [999, 3],
    ]);
    expect(sanitizeSeatOverridesForGroundTruth(live, gt, dirty).size).toBe(0);
    expect(
      sanitizeSeatOverridesForGroundTruth(live, gt, new Map([[999, 1]])).get(
        999,
      ),
    ).toBe(1);
  });

  it("assigns new players only to vacated season-start seats", () => {
    const gt = [7, 8, 9, 10, 11, 12].map((r, i) => ({
      id: 200 + i,
      level: 2,
      playerCurrentRank: r,
    }));
    const live = [
      ...gt.filter((p) => p.id !== 200 && p.id !== 201),
      { id: 999, level: 2, playerCurrentRank: 13 },
    ];
    const overrides = new Map<number, number>();
    const placed = reorderRelativeRankInBox(
      live,
      overrides,
      999,
      "up",
      gt,
    );
    expect(placed?.get(999)).toBe(1);
    const movedDown = reorderRelativeRankInBox(live, placed!, 999, "down", gt);
    expect(movedDown?.get(999)).toBe(2);
    expect(
      reorderRelativeRankInBox(live, movedDown!, 999, "down", gt)?.has(999),
    ).toBe(false);
    expect(reorderRelativeRankInBox(live, overrides, 202, "up", gt)).toBeNull();
  });
});
