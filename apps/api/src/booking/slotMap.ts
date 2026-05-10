import { bulkHoldSlotsForWeekday } from "@squash/shared";

const mondayByLabel = Object.fromEntries(
  bulkHoldSlotsForWeekday("mon").map((r) => [r.slotLabel, r]),
);
const tuesdayByLabel = Object.fromEntries(
  bulkHoldSlotsForWeekday("tue").map((r) => [r.slotLabel, r]),
);

export function slotLabelToWindow(slotLabel: string): {
  begin: string;
  end: string;
  day: "mon" | "tue";
} {
  const m = mondayByLabel[slotLabel];
  if (m) {
    return { begin: m.begin, end: m.end, day: "mon" };
  }
  const t = tuesdayByLabel[slotLabel];
  if (t) {
    return { begin: t.begin, end: t.end, day: "tue" };
  }
  throw new Error(`Unknown slot label: ${slotLabel}`);
}

/**
 * For reservation API `slot: "11:50-12:30"` (begin-begin style used by Club Locker)
 */
export function formatReservationSlot(
  begin: string,
  end: string,
): string {
  return `${begin}-${end}`;
}

/**
 * All Mon (or Tue) slot×court pairs for one play date — used for a single recurring-clinic
 * run (entire season for that weekday) or for partitioning reservation ids.
 */
export function allBulkSlotsForSingleDay(
  playDate: string,
  day: "mon" | "tue",
  court1Id: number,
  court2Id: number,
): { playDate: string; begin: string; end: string; courtId: number }[] {
  const out: {
    playDate: string;
    begin: string;
    end: string;
    courtId: number;
  }[] = [];
  for (const row of bulkHoldSlotsForWeekday(day)) {
    for (const court of [1, 2] as const) {
      out.push({
        playDate,
        begin: row.begin,
        end: row.end,
        courtId: court === 1 ? court1Id : court2Id,
      });
    }
  }
  return out;
}

/**
 * One court only (8 slots) — for separate Club Locker `clinics` calls per court.
 */
export function singleCourtSlotsForDay(
  playDate: string,
  day: "mon" | "tue",
  courtId: number,
): { playDate: string; begin: string; end: string; courtId: number }[] {
  return bulkHoldSlotsForWeekday(day).map((row) => ({
    playDate,
    begin: row.begin,
    end: row.end,
    courtId,
  }));
}

/**
 * All Mon/Tue slot-court pairs for bulk clinic blocking: 8×2 on Monday + 8×2 on Tuesday = 32.
 */
export function allBulkSlotCourts(
  mondayDate: string,
  tuesdayDate: string,
  court1Id: number,
  court2Id: number,
): {
  playDate: string;
  begin: string;
  end: string;
  courtId: number;
}[] {
  return [
    ...allBulkSlotsForSingleDay(mondayDate, "mon", court1Id, court2Id),
    ...allBulkSlotsForSingleDay(tuesdayDate, "tue", court1Id, court2Id),
  ];
}
