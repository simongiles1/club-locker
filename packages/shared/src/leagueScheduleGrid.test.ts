import { describe, expect, it } from "vitest";
import {
  boxNumberForScheduleSlot,
  REGULAR_SEASON_BOX_LEVELS,
} from "./leagueScheduleGrid.js";

describe("leagueScheduleGrid", () => {
  it("matches Schedule.tsx week 1 Monday first slot", () => {
    expect(REGULAR_SEASON_BOX_LEVELS[0]![0]).toBe(1);
    expect(boxNumberForScheduleSlot(1, "mon", 0)).toBe(1);
    expect(boxNumberForScheduleSlot(1, "tue", 0)).toBe(9);
  });
});
