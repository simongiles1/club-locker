/**
 * Box rotation per regular-season week (Mondays = boxes 1–8, Tuesdays = 9–16 in the same order).
 * Mirrors the grid in the House League Schedule UI.
 */
export const REGULAR_SEASON_BOX_LEVELS: readonly (readonly number[])[] = [
  [1, 2, 3, 4, 5, 6, 7, 8],
  [8, 1, 2, 3, 4, 5, 6, 7],
  [7, 8, 1, 2, 3, 4, 5, 6],
  [6, 7, 8, 1, 2, 3, 4, 5],
  [5, 6, 7, 8, 1, 2, 3, 4],
  [4, 5, 6, 7, 8, 1, 2, 3],
  [3, 4, 5, 6, 7, 8, 1, 2],
];

export const REGULAR_SEASON_GRID_WEEKS = REGULAR_SEASON_BOX_LEVELS.length;

/** Managed house-league boxes booked by the service (boxes 17+ are self-managed). */
export const MANAGED_BOX_NUMBER_MAX = 16;

/** Slot index 0–7 on Monday or Tuesday for a regular-season week (1–7). */
export function boxLevelForScheduleSlot(
  week: number,
  slotIndex: number,
): number | null {
  if (week < 1 || week > REGULAR_SEASON_GRID_WEEKS) return null;
  if (slotIndex < 0 || slotIndex >= 8) return null;
  return REGULAR_SEASON_BOX_LEVELS[week - 1]![slotIndex] ?? null;
}

/** Box number on the calendar grid (Tue adds 8). */
export function boxNumberForScheduleSlot(
  week: number,
  day: "mon" | "tue",
  slotIndex: number,
): number | null {
  const level = boxLevelForScheduleSlot(week, slotIndex);
  if (level == null) return null;
  return day === "tue" ? level + 8 : level;
}
