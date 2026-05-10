import { describe, expect, it } from "vitest";
import {
  bookingClubYearContainingDate,
  defaultBookingSeasonAndStartMonday,
  fallStartMondayLocal,
  formatLocalISODate,
  springStartMondayLocal,
  summerStartMondayLocal,
  winterStartMondayLocal,
} from "./bookingSeasons.js";

function localYMD(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d);
}

describe("season start Mondays (2026 fixtures)", () => {
  it("winter: first Monday strictly after 3 Jan", () => {
    expect(formatLocalISODate(winterStartMondayLocal(2026))).toBe("2026-01-05");
  });

  it("spring: first Monday in April when 31 Mar is not Monday", () => {
    expect(formatLocalISODate(springStartMondayLocal(2026))).toBe("2026-04-06");
  });

  it("summer: 1 Jun when that Monday is the first Monday in June (2026)", () => {
    expect(formatLocalISODate(summerStartMondayLocal(2026))).toBe("2026-06-01");
  });

  it("fall: first Monday in October", () => {
    expect(formatLocalISODate(fallStartMondayLocal(2026))).toBe("2026-10-05");
  });
});

describe("spring edge: 31 March Monday", () => {
  it("uses 31 March when it is Monday (2025)", () => {
    expect(formatLocalISODate(springStartMondayLocal(2025))).toBe("2025-03-31");
  });
});

describe("default season (4-week threshold)", () => {
  it("Apr 28 2026: still Spring (>28 days to Summer)", () => {
    const r = defaultBookingSeasonAndStartMonday(localYMD(2026, 4, 28));
    expect(r.season).toBe("spring");
    expect(r.startMondayISO).toBe("2026-04-06");
  });

  it("May 10 2026: round up to Summer (≤28 days to Summer start)", () => {
    const r = defaultBookingSeasonAndStartMonday(localYMD(2026, 5, 10));
    expect(r.season).toBe("summer");
    expect(r.startMondayISO).toBe("2026-06-01");
  });

  it("Dec 15 2025: round up to Winter when close to Jan start", () => {
    const r = defaultBookingSeasonAndStartMonday(localYMD(2025, 12, 15));
    expect(r.season).toBe("winter");
    expect(r.startMondayISO).toBe("2026-01-05");
  });

  it("club year follows rolled-forward winter", () => {
    const r = defaultBookingSeasonAndStartMonday(localYMD(2025, 12, 15));
    expect(r.clubYear).toBe(2026);
  });
});

describe("bookingClubYearContainingDate", () => {
  it("early Jan before winter start belongs to previous club year", () => {
    expect(bookingClubYearContainingDate(localYMD(2026, 1, 2))).toBe(2025);
  });
});
