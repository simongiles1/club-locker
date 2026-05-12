/**
 * YYYY-MM-DD in the server's local timezone (matches other date literals in this app).
 */
export function calendarDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * When reminders go out today, scheduled matches occur this many calendar days later
 * (`daysBefore` in settings = lead time prior to {@link playDate}).
 */
export function playDateAlignedWithReminderDay(daysBefore: number, reminderDay: Date): string {
  const anchor = new Date(reminderDay);
  anchor.setHours(12, 0, 0, 0);
  anchor.setDate(anchor.getDate() + Math.max(0, daysBefore));
  return calendarDateLocal(anchor);
}

export function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
