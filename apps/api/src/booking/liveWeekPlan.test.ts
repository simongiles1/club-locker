import { describe, expect, it } from "vitest";
import {
  buildLiveWeekPlan,
  liveWeekPlanResolvable,
  type LiveBoxLeaguePlayer,
} from "./liveWeekPlan.js";

function rosterForManagedBoxes(): LiveBoxLeaguePlayer[] {
  const out: LiveBoxLeaguePlayer[] = [];
  for (let box = 1; box <= 16; box++) {
    const baseRank = (box - 1) * 6;
    for (let seat = 1; seat <= 6; seat++) {
      out.push({
        id: 100_000 + baseRank + seat,
        firstName: "Box",
        lastName: `${box}-S${seat}`,
        level: box,
        playerCurrentRank: baseRank + seat,
        rating: 4,
      });
    }
  }
  return out;
}

describe("buildLiveWeekPlan", () => {
  it("builds two matches per grid slot for week 1 using live roster", () => {
    const roster = rosterForManagedBoxes();
    const result = buildLiveWeekPlan(
      1,
      roster,
      "2026-06-01",
      "2026-06-02",
      10_706,
      3510,
      3512,
      460,
    );
    expect(liveWeekPlanResolvable(result)).toBe(true);
    expect(result.issues).toHaveLength(0);
    // 8 Mon slots + 8 Tue slots × 2 courts = 32 reservations
    expect(result.items).toHaveLength(32);
    expect(result.items[0]!.body.MatchProperties).toEqual({
      restrictJoinByRating: false,
      matchType: 1,
      customMatchType: 460,
    });
    expect(result.items[0]!.body.players[0]).toMatchObject({ id: 100_001 });
    expect(result.payload.boxes.length).toBeGreaterThan(0);
    expect(result.payload.boxes[0]!.matchups[0]).toEqual([
      "ussquash:100001",
      "ussquash:100002",
    ]);
  });

  it("Tuesday box 9 uses US Squash level 9 roster, not level 1", () => {
    const roster = rosterForManagedBoxes();
    const result = buildLiveWeekPlan(
      1,
      roster,
      "2026-06-01",
      "2026-06-02",
      10_706,
      3510,
      3512,
      460,
    );
    const monBox1 = result.items.find(
      (it) => it.playDate === "2026-06-01" && it.boxNumber === 1,
    );
    const tueBox9 = result.items.find(
      (it) => it.playDate === "2026-06-02" && it.boxNumber === 9,
    );
    expect(monBox1).toBeDefined();
    expect(tueBox9).toBeDefined();
    expect(monBox1!.ussquashPlayerIds[0]).toBe(100_001);
    expect(tueBox9!.ussquashPlayerIds[0]).toBe(100_049);
    expect(tueBox9!.ussquashPlayerIds[0]).not.toBe(monBox1!.ussquashPlayerIds[0]);
  });

  it("week 2 box 9 still books 4v6 when only schedule seat 3 is vacant", () => {
    const roster = rosterForManagedBoxes();
    const liveRoster = roster.filter(
      (p) => !(p.level === 9 && p.playerCurrentRank === 51),
    );
    const result = buildLiveWeekPlan(
      2,
      liveRoster,
      "2026-06-08",
      "2026-06-09",
      10_706,
      3510,
      3512,
      460,
      roster,
    );
    const stadium4v6 = result.items.find(
      (it) =>
        it.boxNumber === 9 &&
        it.playDate === "2026-06-09" &&
        it.courtId === 3510 &&
        it.slot === "12:30-13:10",
    );
    expect(stadium4v6).toBeDefined();
  });

  it("reports missing seats when roster is incomplete", () => {
    const roster: LiveBoxLeaguePlayer[] = [
      {
        id: 1,
        firstName: "Only",
        lastName: "One",
        level: 1,
        playerCurrentRank: 1,
        rating: 4,
      },
    ];
    const result = buildLiveWeekPlan(
      1,
      roster,
      "2026-06-01",
      "2026-06-02",
      10_706,
      3510,
      3512,
      460,
    );
    expect(liveWeekPlanResolvable(result)).toBe(false);
    expect(result.items).toHaveLength(0);
  });
});
