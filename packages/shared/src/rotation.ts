/**
 * Six-player box weekly schedule: seven regular-season weeks, two courts per week.
 * Pairings are fixed (not derived from a positional rotation); the one pairing
 * omitted across the season is 1 v 6.
 */
export type WeekMatchup = {
  week: number;
  /** Pairs of seat numbers (1–6) playing this week */
  matches: [number, number][];
  /** Seat numbers on bye */
  byes: [number, number];
};

/** Canonical regular-season matchups and byes (weeks 1–7). */
export const REGULAR_SEASON_WEEK_MATCHUPS: readonly {
  matches: readonly [readonly [number, number], readonly [number, number]];
  byes: readonly [number, number];
}[] = [
  { matches: [[1, 2], [3, 4]], byes: [5, 6] },
  { matches: [[4, 6], [2, 5]], byes: [1, 3] },
  { matches: [[1, 5], [3, 6]], byes: [2, 4] },
  { matches: [[1, 4], [2, 6]], byes: [3, 5] },
  { matches: [[2, 3], [4, 5]], byes: [1, 6] },
  { matches: [[1, 3], [5, 6]], byes: [2, 4] },
  { matches: [[3, 5], [2, 4]], byes: [1, 6] },
];

export const REGULAR_SEASON_WEEKS = REGULAR_SEASON_WEEK_MATCHUPS.length;

export function formatMatchPair(pair: [number, number]): string {
  const [a, b] = pair;
  return a < b ? `${a} v ${b}` : `${b} v ${a}`;
}

export function formatCompactMatchPair(pair: [number, number]): string {
  const [a, b] = pair;
  return a < b ? `${a}v${b}` : `${b}v${a}`;
}

export function formatWeekMatchupsDisplay(week: number): string {
  const w = getWeekMatchups(week);
  return w.matches.map((m) => formatMatchPair(m)).join(", ");
}

export function formatWeekByesDisplay(week: number): string {
  const w = getWeekMatchups(week);
  return `${w.byes.join(", ")} BYE`;
}

export function getWeekMatchups(week: number): WeekMatchup {
  const idx = week - 1;
  if (idx < 0 || idx >= REGULAR_SEASON_WEEK_MATCHUPS.length) {
    throw new Error(`week must be 1–${REGULAR_SEASON_WEEK_MATCHUPS.length}`);
  }
  const row = REGULAR_SEASON_WEEK_MATCHUPS[idx]!;
  return {
    week,
    matches: [
      [row.matches[0][0], row.matches[0][1]],
      [row.matches[1][0], row.matches[1][1]],
    ],
    byes: [row.byes[0], row.byes[1]],
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
