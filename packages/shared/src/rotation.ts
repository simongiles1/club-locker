/**
 * Six-player box weekly rotation per PRD:
 * Week 1: positions 1v2, 3v4;5 & 6 bye. Each subsequent week the ordered list
 * rotates left by one (shift +1), then the same pairing pattern applies.
 */
export type WeekMatchup = {
  week: number;
  /** Pairs of seat numbers (1–6) playing this week */
  matches: [number, number][];
  /** Seat numbers on bye */
  byes: [number, number];
};

export function getRotatedOrder(week: number): number[] {
  if (week < 1) throw new Error("week must be >= 1");
  const shift = week - 1;
  return Array.from({ length: 6 }, (_, i) => ((i + shift) % 6) + 1);
}

export function getWeekMatchups(week: number): WeekMatchup {
  const order = getRotatedOrder(week);
  return {
    week,
    matches: [
      [order[0], order[1]],
      [order[2], order[3]],
    ],
    byes: [order[4], order[5]],
  };
}

/**
 * Stable slot keys matched to clock windows in `bulkSlotWindows.ts`.
 * Tuesday repeats the Monday *label numbering* (“4:30”, “5:10”, …): the first three are
 * lunchtime; the remaining five are Tuesday evening courts.
 */
export const DEFAULT_MONDAY_SLOTS = [
  "Mon4:30",
  "Mon 5:10",
  "Mon 5:50",
  "Mon 6:30",
  "Mon 7:10",
  "Mon 7:50",
  "Mon 8:30",
  "Mon 9:10",
] as const;

export const DEFAULT_TUESDAY_SLOTS = [
  "Tue 4:30",
  "Tue 5:10",
  "Tue 5:50",
  "Tue 6:30",
  "Tue 7:10",
  "Tue 7:50",
  "Tue 8:30",
  "Tue 9:10",
] as const;

export type CourtAssignment = {
  match: [number, number];
  court: 1 | 2;
  slotLabel: string;
};

/**
 * Assign matches to courts across Mon/Tue slots (2 courts × 8 slots each = 32 slots/day).
 * Fills Monday first, then Tuesday, alternating courts1 and 2 within a slot.
 */
export function assignManagedCourts(
  matches: [number, number][],
  mondaySlots: readonly string[] = DEFAULT_MONDAY_SLOTS,
  tuesdaySlots: readonly string[] = DEFAULT_TUESDAY_SLOTS,
): CourtAssignment[] {
  const slots: { label: string; courts: [1, 2] }[] = [];
  for (const label of mondaySlots) {
    slots.push({ label, courts: [1, 2] });
  }
  for (const label of tuesdaySlots) {
    slots.push({ label, courts: [1, 2] });
  }
  const out: CourtAssignment[] = [];
  let idx = 0;
  for (const slot of slots) {
    for (const court of slot.courts) {
      if (idx >= matches.length) return out;
      out.push({ match: matches[idx], court: court as 1 | 2, slotLabel: slot.label });
      idx++;
    }
  }
  return out;
}
