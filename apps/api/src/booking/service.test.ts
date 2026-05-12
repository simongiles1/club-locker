import { describe, expect, it } from "vitest";
import {
  bulkCancelWeekLabelPart,
  houseLeagueSeasonBulkClinicName,
  inferBulkHoldShape,
  reservationIdsForSeasonWeek,
} from "./service.js";

describe("houseLeagueSeasonBulkClinicName", () => {
  it("formats Summer House League Week 1", () => {
    expect(houseLeagueSeasonBulkClinicName("Summer", 1)).toBe(
      "Summer House League Week 1",
    );
  });
  it("uses dynamic week number", () => {
    expect(houseLeagueSeasonBulkClinicName("Winter", 8)).toBe(
      "Winter House League Semis",
    );
  });
});

describe("bulkCancelWeekLabelPart", () => {
  it("uses Semis for canonical semi-finals week", () => {
    expect(bulkCancelWeekLabelPart(8)).toBe("Semis");
  });
  it("uses Week n for other weeks", () => {
    expect(bulkCancelWeekLabelPart(1)).toBe("Week 1");
    expect(bulkCancelWeekLabelPart(7)).toBe("Week 7");
  });
});

describe("inferBulkHoldShape", () => {
  const mon16 = Array.from({ length: 16 }, (_, i) => `m-${i}`);
  const tue16 = Array.from({ length: 16 }, (_, i) => `t-${i}`);

  it("with declared 8 weeks, 16 ids per weekday is compact weekly (two ids × 8 weeks), not one full week", () => {
    expect(inferBulkHoldShape(mon16, tue16, 8)).toEqual({
      kind: "compact_weekly",
      weeks: 8,
    });
  });

  it("with declared 1 week, 16 ids per weekday stays full layout", () => {
    expect(inferBulkHoldShape(mon16, tue16, 1)).toEqual({
      kind: "full",
      weeks: 1,
    });
  });

  it("without declared weeks, preserves legacy heuristic (16 ids → full 1)", () => {
    expect(inferBulkHoldShape(mon16, tue16)).toEqual({
      kind: "full",
      weeks: 1,
    });
  });

  it("pairs of length two are compact_series when declared weeks ≠ row length", () => {
    expect(inferBulkHoldShape(["a", "b"], ["c", "d"], 8)).toEqual({
      kind: "compact_series",
    });
  });

  it("when declared weeks equals id count per weekday, uses combined clinic per week shape", () => {
    expect(inferBulkHoldShape(["a", "b"], ["c", "d"], 2)).toEqual({
      kind: "combined_clinic_per_week",
      weeks: 2,
    });
  });
});

describe("reservationIdsForSeasonWeek", () => {
  it("slices 32 ids for week 1 of an 8-week season (16+16 per week)", () => {
    const mon: string[] = [];
    const tue: string[] = [];
    for (let w = 0; w < 8; w++) {
      for (let s = 0; s < 16; s++) {
        mon.push(`m-w${w + 1}-s${s}`);
        tue.push(`t-w${w + 1}-s${s}`);
      }
    }
    const w1 = reservationIdsForSeasonWeek(mon, tue, 1, 8);
    expect(w1).toHaveLength(32);
    expect(w1[0]).toBe("m-w1-s0");
    expect(w1[16]).toBe("t-w1-s0");
    const w3 = reservationIdsForSeasonWeek(mon, tue, 3, 8);
    expect(w3[0]).toBe("m-w3-s0");
  });

  it("returns Mon+Tue clinic ids for one week when hold stores one id per play day per week", () => {
    const mon = ["m1", "m2", "m3"];
    const tue = ["t1", "t2", "t3"];
    expect(reservationIdsForSeasonWeek(mon, tue, 2, 3)).toEqual(["m2", "t2"]);
  });
});

