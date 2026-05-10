import { and, desc, eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  bookingHolds,
  bookingRuns,
  players,
  seasonBookingHolds,
  weekPlans,
} from "../db/schema.js";
import {
  createUssquashClient,
  extractReservationIdsFromClinicResponse,
  type CreateClinicBody,
  type UssquashClient,
} from "./clubLockerClient.js";
import { buildManagedMatchReservations, type WeekPlanPayload } from "./payloads.js";
import {
  BULK_MONDAY_TIME_WINDOWS,
  BULK_TUESDAY_TIME_WINDOWS,
  seasonWeekPlayDates,
} from "@squash/shared";
import {
  allBulkSlotCourts,
  allBulkSlotsForSingleDay,
  singleCourtSlotsForDay,
} from "./slotMap.js";

type PlayerRow = InferSelectModel<typeof players>;
type SeasonHoldRow = InferSelectModel<typeof seasonBookingHolds>;
type WeekHoldRow = InferSelectModel<typeof bookingHolds>;

const SLOTS_PER_PLAY_DAY = 8 * 2; // slot labels × two courts (matches allBulkSlotsForSingleDay)

function extractUssquashErrorString(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === "object" && "error" in data) {
    const e = (data as { error: unknown }).error;
    if (typeof e === "string") return e;
  }
  if (typeof data === "object" && "message" in data) {
    const m = (data as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return null;
}

function isSlotTimeConflictError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const s = msg.toLowerCase();
  return (
    s.includes("conflict") ||
    s.includes("exists for that slot") ||
    s.includes("reservation in the future")
  );
}

function formatBulkTimeWindowsForOperator(): string {
  const mon = BULK_MONDAY_TIME_WINDOWS.map(
    (w) => `${w.begin}–${w.end}`,
  ).join(", ");
  const tue = BULK_TUESDAY_TIME_WINDOWS.map(
    (w) => `${w.begin}–${w.end}`,
  ).join(", ");
  return `Times this app books (24h, club local): Mon ${mon}; Tue ${tue}.`;
}

/**
 * Merges two parallel recurring series (same slot order) into interleaved slot×court order:
 * s0c1, s0c2, s1c1, s1c2, …
 */
function mergeRecurringClinicInterleavedIds(
  idsCourt1: string[],
  idsCourt2: string[],
  seasonWeeks: number,
  slotsPerDay = 8,
): string[] {
  const n = seasonWeeks * slotsPerDay;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i < idsCourt1.length) out.push(idsCourt1[i]!);
    if (i < idsCourt2.length) out.push(idsCourt2[i]!);
  }
  return out;
}

/**
 * When a later createClinic fails, US Squash may already have created earlier courts’ series;
 * best-effort delete by reservation id to avoid a half-booked (e.g. Center only) state.
 */
async function rollbackCreatedClinicResponses(
  client: {
    deleteReservation: (
      id: string,
      notify: boolean,
    ) => Promise<{ status: number; data: unknown }>;
  },
  responseDataBlobs: unknown[],
): Promise<void> {
  for (const data of [...responseDataBlobs].reverse()) {
    const ids = extractReservationIdsFromClinicResponse(data);
    for (const id of ids) {
      try {
        await client.deleteReservation(id, false);
      } catch (e) {
        console.warn(`rollbackCreatedClinicResponses: delete ${id} failed`, e);
      }
    }
  }
}

function parseISODateLocal(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`Invalid ISO date: ${s}`);
  return new Date(y, m - 1, d);
}

function formatISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function addDaysISO(iso: string, days: number): string {
  const d = parseISODateLocal(iso);
  d.setDate(d.getDate() + days);
  return formatISODate(d);
}

function weekdayLabel(iso: string): string {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  return names[parseISODateLocal(iso).getDay()] ?? "Day";
}

function seasonClinicName(day: "mon" | "tue", courtId: number, weekNumber: number): string {
  const dayLabel = day === "mon" ? "Mon" : "Tue";
  return `League block ${dayLabel} court ${courtId} (season) Week ${weekNumber}`;
}

/** First Monday in `week` (1 = week of start Monday = startMonday) */
function seasonPlayDates(
  startMonday: string,
  weekNumber: number,
): { mondayDate: string; tuesdayDate: string } {
  const d = seasonWeekPlayDates(startMonday, weekNumber);
  return { mondayDate: d.firstPlayDate, tuesdayDate: d.secondPlayDate };
}

function makeSeasonClinicBody(
  name: string,
  firstDate: string,
  dayRows: { begin: string; end: string; courtId: number }[],
  seasonWeeks: number,
): CreateClinicBody {
  const useRecurringSeries = seasonWeeks > 1;
  return {
    name,
    description: null,
    date: firstDate,
    level: "",
    maximumPlayers: 16,
    recurring: useRecurringSeries,
    repeatEveryNumberOfWeeks: 1,
    /**
     * Club Locker treats this as total weekly occurrences for the recurring clinic
     * series (not "extra repeats after week 1"). For a 2-week run, send 2.
     */
    numberOfRepeats: useRecurringSeries ? seasonWeeks : 0,
    players: [],
    slots: dayRows.map((s) => ({
      begin: s.begin,
      end: s.end,
      court: { id: s.courtId },
    })),
    isPrivate: false,
    color: null,
    notes: [],
    customMatchType: null,
    customPrice: null,
    coach: null,
    coach2: null,
    coach3: null,
    coach4: null,
    ratingMinimum: null,
    ratingMaximum: null,
  };
}

