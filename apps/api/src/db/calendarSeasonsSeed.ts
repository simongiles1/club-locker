import {
  BOOKING_CALENDAR_SEASONS,
  bookingCalendarSeasonLabel,
  defaultBookingSeasonAndStartMonday,
  formatLocalISODate,
  seasonStartMondayLocal,
} from "@squash/shared";
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { seasons } from "./schema.js";

/** Insert any missing calendar-segment rows for this club year (idempotent). */
export function insertMissingCalendarYearSeasons(
  db: Db,
  clubYear: number,
  status = "registration",
): void {
  const forYear = db
    .select()
    .from(seasons)
    .where(eq(seasons.clubYear, clubYear))
    .all();
  for (const seg of BOOKING_CALENDAR_SEASONS) {
    if (forYear.some((r) => r.calendarSegment === seg)) continue;
    const iso = formatLocalISODate(seasonStartMondayLocal(seg, clubYear));
    db.insert(seasons)
      .values({
        id: crypto.randomUUID(),
        name: `${bookingCalendarSeasonLabel(seg)} ${clubYear}`,
        clubYear,
        calendarSegment: seg,
        startMondayDate: iso,
        status,
      })
      .run();
  }
}

/** @deprecated Use insertMissingCalendarYearSeasons — name kept for clarity at call sites */
export function insertCalendarYearSeasons(
  db: Db,
  clubYear: number,
  status = "registration",
): void {
  insertMissingCalendarYearSeasons(db, clubYear, status);
}

/**
 * Ensures four calendar seasons exist for the default booking club year (local rules),
 * and replaces legacy season rows that have no calendar_segment.
 */
export function ensureCalendarSeasonRows(db: Db): void {
  const clubYear = defaultBookingSeasonAndStartMonday().clubYear;
  const all = db.select().from(seasons).all();
  const legacyOnly =
    all.length > 0 && all.every((r) => r.calendarSegment == null);
  if (legacyOnly) {
    for (const r of all) {
      db.delete(seasons).where(eq(seasons.id, r.id)).run();
    }
    insertMissingCalendarYearSeasons(db, clubYear);
    return;
  }

  insertMissingCalendarYearSeasons(db, clubYear);
}
