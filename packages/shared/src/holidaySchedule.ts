export type StatHolidayHours = {
  open: string | null;
  close: string | null;
  closed: boolean;
};

export type StatHoliday = {
  name: string;
  date: string; // YYYY-MM-DD
  hours: StatHolidayHours;
};

function formatISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function parseISODateLocal(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`Invalid ISO date: ${s}`);
  return new Date(y, m - 1, d);
}

function addDaysISO(iso: string, days: number): string {
  const d = parseISODateLocal(iso);
  d.setDate(d.getDate() + days);
  return formatISODate(d);
}

function nthWeekdayOfMonth(
  year: number,
  monthIndex: number,
  weekday: number,
  occurrence: number,
): string {
  const first = new Date(year, monthIndex, 1);
  const shift = (7 + weekday - first.getDay()) % 7;
  return formatISODate(new Date(year, monthIndex, 1 + shift + (occurrence - 1) * 7));
}

function mondayBeforeMay25(year: number): string {
  const d = new Date(year, 4, 24); // latest possible Victoria Day
  while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
  return formatISODate(d);
}

function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=Mar, 4=Apr
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function goodFridayISO(year: number): string {
  const e = easterSunday(year);
  e.setDate(e.getDate() - 2);
  return formatISODate(e);
}

function fixedHoliday(
  name: string,
  date: string,
  open: string | null,
  close: string | null,
  closed = false,
): StatHoliday {
  return { name, date, hours: { open, close, closed } };
}

export function statutoryHolidaysForYear(year: number): StatHoliday[] {
  return [
    fixedHoliday("Family Day", nthWeekdayOfMonth(year, 1, 1, 3), "08:00", "18:00"),
    fixedHoliday("Good Friday", goodFridayISO(year), "08:00", "18:00"),
    fixedHoliday("Victoria Day", mondayBeforeMay25(year), "08:00", "18:00"),
    fixedHoliday("Canada Day", `${year}-07-01`, "08:00", "18:00"),
    fixedHoliday("August Long Weekend", nthWeekdayOfMonth(year, 7, 1, 1), "08:00", "18:00"),
    fixedHoliday("Labour Day", nthWeekdayOfMonth(year, 8, 1, 1), "08:00", "18:00"),
    fixedHoliday("Thanksgiving Monday", nthWeekdayOfMonth(year, 9, 1, 2), "08:00", "18:00"),
    fixedHoliday("Christmas Eve", `${year}-12-24`, "06:00", "15:00"),
    fixedHoliday("Christmas Day", `${year}-12-25`, null, null, true),
    fixedHoliday("Boxing Day", `${year}-12-26`, "08:00", "18:00"),
    fixedHoliday("New Year's Eve", `${year}-12-31`, "06:00", "15:00"),
    fixedHoliday("New Year's Day", `${year}-01-01`, null, null, true),
  ];
}

export function statHolidayForDate(isoDate: string): StatHoliday | null {
  const year = parseISODateLocal(isoDate).getFullYear();
  return statutoryHolidaysForYear(year).find((h) => h.date === isoDate) ?? null;
}

/** Resolve a holiday from a director-configured list (e.g. API), keyed by calendar date. */
export function statHolidayForDateInRegistry(
  isoDate: string,
  registry: readonly StatHoliday[],
): StatHoliday | null {
  return registry.find((h) => h.date === isoDate) ?? null;
}

export function isMondayStatHoliday(isoDate: string): boolean {
  const d = parseISODateLocal(isoDate);
  return d.getDay() === 1 && statHolidayForDate(isoDate) != null;
}

export function isMondayStatHolidayInRegistry(
  isoDate: string,
  registry: readonly StatHoliday[],
): boolean {
  const d = parseISODateLocal(isoDate);
  return d.getDay() === 1 && statHolidayForDateInRegistry(isoDate, registry) != null;
}

export function seasonWeekPlayDates(
  startMondayIso: string,
  weekNumber: number,
): {
  weekMonday: string;
  firstPlayDate: string;
  secondPlayDate: string;
  shiftedByHoliday: boolean;
  holidayName?: string;
} {
  const safeWeek = Math.max(1, weekNumber);
  const weekMonday = addDaysISO(startMondayIso, (safeWeek - 1) * 7);
  const holiday = statHolidayForDate(weekMonday);
  const shifted = holiday != null && isMondayStatHoliday(weekMonday);
  if (shifted) {
    return {
      weekMonday,
      firstPlayDate: addDaysISO(weekMonday, 1),
      secondPlayDate: addDaysISO(weekMonday, 2),
      shiftedByHoliday: true,
      holidayName: holiday.name,
    };
  }
  return {
    weekMonday,
    firstPlayDate: weekMonday,
    secondPlayDate: addDaysISO(weekMonday, 1),
    shiftedByHoliday: false,
  };
}

/** Like {@link seasonWeekPlayDates} but uses `registry` instead of built-in statutory dates. */
export function seasonWeekPlayDatesWithRegistry(
  startMondayIso: string,
  weekNumber: number,
  registry: readonly StatHoliday[],
): {
  weekMonday: string;
  firstPlayDate: string;
  secondPlayDate: string;
  shiftedByHoliday: boolean;
  holidayName?: string;
} {
  const safeWeek = Math.max(1, weekNumber);
  const weekMonday = addDaysISO(startMondayIso, (safeWeek - 1) * 7);
  const holiday = statHolidayForDateInRegistry(weekMonday, registry);
  const shifted = holiday != null && isMondayStatHolidayInRegistry(weekMonday, registry);
  if (shifted) {
    return {
      weekMonday,
      firstPlayDate: addDaysISO(weekMonday, 1),
      secondPlayDate: addDaysISO(weekMonday, 2),
      shiftedByHoliday: true,
      holidayName: holiday.name,
    };
  }
  return {
    weekMonday,
    firstPlayDate: weekMonday,
    secondPlayDate: addDaysISO(weekMonday, 1),
    shiftedByHoliday: false,
  };
}