/**
 * Slices the Monday- and Tuesday-series id lists for one play week. Each list has
 * length `seasonWeeks * SLOTS_PER_PLAY_DAY` when the API returns full recurring coverage.
 */
export function reservationIdsForSeasonWeek(
  mondayIds: string[],
  tuesdayIds: string[],
  weekNumber: number,
  seasonWeeks: number,
): string[] {
  const compactPerWeekExpected = seasonWeeks * 2;
  if (
    mondayIds.length === compactPerWeekExpected &&
    tuesdayIds.length === compactPerWeekExpected
  ) {
    const c0 = (weekNumber - 1) * 2;
    const mon = mondayIds.slice(c0, c0 + 2);
    const tue = tuesdayIds.slice(c0, c0 + 2);
    return [...mon, ...tue];
  }
  const m0 = (weekNumber - 1) * SLOTS_PER_PLAY_DAY;
  const mon = mondayIds.slice(m0, m0 + SLOTS_PER_PLAY_DAY);
  const tue = tuesdayIds.slice(m0, m0 + SLOTS_PER_PLAY_DAY);
  return [...mon, ...tue];
}

export function getLatestWeekPlan(
  db: Db,
  seasonId: string,
  week: number,
): { id: string; payload: WeekPlanPayload } | { error: string } {
  const rows = db
    .select()
    .from(weekPlans)
    .where(eq(weekPlans.seasonId, seasonId))
    .all();
  const match = rows
    .filter((p) => p.weekNumber === week)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!match) {
    return { error: "week_plan_missing" };
  }
  const payload = JSON.parse(match.payloadJson) as WeekPlanPayload;
  return { id: match.id, payload };
}

function playersMap(db: Db): Map<string, PlayerRow> {
  return new Map(db.select().from(players).all().map((p) => [p.id, p]));
}

export function previewBooking(
  db: Db,
  config: AppConfig,
  seasonId: string,
  week: number,
  mondayDate: string,
  tuesdayDate: string,
):
  | {
      weekPlanId: string;
      bulkSlotCount: number;
      managedMatchCount: number;
      items: { box: number; date: string; courtId: string; slot: string; players: string[] }[];
      missingExternal: { playerId: string; displayName: string; box: number }[];
    }
  | { error: string } {
  const plan = getLatestWeekPlan(db, seasonId, week);
  if ("error" in plan) return plan;
  const pmap = playersMap(db);
  const court1 = config.US_SQUASH_COURT_1_ID;
  const court2 = config.US_SQUASH_COURT_2_ID;
  const { items, missingExternal } = buildManagedMatchReservations(
    plan.payload,
    pmap,
    seasonId,
    mondayDate,
    tuesdayDate,
    config.US_SQUASH_CLUB_ID,
    court1,
    court2,
    config.US_SQUASH_CUSTOM_MATCH_TYPE,
  );
  return {
    weekPlanId: plan.id,
    bulkSlotCount: allBulkSlotCourts(mondayDate, tuesdayDate, court1, court2)
      .length,
    managedMatchCount: items.length,
    items: items.map((i) => ({
      box: i.boxNumber,
      date: i.playDate,
      courtId: String(i.courtId),
      slot: i.slot,
      players: i.internalPlayerIds.map((id) => pmap.get(id)?.displayName ?? id),
    })),
    missingExternal,
  };
}

export function previewSeasonBulk(
  config: AppConfig,
  input: { seasonId: string; startMondayDate: string; seasonWeeks: number },
) {
  const court1 = config.US_SQUASH_COURT_1_ID;
  const court2 = config.US_SQUASH_COURT_2_ID;
  const week1 = seasonWeekPlayDates(input.startMondayDate, 1);
  const tuesdayOfWeek1 = week1.secondPlayDate;
  const mon = allBulkSlotsForSingleDay(week1.firstPlayDate, "mon", court1, court2);
  const tue = allBulkSlotsForSingleDay(tuesdayOfWeek1, "tue", court1, court2);
  const usSquashClinicCalls: {
    label: string;
    firstDate: string;
    slotCount: number;
    weeklyOccurrences: number;
    includesCourts: [number, number];
  }[] = [];
  for (let week = 1; week <= input.seasonWeeks; week++) {
    const dates = seasonWeekPlayDates(input.startMondayDate, week);
    usSquashClinicCalls.push(
      {
        label: `Week ${week} · Monday template · Stadium${dates.shiftedByHoliday ? " (shifted)" : ""}`,
        firstDate: dates.firstPlayDate,
        slotCount: 8,
        weeklyOccurrences: 1,
        includesCourts: [court1, court1] as [number, number],
      },
      {
        label: `Week ${week} · Monday template · Center${dates.shiftedByHoliday ? " (shifted)" : ""}`,
        firstDate: dates.firstPlayDate,
        slotCount: 8,
        weeklyOccurrences: 1,
        includesCourts: [court2, court2] as [number, number],
      },
      {
        label: `Week ${week} · Tuesday template · Stadium${dates.shiftedByHoliday ? " (shifted)" : ""}`,
        firstDate: dates.secondPlayDate,
        slotCount: 8,
        weeklyOccurrences: 1,
        includesCourts: [court1, court1] as [number, number],
      },
      {
        label: `Week ${week} · Tuesday template · Center${dates.shiftedByHoliday ? " (shifted)" : ""}`,
        firstDate: dates.secondPlayDate,
        slotCount: 8,
        weeklyOccurrences: 1,
        includesCourts: [court2, court2] as [number, number],
      },
    );
  }
  return {
    seasonId: input.seasonId,
    startMondayDate: input.startMondayDate,
    week1Tuesday: tuesdayOfWeek1,
    seasonWeeks: input.seasonWeeks,
    /** Four `POST /clubs/{id}/clinics` calls: Mon/Tue × one series per court (recurring for multi-week, one-time for a 1-week test). */
    usSquashClinicCalls,
    bff: {
      method: "POST" as const,
      path: `/api/seasons/${input.seasonId}/booking/season-bulk`,
      body: {
        startMondayDate: input.startMondayDate,
        seasonWeeks: input.seasonWeeks,
        confirm: true,
      },
    },
  };
}

