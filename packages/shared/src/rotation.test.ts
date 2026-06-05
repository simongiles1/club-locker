import { describe, expect, it } from "vitest";
import {
  assignManagedCourts,
  formatMatchPair,
  formatWeekMatchupsDisplay,
  getWeekMatchups,
  REGULAR_SEASON_WEEK_MATCHUPS,
} from "./rotation.js";

describe("rotation", () => {
  it("week 1 matches 1v2, 3v4, 5&6 bye", () => {
    const m = getWeekMatchups(1);
    expect(m.matches).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(m.byes).toEqual([5, 6]);
  });

  it("week 2 matches 4v6, 2v5, 1&3 bye", () => {
    const m = getWeekMatchups(2);
    expect(m.matches).toEqual([
      [4, 6],
      [2, 5],
    ]);
    expect(m.byes).toEqual([1, 3]);
    expect(formatWeekMatchupsDisplay(2)).toBe("4 v 6, 2 v 5");
  });

  it("formatMatchPair always lists lower seat first", () => {
    expect(formatMatchPair([5, 2])).toBe("2 v 5");
    expect(formatMatchPair([2, 5])).toBe("2 v 5");
  });

  it("covers seven regular season weeks", () => {
    expect(REGULAR_SEASON_WEEK_MATCHUPS).toHaveLength(7);
    for (let w = 1; w <= 7; w++) {
      expect(() => getWeekMatchups(w)).not.toThrow();
    }
  });

  it("assignManagedCourts fills Mon then Tue", () => {
    const mon = ["M1", "M2"];
    const tue = ["T1"];
    const a = assignManagedCourts(
      [
        [1, 2],
        [3, 4],
        [5, 6],
        [1, 3],
      ],
      mon,
      tue,
    );
    expect(a[0]).toMatchObject({ match: [1, 2], court: 1, slotLabel: "M1" });
    expect(a[1]).toMatchObject({ match: [3, 4], court: 2, slotLabel: "M1" });
    expect(a[2]).toMatchObject({ match: [5, 6], court: 1, slotLabel: "M2" });
    expect(a[3]).toMatchObject({ match: [1, 3], court: 2, slotLabel: "M2" });
  });
});
