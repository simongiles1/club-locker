/**
 * Club booking “calendar seasons” and their first-Monday start dates (local timezone).
 *
 * - Winter: first Monday on or after 4 January (i.e. strictly after 3 January).
 * - Spring: first Monday in April, except when 31 March is Monday → that Monday.
 * - Summer: first Monday in June, except when 31 May is Monday → that Monday.
 * - Fall: first Monday on or after 1 October.
 */

export type BookingCalendarSeason = "winter" | "spring" | "summer" | "fall";

export const BOOKING_CALENDAR_SEASONS: readonly BookingCalendarSeason[] = [
  "winter",
  "spring",
  "summer",
  "fall",
] as const;

function addDaysLocal(d: Date, days: number): Date {
  const n = new Date(d.getTime());
  n.setDate(n.getDate() + days);
  return n;
}

/** First Monday on or after the given calendar day (local). */
export function firstMondayOnOrAfterLocal(
  year: number,
  monthIndex: number,
  day: number,
): Date {
  const start = new Date(year, monthIndex, day);
  const dow = start.getDay();
  const monOffset = (8 - dow) % 7;
  return addDaysLocal(start, monOffset);
}

export function winterStartMondayLocal(year: number): Date {
  return firstMondayOnOrAfterLocal(year, 0, 4);
}

export function springStartMondayLocal(year: number): Date {
  const mar31 = new Date(year, 2, 31);
  if (mar31.getDay() === 1) return mar31;
  return firstMondayOnOrAfterLocal(year, 3, 1);
}

export function summerStartMondayLocal(year: number): Date {
  const may31 = new Date(year, 4, 31);
  if (may31.getDay() === 1) return may31;
  return firstMondayOnOrAfterLocal(year, 5, 1);
}

export function fallStartMondayLocal(year: number): Date {
  return firstMondayOnOrAfterLocal(year, 9, 1);
}

export function seasonStartMondayLocal(
  season: BookingCalendarSeason,
  year: number,
): Date {
  switch (season) {
    case "winter":
      return winterStartMondayLocal(year);
    case "spring":
      return springStartMondayLocal(year);
    case "summer":
      return summerStartMondayLocal(year);
    case "fall":
      return fallStartMondayLocal(year);
  }
}

export function formatLocalISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfLocalCalendarDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Day count from a to b using calendar dates in the local timezone (b may precede a). */
export function calendarDaysFromTo(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86400000);
}

/**
 * Booking “club year” Y: interval [Winter start Y, Winter start Y+1).
 */
export function bookingClubYearContainingDate(d: Date): number {
  const day = startOfLocalCalendarDay(d);
  const y = day.getFullYear();
  const wThis = winterStartMondayLocal(y);
  if (day < wThis) return y - 1;
  return y;
}

function seasonContainingDateInClubYear(
  Y: number,
  day: Date,
): BookingCalendarSeason {
  const W = winterStartMondayLocal(Y);
  const Sp = springStartMondayLocal(Y);
  const Su = summerStartMondayLocal(Y);
  const F = fallStartMondayLocal(Y);
  const Wn = winterStartMondayLocal(Y + 1);
  if (day >= W && day < Sp) return "winter";
  if (day >= Sp && day < Su) return "spring";
  if (day >= Su && day < F) return "summer";
  if (day >= F && day < Wn) return "fall";
  // Defensive fallback (should not happen when Y = bookingClubYearContainingDate(day))
  return "fall";
}

function nextSeasonStartAfter(
  Y: number,
  current: BookingCalendarSeason,
): Date {
  switch (current) {
    case "winter":
      return springStartMondayLocal(Y);
    case "spring":
      return summerStartMondayLocal(Y);
    case "summer":
      return fallStartMondayLocal(Y);
    case "fall":
      return winterStartMondayLocal(Y + 1);
  }
}

function nextSeasonKey(current: BookingCalendarSeason): BookingCalendarSeason {
  switch (current) {
    case "winter":
      return "spring";
    case "spring":
      return "summer";
    case "summer":
      return "fall";
    case "fall":
      return "winter";
  }
}

function seasonStartForClubYearOrNextWinter(
  season: BookingCalendarSeason,
  clubYear: number,
): Date {
  if (season === "winter") return winterStartMondayLocal(clubYear + 1);
  return seasonStartMondayLocal(season, clubYear);
}

/**
 * Season start Monday for a dropdown selection within a fixed club year
 * (Winter is always Winter Y — the start of that club year).
 */
export function seasonStartMondayForClubYearDropdown(
  season: BookingCalendarSeason,
  clubYear: number,
): Date {
  return seasonStartMondayLocal(season, clubYear);
}

const FOUR_WEEKS_DAYS = 28;

export type DefaultBookingSeasonResult = {
  season: BookingCalendarSeason;
  /** YYYY-MM-DD for the first Monday of that season instance. */
  startMondayISO: string;
  clubYear: number;
};

/**
 * Default season and its first Monday, using:
 * - “current” season from calendar intervals, then
 * - if more than 28 days before the next season start → stay on current season;
 *   otherwise → use the upcoming (next) season.
 */