export type SeasonBulkResult = {
  runId: string;
  seasonHoldId: string;
  status: "ok" | "partial" | "error";
  message: string;
  /** When true, no new Club Locker API calls were made; an active `season_booking_holds` row already existed. */
  idempotent?: boolean;
  /** When true, Club Locker reported overlapping or existing reservations in those time slots. */
  conflict?: boolean;
  mondayStatus?: number;
  tuesdayStatus?: number;
  mondayReservationIdCount: number;
  tuesdayReservationIdCount: number;
  rawResponse?: unknown;
};

export async function runSeasonBulkBooking(
  db: Db,
  config: AppConfig,
  input: { seasonId: string; startMondayDate: string; seasonWeeks?: number; confirm: boolean },
  client: UssquashClient = createUssquashClient(config),
): Promise<SeasonBulkResult> {
  const seasonWeeks = input.seasonWeeks ?? config.LEAGUE_SEASON_WEEKS;
  if (!input.confirm) {
    return {
      runId: "",
      seasonHoldId: "",
      status: "error",
      message: "confirm must be true to execute",
      mondayReservationIdCount: 0,
      tuesdayReservationIdCount: 0,
    };
  }

  const exists = db
    .select()
    .from(seasonBookingHolds)
    .where(
      and(
        eq(seasonBookingHolds.seasonId, input.seasonId),
        eq(seasonBookingHolds.startMondayDate, input.startMondayDate),
        eq(seasonBookingHolds.status, "active"),
      ),
    )
    .get();
  if (exists) {
    if (exists.seasonWeeks !== seasonWeeks) {
      return {
        runId: "",
        seasonHoldId: exists.id,
        status: "error",
        message:
          `An active local season hold already exists for ${exists.seasonWeeks} week(s) at this start Monday, but this run requested ${seasonWeeks} week(s). Remove the local season hold (and matching Club Locker clinics) before running with a different week count.`,
        mondayReservationIdCount: 0,
        tuesdayReservationIdCount: 0,
      };
    }
    const mon = JSON.parse(exists.mondayReservationIdsJson) as string[];
    const tue = JSON.parse(exists.tuesdayReservationIdsJson) as string[];
    return {
      runId: "",
      seasonHoldId: exists.id,
      status: "ok",
      idempotent: true,
      message:
        "Idempotent: a season block already exists for this season and start Monday. Remove the local hold record in this app (or the row in the service DB) if you already deleted the clinics in Club Locker and need to run again.",
      mondayReservationIdCount: mon.length,
      tuesdayReservationIdCount: tue.length,
    };
  }

  const court1 = config.US_SQUASH_COURT_1_ID;
  const court2 = config.US_SQUASH_COURT_2_ID;
  const runId = crypto.randomUUID();
  const monIds: string[] = [];
  const tueIds: string[] = [];
  const createdResponseBlobs: unknown[] = [];
  const rawWeeks: {
    week: number;
    shiftedByHoliday: boolean;
    holidayName?: string;
    firstPlayDate: string;
    secondPlayDate: string;
    mon: {
      court1: { status: number; data: unknown };
      court2: { status: number; data: unknown };
    };
    tue: {
      court1: { status: number; data: unknown };
      court2: { status: number; data: unknown };
    };
  }[] = [];

  for (let week = 1; week <= seasonWeeks; week++) {
    const dates = seasonWeekPlayDates(input.startMondayDate, week);
    const firstPlayLabel = `${weekdayLabel(dates.firstPlayDate)} ${dates.firstPlayDate}`;
    const secondPlayLabel = `${weekdayLabel(dates.secondPlayDate)} ${dates.secondPlayDate}`;
    const monC1 = singleCourtSlotsForDay(dates.firstPlayDate, "mon", court1);
    const monC2 = singleCourtSlotsForDay(dates.firstPlayDate, "mon", court2);
    const tueC1 = singleCourtSlotsForDay(dates.secondPlayDate, "tue", court1);
    const tueC2 = singleCourtSlotsForDay(dates.secondPlayDate, "tue", court2);

    const bodyMon1 = makeSeasonClinicBody(
      seasonClinicName("mon", court1, week),
      dates.firstPlayDate,
      monC1,
      1,
    );
    const bodyMon2 = makeSeasonClinicBody(
      seasonClinicName("mon", court2, week),
      dates.firstPlayDate,
      monC2,
      1,
    );
    const bodyTue1 = makeSeasonClinicBody(
      seasonClinicName("tue", court1, week),
      dates.secondPlayDate,
      tueC1,
      1,
    );
    const bodyTue2 = makeSeasonClinicBody(
      seasonClinicName("tue", court2, week),
      dates.secondPlayDate,
      tueC2,
      1,
    );

    const resMon1 = await client.createClinic(config.US_SQUASH_CLUB_ID, bodyMon1);
    if (resMon1.status < 200 || resMon1.status >= 300) {
      const failErr = extractUssquashErrorString(resMon1.data) ?? `HTTP ${resMon1.status}`;
      const conflict = isSlotTimeConflictError(failErr);
      db.insert(bookingRuns)
        .values({
          id: runId,
          seasonId: input.seasonId,
          kind: "season_bulk",
          weekNumber: null,
          status: "error",
          summaryJson: JSON.stringify({
            startMonday: input.startMondayDate,
            seasonWeeks,
            failedWeek: week,
            failedStep: `${firstPlayLabel} · Stadium`,
            conflict,
            plannedDates: {
              firstPlayDate: dates.firstPlayDate,
              secondPlayDate: dates.secondPlayDate,
              shiftedByHoliday: dates.shiftedByHoliday,
              holidayName: dates.holidayName,
            },
          }),
          holdId: null,
        })
        .run();
      return {
        runId,
        seasonHoldId: "",
        status: "error",
        conflict: conflict || undefined,
        mondayStatus: resMon1.status,
        tuesdayStatus: resMon1.status,
        mondayReservationIdCount: 0,
        tuesdayReservationIdCount: 0,
        message: `Failed at week ${week} (${firstPlayLabel} · Stadium): ${failErr} ${conflict ? formatBulkTimeWindowsForOperator() : ""}`,
        rawResponse: {
          weeks: rawWeeks,
          failed: {
            week,
            step: `${firstPlayLabel} · Stadium`,
            plannedDates: {
              firstPlayDate: dates.firstPlayDate,
              secondPlayDate: dates.secondPlayDate,
              shiftedByHoliday: dates.shiftedByHoliday,
              holidayName: dates.holidayName,
            },
            response: resMon1,
          },
        },
      };
    }
    createdResponseBlobs.push(resMon1.data);

    const resMon2 = await client.createClinic(config.US_SQUASH_CLUB_ID, bodyMon2);
    if (resMon2.status < 200 || resMon2.status >= 300) {
      await rollbackCreatedClinicResponses(client, createdResponseBlobs);
      const failErr = extractUssquashErrorString(resMon2.data) ?? `HTTP ${resMon2.status}`;
      const conflict = isSlotTimeConflictError(failErr);
      db.insert(bookingRuns)
        .values({
          id: runId,
          seasonId: input.seasonId,
          kind: "season_bulk",
          weekNumber: null,
          status: "error",
          summaryJson: JSON.stringify({
            startMonday: input.startMondayDate,
            seasonWeeks,
            failedWeek: week,
            failedStep: `${firstPlayLabel} · Center`,
            conflict,
            rolledBack: true,
            plannedDates: {
              firstPlayDate: dates.firstPlayDate,
              secondPlayDate: dates.secondPlayDate,
              shiftedByHoliday: dates.shiftedByHoliday,
              holidayName: dates.holidayName,
            },
          }),
          holdId: null,
        })
        .run();
      return {
        runId,
        seasonHoldId: "",
        status: "error",
        conflict: conflict || undefined,
        mondayStatus: resMon2.status,
        tuesdayStatus: resMon2.status,
        mondayReservationIdCount: 0,
        tuesdayReservationIdCount: 0,
        message: `Failed at week ${week} (${firstPlayLabel} · Center): ${failErr} ${conflict ? formatBulkTimeWindowsForOperator() : ""} Earlier steps were rolled back (best effort).`,
        rawResponse: {
          weeks: rawWeeks,
          failed: {
            week,
            step: `${firstPlayLabel} · Center`,
            plannedDates: {
              firstPlayDate: dates.firstPlayDate,
              secondPlayDate: dates.secondPlayDate,
              shiftedByHoliday: dates.shiftedByHoliday,
              holidayName: dates.holidayName,
            },
            response: resMon2,
          },
        },
      };
    }
    createdResponseBlobs.push(resMon2.data);

    const resTue1 = await client.createClinic(config.US_SQUASH_CLUB_ID, bodyTue1);
    if (resTue1.status < 200 || resTue1.status >= 300) {
      await rollbackCreatedClinicResponses(client, createdResponseBlobs);
      const failErr = extractUssquashErrorString(resTue1.data) ?? `HTTP ${resTue1.status}`;
      const conflict = isSlotTimeConflictError(failErr);
      db.insert(bookingRuns)
        .values({
          id: runId,
          seasonId: input.seasonId,
          kind: "season_bulk",
          weekNumber: null,
          status: "error",
          summaryJson: JSON.stringify({
            startMonday: input.startMondayDate,
            seasonWeeks,
            failedWeek: week,
            failedStep: `${secondPlayLabel} · Stadium`,
            conflict,
            rolledBack: true,
            plannedDates: {
              firstPlayDate: dates.firstPlayDate,
              secondPlayDate: dates.secondPlayDate,
              shiftedByHoliday: dates.shiftedByHoliday,
              holidayName: dates.holidayName,
            },
          }),
          holdId: null,
        })
        .run();
      return {
        runId,
        seasonHoldId: "",
        status: "error",
        conflict: conflict || undefined,
        mondayStatus: resTue1.status,
        tuesdayStatus: resTue1.status,
        mondayReservationIdCount: 0,
        tuesdayReservationIdCount: 0,
        message: `Failed at week ${week} (${secondPlayLabel} · Stadium): ${failErr} ${conflict ? formatBulkTimeWindowsForOperator() : ""} Earlier steps were rolled back (best effort).`,
        rawResponse: {
          weeks: rawWeeks,
          failed: {
            week,
            step: `${secondPlayLabel} · Stadium`,
            plannedDates: {
              firstPlayDate: dates.firstPlayDate,
              secondPlayDate: dates.secondPlayDate,
              shiftedByHoliday: dates.shiftedByHoliday,
              holidayName: dates.holidayName,
            },
            response: resTue1,
          },
        },
      };
    }
    createdResponseBlobs.push(resTue1.data);

    const resTue2 = await client.createClinic(config.US_SQUASH_CLUB_ID, bodyTue2);
    if (resTue2.status < 200 || resTue2.status >= 300) {
      await rollbackCreatedClinicResponses(client, createdResponseBlobs);
      const failErr = extractUssquashErrorString(resTue2.data) ?? `HTTP ${resTue2.status}`;
      const conflict = isSlotTimeConflictError(failErr);
      db.insert(bookingRuns)
        .values({
          id: runId,
          seasonId: input.seasonId,
          kind: "season_bulk",
          weekNumber: null,
          status: "error",
          summaryJson: JSON.stringify({
            startMonday: input.startMondayDate,
            seasonWeeks,
            failedWeek: week,
            failedStep: `${secondPlayLabel} · Center`,
            conflict,
            rolledBack: true,
            plannedDates: {
              firstPlayDate: dates.firstPlayDate,
              secondPlayDate: dates.secondPlayDate,
              shiftedByHoliday: dates.shiftedByHoliday,
              holidayName: dates.holidayName,
            },
          }),
          holdId: null,
        })
        .run();
      return {
        runId,
        seasonHoldId: "",
        status: "error",
        conflict: conflict || undefined,
        mondayStatus: resTue2.status,
        tuesdayStatus: resTue2.status,
        mondayReservationIdCount: 0,
        tuesdayReservationIdCount: 0,
        message: `Failed at week ${week} (${secondPlayLabel} · Center): ${failErr} ${conflict ? formatBulkTimeWindowsForOperator() : ""} Earlier steps were rolled back (best effort).`,
        rawResponse: {
          weeks: rawWeeks,
          failed: {
            week,
            step: `${secondPlayLabel} · Center`,
            plannedDates: {
              firstPlayDate: dates.firstPlayDate,
              secondPlayDate: dates.secondPlayDate,
              shiftedByHoliday: dates.shiftedByHoliday,
              holidayName: dates.holidayName,
            },
            response: resTue2,
          },
        },
      };
    }
    createdResponseBlobs.push(resTue2.data);

    const exMon1 = extractReservationIdsFromClinicResponse(resMon1.data);
    const exMon2 = extractReservationIdsFromClinicResponse(resMon2.data);
    const exTue1 = extractReservationIdsFromClinicResponse(resTue1.data);
    const exTue2 = extractReservationIdsFromClinicResponse(resTue2.data);
    monIds.push(...mergeRecurringClinicInterleavedIds(exMon1, exMon2, 1, 8));
    tueIds.push(...mergeRecurringClinicInterleavedIds(exTue1, exTue2, 1, 8));
    rawWeeks.push({
      week,
      shiftedByHoliday: dates.shiftedByHoliday,
      holidayName: dates.holidayName,
      firstPlayDate: dates.firstPlayDate,
      secondPlayDate: dates.secondPlayDate,
      mon: {
        court1: { status: resMon1.status, data: resMon1.data },
        court2: { status: resMon2.status, data: resMon2.data },
      },
      tue: {
        court1: { status: resTue1.status, data: resTue1.data },
        court2: { status: resTue2.status, data: resTue2.data },
      },
    });
  }

  const expected = seasonWeeks * SLOTS_PER_PLAY_DAY;
  const compactPerWeekExpected = seasonWeeks * 2;
  const compactLegacyMon = monIds.length === 2;
  const compactLegacyTue = tueIds.length === 2;
  const monOk = monIds.length === 0 || monIds.length === expected ||
    monIds.length === compactPerWeekExpected || compactLegacyMon;
  const tueOk = tueIds.length === 0 || tueIds.length === expected ||
    tueIds.length === compactPerWeekExpected || compactLegacyTue;
  if (!monOk) {
    console.warn(
      `runSeasonBulkBooking: Monday id count ${monIds.length} expected ${expected} (live API may return a different shape)`,
    );
  }
  if (!tueOk) {
    console.warn(
      `runSeasonBulkBooking: Tuesday id count ${tueIds.length} expected ${expected}`,
    );
  }

  const holdId = crypto.randomUUID();
  const hasIds = monIds.length > 0 && tueIds.length > 0;
  const status: SeasonBulkResult["status"] = hasIds && monOk && tueOk
    ? "ok"
    : "partial";

  db.insert(seasonBookingHolds)
    .values({
      id: holdId,
      seasonId: input.seasonId,
      startMondayDate: input.startMondayDate,
      seasonWeeks,
      status: "active",
      mondayReservationIdsJson: JSON.stringify(monIds),
      tuesdayReservationIdsJson: JSON.stringify(tueIds),
      convertedWeeksJson: "[]",
      rawBulkResponseJson: JSON.stringify({ weeks: rawWeeks }),
    })
    .run();

  const runRowStatus: "ok" | "partial" | "error" =
    status === "ok" ? "ok" : "partial";

  db.insert(bookingRuns)
    .values({
      id: runId,
      seasonId: input.seasonId,
      kind: "season_bulk",
      weekNumber: null,
      status: runRowStatus,
      summaryJson: JSON.stringify({
        startMonday: input.startMondayDate,
        seasonWeeks,
        monday: {
          ok: true,
          ids: monIds.length,
        },
        tuesday: {
          ok: true,
          ids: tueIds.length,
        },
        seasonHoldId: holdId,
        sequentialClinicSteps: seasonWeeks * 4,
      }),
      holdId: null,
    })
    .run();

  return {
    runId,
    seasonHoldId: holdId,
    status,
    mondayStatus: 200,
    tuesdayStatus: 200,
    mondayReservationIdCount: monIds.length,
    tuesdayReservationIdCount: tueIds.length,
    message: hasIds && monOk && tueOk
      ? "Season block created (one clinic per court for each play day/week). Reservation ids stored for weekly conversion."
      : "Clinic(s) created but no reservation id parsed from response — conversion may not be able to release blocks.",
    rawResponse: { weeks: rawWeeks },
  };
}

