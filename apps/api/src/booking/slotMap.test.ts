import { describe, expect, it } from "vitest";
import {
  allBulkSlotCourts,
  allBulkSlotsForSingleDay,
  formatReservationSlot,
  slotLabelToWindow,
} from "./slotMap.js";

describe("slotLabelToWindow", () => {
  it("maps first Monday slot", () => {
    const w = slotLabelToWindow("Mon4:30");
    expect(w.day).toBe("mon");
    expect(w.begin).toBe("16:30");
    expect(w.end).toBe("17:10");
  });

  it("maps first Tuesday lunch slot", () => {
    const w = slotLabelToWindow("Tue 4:30");
    expect(w.day).toBe("tue");
    expect(w.begin).toBe("11:50");
    expect(w.end).toBe("12:30");
  });
});

describe("formatReservationSlot", () => {
  it("joins begin and end", () => {
    expect(formatReservationSlot("11:50", "12:30")).toBe("11:50-12:30");
  });
});

describe("allBulkSlotCourts", () => {
  it("returns 32 entries for mon+tue", () => {
    const rows = allBulkSlotCourts("2026-04-19", "2026-04-20", 3510, 3512);
    expect(rows.length).toBe(32);
    expect(rows[0]!.playDate).toBe("2026-04-19");
    expect(rows[16]!.playDate).toBe("2026-04-20");
  });
});

describe("allBulkSlotsForSingleDay", () => {
  it("returns 16 entries for a Monday with two courts", () => {
    const m = allBulkSlotsForSingleDay("2026-10-05", "mon", 3510, 3512);
    expect(m.length).toBe(16);
    const t = allBulkSlotsForSingleDay("2026-10-06", "tue", 3510, 3512);
    expect(t.length).toBe(16);
  });
});
