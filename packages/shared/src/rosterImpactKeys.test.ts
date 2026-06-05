import { describe, expect, it } from "vitest";
import {
  parseReservationSlotWindow,
  rosterImpactCalendarChipKey,
} from "./rosterImpactKeys.js";

describe("rosterImpactKeys", () => {
  it("builds calendar chip keys from slot window", () => {
    expect(
      rosterImpactCalendarChipKey(2, "2026-06-09", "18:10", "18:50", 4),
    ).toBe("2|2026-06-09|18:10-18:50|4");
  });

  it("parses reservation slot strings", () => {
    expect(parseReservationSlotWindow("18:10-18:50")).toEqual({
      begin: "18:10",
      end: "18:50",
    });
  });
});