export type ConvertResult = {
  runId: string;
  status: "ok" | "partial" | "error";
  summary: {
    holdKind: "season" | "week";
    deleted: { id: string; status: number; ok: boolean }[];
    created: { key: string; status: number; ok: boolean }[];
    holdId: string;
  };
  message: string;
};

function findWeekHold(
  db: Db,
  seasonId: string,
  week: number,
  holdId?: string,
) {
  if (holdId) {
    return db
      .select()
      .from(bookingHolds)
      .where(
        and(eq(bookingHolds.id, holdId), eq(bookingHolds.seasonId, seasonId)),
      )
      .get() as WeekHoldRow | undefined;
  }
  return db
    .select()
    .from(bookingHolds)
    .where(
      and(
        eq(bookingHolds.seasonId, seasonId),
        eq(bookingHolds.weekNumber, week),
        eq(bookingHolds.status, "active"),
      ),
    )
    .all()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] as
    | WeekHoldRow
    | undefined;
}

function findSeasonHold(
  db: Db,
  seasonId: string,
  holdId?: string,
) {
  if (holdId) {
    return db
      .select()
      .from(seasonBookingHolds)
      .where(
        and(
          eq(seasonBookingHolds.id, holdId),
          eq(seasonBookingHolds.seasonId, seasonId),
        ),
      )
      .get() as SeasonHoldRow | undefined;
  }
  return db
    .select()
    .from(seasonBookingHolds)
    .where(
      and(
        eq(seasonBookingHolds.seasonId, seasonId),
        eq(seasonBookingHolds.status, "active"),
      ),
    )
    .all()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] as
    | SeasonHoldRow
    | undefined;
}

