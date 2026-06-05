/** Calendar chip for a converted-week time row (both courts share one block). */
export function rosterImpactCalendarChipKey(
  weekNumber: number,
  playDate: string,
  timeBegin: string,
  timeEnd: string,
  boxNumber: number,
): string {
  return `${weekNumber}|${playDate}|${timeBegin}-${timeEnd}|${boxNumber}`;
}

/** One managed court reservation (matches API `CourtImpactRow` identity). */
export function rosterImpactCourtSlotKey(parts: {
  weekNumber: number;
  playDate: string;
  slot: string;
  courtId: number;
  boxNumber: number;
}): string {
  return `${parts.weekNumber}|${parts.playDate}|${parts.slot}|${parts.courtId}|${parts.boxNumber}`;
}

/** Parse reservation slot `HH:MM-HH:MM` into begin/end for calendar matching. */
export function parseReservationSlotWindow(
  slot: string,
): { begin: string; end: string } | null {
  const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(slot.trim());
  if (!m) return null;
  return { begin: m[1]!, end: m[2]! };
}
