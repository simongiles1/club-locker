import { describe, expect, it } from "vitest";
import { reservationIdsForSeasonWeek } from "./service.js";

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
});