type ResolvedHold =
  | { kind: "season"; row: SeasonHoldRow }
  | { kind: "week"; row: WeekHoldRow };

/**
 * Resolves a hold for conversion: optional explicit id (season or legacy week hold),
 * else prefers an active season block, else a legacy per-week block.
 */
function resolveConvertHold(
  db: Db,
  seasonId: string,
  week: number,
  holdIdInput?: string,
): ResolvedHold | { error: string } {
  const trimmed = holdIdInput?.trim();
  if (trimmed) {
    const s = findSeasonHold(db, seasonId, trimmed);
    if (s) {
      if (s.status !== "active") return { error: "hold_inactive" };
      return { kind: "season", row: s };
    }
    const w = findWeekHold(db, seasonId, week, trimmed);
    if (w) {
      if (w.status !== "active") return { error: "hold_inactive" };
      return { kind: "week", row: w };
    }
    return { error: "hold_not_found" };
  }
  const s = findSeasonHold(db, seasonId);
  if (s) return { kind: "season", row: s };
  const w = findWeekHold(db, seasonId, week);
  if (w) return { kind: "week", row: w };
  return { error: "no_hold" };
}

export async function runWeeklyConvert(
  db: Db,
  config: AppConfig,
  input: {
    seasonId: string;
    week: number;
    holdId?: string;
    confirm: boolean;
    notifyOnDelete: boolean;
  },
  client: UssquashClient = createUssquashClient(config),
): Promise<ConvertResult> {
  if (!input.confirm) {
    return {
      runId: "",
      status: "error",
      message: "confirm must be true to execute",
      summary: { holdKind: "week", deleted: [], created: [], holdId: "" },
    };
  }

  const resolved = resolveConvertHold(
    db,
    input.seasonId,
    input.week,
    input.holdId,
  );
  if ("error" in resolved) {
    return {
      runId: "",
      status: "error",
      message:
        resolved.error === "hold_not_found"
          ? "Hold not found for this season."
          : resolved.error === "hold_inactive"
            ? "This hold is no longer active (e.g. season block fully converted or cancelled)."
            : "No active booking hold — run pre-season season bulk first, or pass a hold id (season or per-week).",
      summary: { holdKind: "week", deleted: [], created: [], holdId: input.holdId ?? "" },
    };
  }

  if (input.week < 1) {
    return {
      runId: "",
      status: "error",
      message: "week must be >= 1",
      summary: { holdKind: "season", deleted: [], created: [], holdId: "" },
    };
  }

  const plan = getLatestWeekPlan(db, input.seasonId, input.week);
  if ("error" in plan) {
    return {
      runId: "",
      status: "error",
      message: "Week plan not found; generate the week in Weekly first.",
      summary: {
        holdKind: resolved.kind,
        deleted: [],
        created: [],
        holdId: resolved.kind === "season" ? resolved.row.id : resolved.row.id,
      },
    };
  }

  let mondayDate: string;
  let tuesdayDate: string;
  let reservationIds: string[] = [];
  const holdKind = resolved.kind;

  if (resolved.kind === "season") {
    const seasonHold = resolved.row;
    if (input.week > seasonHold.seasonWeeks) {
      return {
        runId: "",
        status: "error",
        message: `Week ${input.week} is after season length (${seasonHold.seasonWeeks} weeks).`,
        summary: {
          holdKind: "season",
          deleted: [],
          created: [],
          holdId: seasonHold.id,
        },
      };
    }
    const converted = JSON.parse(seasonHold.convertedWeeksJson) as number[];
    if (converted.includes(input.week)) {
      return {
        runId: "",
        status: "ok",
        message: `Week ${input.week} was already converted (idempotent).`,
        summary: { holdKind: "season", deleted: [], created: [], holdId: seasonHold.id },
      };
    }
    const mon = JSON.parse(seasonHold.mondayReservationIdsJson) as string[];
    const tue = JSON.parse(seasonHold.tuesdayReservationIdsJson) as string[];
    const expected = seasonHold.seasonWeeks * SLOTS_PER_PLAY_DAY;
    const compactPerWeekExpected = seasonHold.seasonWeeks * 2;
    const compactSeriesStoredIds = mon.length === 2 && tue.length === 2;
    const compactPerWeekStoredIds =
      mon.length === compactPerWeekExpected && tue.length === compactPerWeekExpected;
    const usableShape =
      (mon.length === expected && tue.length === expected) ||
      compactPerWeekStoredIds ||
      compactSeriesStoredIds;
    if (!usableShape) {
      return {
        runId: "",
        status: "error",
        message: `Season hold is missing usable reservation id lists (expected ${expected} slot ids per day or ${compactPerWeekExpected} clinic ids per day). Re-run or fix API response shape.`,
        summary: { holdKind: "season", deleted: [], created: [], holdId: seasonHold.id },
      };
    }
    reservationIds = compactSeriesStoredIds
      ? converted.length === 0
        ? [...mon, ...tue]
        : []
      : reservationIdsForSeasonWeek(
        mon,
        tue,
        input.week,
        seasonHold.seasonWeeks,
      );
    const d = seasonPlayDates(seasonHold.startMondayDate, input.week);
    mondayDate = d.mondayDate;
    tuesdayDate = d.tuesdayDate;
  } else {
    mondayDate = resolved.row.mondayDate;
    tuesdayDate = resolved.row.tuesdayDate;
    reservationIds = JSON.parse(resolved.row.externalReservationIdsJson) as string[];
  }

  const pmap = playersMap(db);
  const { items, missingExternal } = buildManagedMatchReservations(
    plan.payload,
    pmap,
    input.seasonId,
    mondayDate,
    tuesdayDate,
    config.US_SQUASH_CLUB_ID,
    config.US_SQUASH_COURT_1_ID,
    config.US_SQUASH_COURT_2_ID,
    config.US_SQUASH_CUSTOM_MATCH_TYPE,
  );
  if (missingExternal.length > 0) {
    return {
      runId: "",
      status: "error",
      message: "Missing Club Locker player ids for: " + missingExternal.map(
        (m) => m.displayName,
      ).join(", "),
      summary: {
        holdKind: resolved.kind,
        deleted: [],
        created: [],
        holdId: resolved.kind === "season" ? resolved.row.id : resolved.row.id,
      },
    };
  }
  if (items.length === 0) {
    return {
      runId: "",
      status: "error",
      message: "No managed match reservations to create.",
      summary: {
        holdKind: resolved.kind,
        deleted: [],
        created: [],
        holdId: resolved.kind === "season" ? resolved.row.id : resolved.row.id,
      },
    };
  }

  const holdRefId = resolved.row.id;
  const deleted: ConvertResult["summary"]["deleted"] = [];
  for (const id of reservationIds) {
    const d = await client.deleteReservation(id, input.notifyOnDelete);
    deleted.push({ id, status: d.status, ok: d.status >= 200 && d.status < 300 });
  }
  if (reservationIds.length > 0 && !deleted.every((x) => x.ok)) {
    const runId = crypto.randomUUID();
    db.insert(bookingRuns)
      .values({
        id: runId,
        seasonId: input.seasonId,
        kind: "convert",
        weekNumber: input.week,
        status: "error",
        summaryJson: JSON.stringify({ holdKind, deleted, created: [] }),
        holdId: null,
      })
      .run();
    return {
      runId,
      status: "error",
      message: "Some bulk reservations could not be deleted; aborting match creation.",
      summary: { holdKind, deleted, created: [], holdId: holdRefId },
    };
  }
  if (reservationIds.length === 0) {
    // Same as before: may proceed if createMatchReservation without deletes (live shape).
  }

  const created: { key: string; status: number; ok: boolean }[] = [];
  for (const it of items) {
    const key = `b${it.boxNumber}-${it.playDate}-c${it.courtId}-${it.slot}`;
    const r = await client.createMatchReservation(
      config.US_SQUASH_CLUB_ID,
      it.body,
    );
    created.push({ key, status: r.status, ok: r.status >= 200 && r.status < 300 });
  }

  const allOk = created.every((c) => c.ok);
  const runId = crypto.randomUUID();

  if (resolved.kind === "week") {
    db.update(bookingHolds)
      .set({ status: "converted" })
      .where(eq(bookingHolds.id, resolved.row.id))
      .run();
  } else {
    const sh = resolved.row;
    const next = [
      ...new Set([...(JSON.parse(sh.convertedWeeksJson) as number[]), input.week])].sort(
        (a, b) => a - b,
      );
    const allDone = next.length >= sh.seasonWeeks;
    db.update(seasonBookingHolds)
      .set({
        convertedWeeksJson: JSON.stringify(next),
        status: allDone ? "fully_converted" : "active",
      })
      .where(eq(seasonBookingHolds.id, sh.id))
      .run();
  }

  db.insert(bookingRuns)
    .values({
      id: runId,
      seasonId: input.seasonId,
      kind: "convert",
      weekNumber: input.week,
      status: allOk ? "ok" : "partial",
      summaryJson: JSON.stringify({ holdKind, deleted, created, holdId: holdRefId }),
      holdId: null,
    })
    .run();
  return {
    runId,
    status: allOk ? "ok" : "partial",
    message: allOk
      ? `Conversion complete: ${created.length} match reservation(s) created.`
      : "Some match reservations failed — see summary.",
    summary: { holdKind, deleted, created, holdId: holdRefId },
  };
}