export function defaultBookingSeasonAndStartMonday(
  now: Date = new Date(),
): DefaultBookingSeasonResult {
  const today = startOfLocalCalendarDay(now);
  const Y = bookingClubYearContainingDate(today);
  const currentSeason = seasonContainingDateInClubYear(Y, today);
  const nextStart = nextSeasonStartAfter(Y, currentSeason);
  const daysUntilNext = calendarDaysFromTo(today, nextStart);

  if (daysUntilNext > FOUR_WEEKS_DAYS) {
    const d = seasonStartMondayLocal(currentSeason, Y);
    return {
      season: currentSeason,
      startMondayISO: formatLocalISODate(d),
      clubYear: bookingClubYearContainingDate(d),
    };
  }

  const nextKey = nextSeasonKey(currentSeason);
  const d = seasonStartForClubYearOrNextWinter(nextKey, Y);
  return {
    season: nextKey,
    startMondayISO: formatLocalISODate(d),
    clubYear: bookingClubYearContainingDate(d),
  };
}

/**
 * The booking segment whose interval contains the local calendar date `startMondayISO`
 * (interpreted around local noon), paired with its club-booking year. Used when persisting season rows from a picked start Monday.
 */
export function bookingCalendarClubYearSegmentForMondayISO(
  startMondayISO: string,
): { segment: BookingCalendarSeason; clubYear: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startMondayISO.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const monthIdx = Number(m[2]) - 1;
  const dom = Number(m[3]);
  if (
    !Number.isFinite(year) ||
    monthIdx < 0 ||
    monthIdx > 11 ||
    dom < 1 ||
    dom > 31
  ) {
    return null;
  }
  const day = new Date(year, monthIdx, dom, 12, 0, 0, 0);
  if (Number.isNaN(day.getTime())) return null;
  const Y = bookingClubYearContainingDate(day);
  return {
    segment: seasonContainingDateInClubYear(Y, day),
    clubYear: Y,
  };
}

/**
 * Next booking calendar segment strictly after `currentSegment` within club-booking `clubYear`,
 * and that segment instance’s start Monday ISO (Winter rolls into the next club-booking cycle).
 */
export function bookingSeasonImmediatelyFollowing(
  currentSegment: BookingCalendarSeason,
  clubBookingYear: number,
): DefaultBookingSeasonResult {
  const nextKey = nextSeasonKey(currentSegment);
  const d = seasonStartForClubYearOrNextWinter(nextKey, clubBookingYear);
  const day = startOfLocalCalendarDay(d);
  return {
    season: nextKey,
    startMondayISO: formatLocalISODate(d),
    clubYear: bookingClubYearContainingDate(day),
  };
}

export function bookingCalendarSeasonLabel(s: BookingCalendarSeason): string {
  switch (s) {
    case "winter":
      return "Winter";
    case "spring":
      return "Spring";
    case "summer":
      return "Summer";
    case "fall":
      return "Fall";
  }
}

/** First `YYYY-MM-DD` in `iso` interpreted as that local calendar day (for DB `end_date` / timestamps). */
function parseIsoPrefixToLocalCalendarDay(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d))
    return null;
  const result = new Date(y, mo - 1, d);
  return Number.isNaN(result.getTime()) ? null : startOfLocalCalendarDay(result);
}

/**
 * Whether a club-booking segment row should be treated as active for roster maintenance:
 * today is within [segmentStart, nextSegmentStart), using local calendar dates, unless an
 * explicit `explicitSeasonEndDate` is set — then today must be ≥ segmentStart and ≤ that
 * inclusive end calendar day (typical `seasons.end_date` / US Squash end timestamp).
 */
export function isBookingCalendarSegmentLocallyActive(args: {
  segment: BookingCalendarSeason;
  clubYear: number;
  now?: Date;
  explicitSeasonEndDate?: string | null;
}): boolean {
  const now = args.now ?? new Date();
  const today = startOfLocalCalendarDay(now);
  const segmentStart = startOfLocalCalendarDay(
    seasonStartMondayLocal(args.segment, args.clubYear),
  );
  if (today < segmentStart) return false;

  const rawEnd = args.explicitSeasonEndDate;
  if (rawEnd != null && String(rawEnd).trim() !== "") {
    const explicitDay = parseIsoPrefixToLocalCalendarDay(String(rawEnd));
    if (explicitDay != null) return today <= explicitDay;
  }

  const nextStart = startOfLocalCalendarDay(
    nextSeasonStartAfter(args.clubYear, args.segment),
  );
  return today < nextStart;
}

/**
 * Live US Squash house league roster edits: editable while local calendar “today” is on or
 * before the league event’s advertised `endDate` (YYYY-MM-DD prefix — same convention as UI).
 * Preparation before opening day is allowed unless `enforceStart` is true.
 */
export function isUsSquashBoxLeagueRosterLocallyEditable(args: {
  now?: Date;
  eventStartISO?: string | null;
  eventEndISO?: string | null;
  enforceStart?: boolean;
}): boolean {
  const today = startOfLocalCalendarDay(args.now ?? new Date());
  const endRaw = args.eventEndISO;
  if (endRaw == null || String(endRaw).trim() === "") return false;
  const endDay = parseIsoPrefixToLocalCalendarDay(String(endRaw));
  if (endDay == null) return false;
  if (today > endDay) return false;

  if (args.enforceStart === true) {
    const st = args.eventStartISO;
    if (st != null && String(st).trim() !== "") {
      const startDay = parseIsoPrefixToLocalCalendarDay(String(st));
      if (startDay != null && today < startDay) return false;
    }
  }
  return true;
}
