import { describe, expect, it } from "vitest";
import { assignManagedCourts, getRotatedOrder, getWeekMatchups } from "./rotation.js";

describe("rotation", () => {
  it("week 1 matches PRD 1v2, 3v4, 5&6 bye", () => {
    const m = getWeekMatchups(1);
    expect(m.matches).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(m.byes).toEqual([5, 6]);
  });

  it("week 2 rotates left: 2v3, 4v5, 6&1 bye", () => {
    expect(getRotatedOrder(2)).toEqual([2, 3, 4, 5, 6, 1]);
    const m = getWeekMatchups(2);
    expect(m.matches).toEqual([
      [2, 3],
      [4, 5],
    ]);
    expect(m.byes).toEqual([6, 1]);
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