export function listBookingHolds(
  db: Db,
  seasonId: string,
) {
  return db
    .select()
    .from(bookingHolds)
    .where(eq(bookingHolds.seasonId, seasonId))
    .orderBy(desc(bookingHolds.createdAt))
    .all();
}

export function listSeasonBookingHolds(db: Db, seasonId: string) {
  return db
    .select()
    .from(seasonBookingHolds)
    .where(eq(seasonBookingHolds.seasonId, seasonId))
    .orderBy(desc(seasonBookingHolds.createdAt))
    .all();
}

/**
 * Remove a season bulk hold row (local `season_booking_holds` only). Use after deleting the
 * recurring clinics in Club Locker so a new `season-bulk` run is allowed.
 */
export function removeSeasonBookingHold(
  db: Db,
  seasonId: string,
  holdId: string,
):
  | { ok: true }
  | { ok: false; error: string } {
  const row = db
    .select()
    .from(seasonBookingHolds)
    .where(
      and(
        eq(seasonBookingHolds.id, holdId),
        eq(seasonBookingHolds.seasonId, seasonId),
      ),
    )
    .get();
  if (!row) {
    return { ok: false, error: "Season hold not found for this season." };
  }
  db.delete(seasonBookingHolds)
    .where(
      and(
        eq(seasonBookingHolds.id, holdId),
        eq(seasonBookingHolds.seasonId, seasonId),
      ),
    )
    .run();
  return { ok: true };
}

export function listBookingRuns(
  db: Db,
  seasonId: string,
  limit = 20,
) {
  return db
    .select()
    .from(bookingRuns)
    .where(eq(bookingRuns.seasonId, seasonId))
    .orderBy(desc(bookingRuns.createdAt))
    .limit(limit)
    .all();
}
