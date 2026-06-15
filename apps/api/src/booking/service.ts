import { and, desc, eq, asc } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  bookingHolds,
  bookingRuns,
  houseLeagueBookedOccurrences,
  players,
  seasonBookingHolds,
  seasons,
  statutoryHolidays,
  weekPlans,
} from "../db/schema.js";
import {
  createUssquashClient,
  extractReservationIdFromMatchResponse,
  extractReservationIdsFromClinicResponse,
  type CreateClinicBody,
  type UssquashClient,
} from "./clubLockerClient.js";
import { buildManagedMatchReservations, type WeekPlanPayload } from "./payloads.js";
import {
  buildLiveWeekPlan,
  livePlayerDisplayName,
  liveWeekPlanResolvable,
  normalizeLiveBoxLeaguePlayers,
  type LiveBoxLeaguePlayer,
  type LiveManagedReservationItem,
} from "./liveWeekPlan.js";
import { loadAndApplyRelativeRankOverrides, loadSeatOverridesForSeason } from "../houseLeague/relativeRankOverrides.js";
import {
  BULK_MONDAY_TIME_WINDOWS,
  BULK_TUESDAY_TIME_WINDOWS,
  bulkHoldSlotsForWeekday,
  seasonWeekPlayDatesWithRegistry,
  type StatHoliday,
} from "@squash/shared";
import {
  allBulkSlotCourts,
  allBulkSlotsForSingleDay,
  formatReservationSlot,
} from "./slotMap.js";
import { runSingleCourtMatchBooking } from "./singleCourtMatch.js";
import { loadSeasonStartGroundTruthPlayers } from "../houseLeague/seasonStartRoster.js";

type PlayerRow = InferSelectModel<typeof players>;

/** Season-start roster snapshot for schedule seat → player (when saved). */
function optionalSeasonStartGroundTruth(
  db: Db,
  seasonId: string,
): LiveBoxLeaguePlayer[] | undefined {
  const gt = loadSeasonStartGroundTruthPlayers(
    db,
    seasonId,
  ) as LiveBoxLeaguePlayer[];
  return gt.length > 0 ? gt : undefined;
}

function optionalSeatOverrides(db: Db, seasonId: string) {
  const overrides = loadSeatOverridesForSeason(db, seasonId);
  return overrides.size > 0 ? overrides : undefined;
}
type SeasonHoldRow = InferSelectModel<typeof seasonBookingHolds>;
type WeekHoldRow = InferSelectModel<typeof bookingHolds>;

const SLOTS_PER_PLAY_DAY = 8 * 2; // slot labels × two courts (matches allBulkSlotsForSingleDay)

/** Base delay between sequential Club Locker match POSTs during weekly convert. */
const MATCH_BOOKING_PACE_BASE_MS = 3000;
/** Random extra delay (0–1s) on top of base so pacing is not perfectly periodic. */
const MATCH_BOOKING_PACE_JITTER_MS = 1000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paceBetweenMatchBookingsMs(): number {
  return MATCH_BOOKING_PACE_BASE_MS + Math.random() * MATCH_BOOKING_PACE_JITTER_MS;
}

/**
 * Canonical play week number for semi-finals (seven regular-season weeks precede).
 * Matches `REGULAR_SEASON_WEEKS_IN_CALENDAR + 1` on the booking calendar (apps/web).
 */
const HOUSE_LEAGUE_SEMIS_WEEK_NUMBER = 8;

function statHolidayRegistryFromDb(db: Db): StatHoliday[] {
  const rows = db
    .select()
    .from(statutoryHolidays)
    .orderBy(asc(statutoryHolidays.date))
    .all();
  return rows.map((r) => ({
    name: r.name,
    date: r.date,
    hours: {
      open: r.openTime,
      close: r.closeTime,
      closed: r.closed === 1,
    },
    kind: r.closureKind === "event" ? "event" : "holiday",
  }));
}

function seasonWeekPlayDatesForDb(
  db: Db,
  startMondayDate: string,
  weekNumber: number,
  registry?: readonly StatHoliday[],
): ReturnType<typeof seasonWeekPlayDatesWithRegistry> {
  const reg = registry ?? statHolidayRegistryFromDb(db);
  return seasonWeekPlayDatesWithRegistry(startMondayDate, weekNumber, reg);
}

/** User-facing fragment for Cancel bookings (e.g. "Semis" vs "Week 3"). */
export function bulkCancelWeekLabelPart(week: number): string {
  return week === HOUSE_LEAGUE_SEMIS_WEEK_NUMBER ? "Semis" : `Week ${week}`;
}

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

/**
 * Club Locker `clinics` name for season bulk holds: "{Summer} House League Week {n}",
 * or "{Summer} House League Semis" for the canonical semi-finals week.
 * Season word comes from `calendar_segment` when set; otherwise first token of the DB season name.
 */
export function houseLeagueSeasonBulkClinicName(
  seasonPrefix: string,
  weekNumber: number,
): string {
  const p = seasonPrefix.trim() || "Season";
  if (weekNumber === HOUSE_LEAGUE_SEMIS_WEEK_NUMBER) {
    return `${p} House League Semis`;
  }
  return `${p} House League Week ${weekNumber}`;
}

function seasonPrefixForBulkClinicName(
  calendarSegment: string | null | undefined,
  seasonName: string | undefined,
): string {
  const seg = calendarSegment?.trim().toLowerCase();
  if (seg === "winter" || seg === "spring" || seg === "summer" || seg === "fall") {
    return seg.charAt(0).toUpperCase() + seg.slice(1);
  }
  const first = seasonName?.trim().split(/\s+/)[0];
  if (first) return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  return "Season";
}

/** First Monday in `week` (1 = week of start Monday = startMonday) */
export function seasonPlayDates(
  db: Db,
  startMonday: string,
  weekNumber: number,
  registry?: readonly StatHoliday[],
): { mondayDate: string; tuesdayDate: string } {
  const d = seasonWeekPlayDatesForDb(db, startMonday, weekNumber, registry);
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
 * Slices the Monday- and Tuesday-series id lists for one play week.
 * - Full layout: each list has length `seasonWeeks * SLOTS_PER_PLAY_DAY`.
 * - Combined two-court clinic: each list has length `seasonWeeks` (one Club Locker id per play day).
 */
export function reservationIdsForSeasonWeek(
  mondayIds: string[],
  tuesdayIds: string[],
  weekNumber: number,
  seasonWeeks: number,
): string[] {
  /** One combined clinic POST per play day per week: API returns a single `id` for Mon and for Tue. */
  if (
    mondayIds.length === seasonWeeks &&
    tuesdayIds.length === seasonWeeks
  ) {
    const i = weekNumber - 1;
    const mon = mondayIds[i];
    const tue = tuesdayIds[i];
    if (mon == null || tue == null) return [];
    return [mon, tue];
  }
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

export async function fetchLiveBoxLeagueRosterForSeason(
  db: Db,
  _config: AppConfig,
  seasonId: string,
  client: UssquashClient,
): Promise<{ roster: LiveBoxLeaguePlayer[] } | { error: string }> {
  const season = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
  if (!season) return { error: "season_not_found" };
  const eventId = season.houseLeagueEventId;
  if (eventId == null || eventId <= 0) {
    return {
      error:
        "Link a US Squash house league event to this booking season (House League Setup), then try again.",
    };
  }
  const { status, data } = await client.listBoxLeaguePlayers(eventId);
  if (status < 200 || status >= 300) {
    return { error: `US Squash roster request failed (HTTP ${status}).` };
  }
  const roster = normalizeLiveBoxLeaguePlayers(data);
  if (roster.length === 0) {
    return { error: "US Squash box league roster is empty." };
  }
  return { roster: loadAndApplyRelativeRankOverrides(db, seasonId, roster) };
}

export function ensurePlayerRowFromUssquash(
  db: Db,
  ussquashId: number,
  displayName: string,
  rating: number,
): string {
  const externalId = String(ussquashId);
  const existing = db
    .select()
    .from(players)
    .where(eq(players.externalId, externalId))
    .get();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  db.insert(players)
    .values({
      id,
      externalId,
      displayName,
      email: null,
      rating: String(Number.isFinite(rating) ? rating : 3),
    })
    .run();
  return id;
}

function persistWeekPlanAuditRow(
  db: Db,
  seasonId: string,
  week: number,
  payload: WeekPlanPayload,
): string {
  const id = crypto.randomUUID();
  db.insert(weekPlans)
    .values({
      id,
      seasonId,
      weekNumber: week,
      payloadJson: JSON.stringify(payload),
      status: "converted",
    })
    .run();
  return id;
}

function previewBookingFromStoredWeekPlan(
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

function auditPayloadWithLocalPlayerIds(
  db: Db,
  payload: WeekPlanPayload,
  roster: readonly LiveBoxLeaguePlayer[],
): WeekPlanPayload {
  const byRef = new Map<string, LiveBoxLeaguePlayer>(
    roster.map((p) => [`ussquash:${p.id}`, p]),
  );
  const resolveRef = (ref: string | undefined): string | undefined => {
    if (!ref) return ref;
    if (!ref.startsWith("ussquash:")) return ref;
    const p = byRef.get(ref);
    if (!p) return ref;
    return ensurePlayerRowFromUssquash(
      db,
      p.id,
      livePlayerDisplayName(p),
      p.rating,
    );
  };
  return {
    week: payload.week,
    boxes: payload.boxes.map((b) => ({
      ...b,
      matchups: b.matchups.map(
        ([a, b2]) => [resolveRef(a), resolveRef(b2)] as [string | undefined, string | undefined],
      ),
    })),
  };
}

export async function previewBooking(
  db: Db,
  config: AppConfig,
  seasonId: string,
  week: number,
  mondayDate: string,
  tuesdayDate: string,
  client: UssquashClient = createUssquashClient(config),
): Promise<
  | {
      weekPlanId: string;
      bulkSlotCount: number;
      managedMatchCount: number;
      items: { box: number; date: string; courtId: string; slot: string; players: string[] }[];
      missingExternal: { playerId: string; displayName: string; box: number }[];
    }
  | { error: string }
> {
  const court1 = config.US_SQUASH_COURT_1_ID;
  const court2 = config.US_SQUASH_COURT_2_ID;
  const rosterResult = await fetchLiveBoxLeagueRosterForSeason(
    db,
    config,
    seasonId,
    client,
  );
  if ("roster" in rosterResult) {
    const groundTruth = optionalSeasonStartGroundTruth(db, seasonId);
    const seatOverrides = optionalSeatOverrides(db, seasonId);
    const live = buildLiveWeekPlan(
      week,
      rosterResult.roster,
      mondayDate,
      tuesdayDate,
      config.US_SQUASH_CLUB_ID,
      court1,
      court2,
      config.US_SQUASH_CUSTOM_MATCH_TYPE,
      groundTruth,
      seatOverrides,
    );
    if (!liveWeekPlanResolvable(live)) {
      const reason =
        live.issues[0]?.reason ??
        (live.items.length === 0
          ? "No managed match reservations to create from the live roster."
          : "Could not resolve the live roster for this week.");
      return { error: reason };
    }
    return {
      weekPlanId: "live-roster",
      bulkSlotCount: allBulkSlotCourts(mondayDate, tuesdayDate, court1, court2)
        .length,
      managedMatchCount: live.items.length,
      items: live.items.map((i) => ({
        box: i.boxNumber,
        date: i.playDate,
        courtId: String(i.courtId),
        slot: i.slot,
        players: i.playerDisplayNames,
      })),
      missingExternal: [],
    };
  }

  const stored = previewBookingFromStoredWeekPlan(
    db,
    config,
    seasonId,
    week,
    mondayDate,
    tuesdayDate,
  );
  if (!("error" in stored)) return stored;
  return { error: rosterResult.error };
}

export function previewSeasonBulk(
  db: Db,
  config: AppConfig,
  input: { seasonId: string; startMondayDate: string; seasonWeeks: number },
) {
  const court1 = config.US_SQUASH_COURT_1_ID;
  const court2 = config.US_SQUASH_COURT_2_ID;
  const holidayReg = statHolidayRegistryFromDb(db);
  const week1 = seasonWeekPlayDatesForDb(db, input.startMondayDate, 1, holidayReg);
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
    const dates = seasonWeekPlayDatesForDb(db, input.startMondayDate, week, holidayReg);
    usSquashClinicCalls.push(
      {
        label: `Week ${week} · Monday · both courts${dates.shiftedByHoliday ? " (shifted)" : ""}`,
        firstDate: dates.firstPlayDate,
        slotCount: 16,
        weeklyOccurrences: 1,
        includesCourts: [court1, court2] as [number, number],
      },
      {
        label: `Week ${week} · Tuesday · both courts${dates.shiftedByHoliday ? " (shifted)" : ""}`,
        firstDate: dates.secondPlayDate,
        slotCount: 16,
        weeklyOccurrences: 1,
        includesCourts: [court1, court2] as [number, number],
      },
    );
  }
  return {
    seasonId: input.seasonId,
    startMondayDate: input.startMondayDate,
    week1Tuesday: tuesdayOfWeek1,
    seasonWeeks: input.seasonWeeks,
    /** Two `POST /clubs/{id}/clinics` calls per week: Monday and Tuesday, each with both courts in one payload (`slots` length 16). */
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

  const seasonRow = db.select().from(seasons).where(eq(seasons.id, input.seasonId)).get();
  const clinicSeasonPrefix = seasonPrefixForBulkClinicName(
    seasonRow?.calendarSegment ?? undefined,
    seasonRow?.name,
  );

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
  const holidayReg = statHolidayRegistryFromDb(db);
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
    mon: { combined: { status: number; data: unknown } };
    tue: { combined: { status: number; data: unknown } };
  }[] = [];

  for (let week = 1; week <= seasonWeeks; week++) {
    const dates = seasonWeekPlayDatesForDb(db, input.startMondayDate, week, holidayReg);
    const firstPlayLabel = `${weekdayLabel(dates.firstPlayDate)} ${dates.firstPlayDate}`;
    const secondPlayLabel = `${weekdayLabel(dates.secondPlayDate)} ${dates.secondPlayDate}`;

    const weekClinicName = houseLeagueSeasonBulkClinicName(clinicSeasonPrefix, week);
    const monDayRows = allBulkSlotsForSingleDay(
      dates.firstPlayDate,
      "mon",
      court1,
      court2,
    ).map(({ begin, end, courtId }) => ({ begin, end, courtId }));
    const tueDayRows = allBulkSlotsForSingleDay(
      dates.secondPlayDate,
      "tue",
      court1,
      court2,
    ).map(({ begin, end, courtId }) => ({ begin, end, courtId }));

    const bodyMon = makeSeasonClinicBody(
      weekClinicName,
      dates.firstPlayDate,
      monDayRows,
      1,
    );
    const bodyTue = makeSeasonClinicBody(
      weekClinicName,
      dates.secondPlayDate,
      tueDayRows,
      1,
    );

    const resMon = await client.createClinic(config.US_SQUASH_CLUB_ID, bodyMon);
    if (resMon.status < 200 || resMon.status >= 300) {
      const failErr = extractUssquashErrorString(resMon.data) ?? `HTTP ${resMon.status}`;
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
            failedStep: `${firstPlayLabel} · both courts`,
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
        mondayStatus: resMon.status,
        tuesdayStatus: resMon.status,
        mondayReservationIdCount: 0,
        tuesdayReservationIdCount: 0,
        message: `Failed at week ${week} (${firstPlayLabel} · both courts): ${failErr} ${conflict ? formatBulkTimeWindowsForOperator() : ""}`,
        rawResponse: {
          weeks: rawWeeks,
          failed: {
            week,
            step: `${firstPlayLabel} · both courts`,
            plannedDates: {
              firstPlayDate: dates.firstPlayDate,
              secondPlayDate: dates.secondPlayDate,
              shiftedByHoliday: dates.shiftedByHoliday,
              holidayName: dates.holidayName,
            },
            response: resMon,
          },
        },
      };
    }
    createdResponseBlobs.push(resMon.data);

    const resTue = await client.createClinic(config.US_SQUASH_CLUB_ID, bodyTue);
    if (resTue.status < 200 || resTue.status >= 300) {
      await rollbackCreatedClinicResponses(client, createdResponseBlobs);
      const failErr = extractUssquashErrorString(resTue.data) ?? `HTTP ${resTue.status}`;
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
            failedStep: `${secondPlayLabel} · both courts`,
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
        mondayStatus: resTue.status,
        tuesdayStatus: resTue.status,
        mondayReservationIdCount: 0,
        tuesdayReservationIdCount: 0,
        message: `Failed at week ${week} (${secondPlayLabel} · both courts): ${failErr} ${conflict ? formatBulkTimeWindowsForOperator() : ""} Earlier steps were rolled back (best effort).`,
        rawResponse: {
          weeks: rawWeeks,
          failed: {
            week,
            step: `${secondPlayLabel} · both courts`,
            plannedDates: {
              firstPlayDate: dates.firstPlayDate,
              secondPlayDate: dates.secondPlayDate,
              shiftedByHoliday: dates.shiftedByHoliday,
              holidayName: dates.holidayName,
            },
            response: resTue,
          },
        },
      };
    }
    createdResponseBlobs.push(resTue.data);

    monIds.push(...extractReservationIdsFromClinicResponse(resMon.data));
    tueIds.push(...extractReservationIdsFromClinicResponse(resTue.data));
    rawWeeks.push({
      week,
      shiftedByHoliday: dates.shiftedByHoliday,
      holidayName: dates.holidayName,
      firstPlayDate: dates.firstPlayDate,
      secondPlayDate: dates.secondPlayDate,
      mon: {
        combined: { status: resMon.status, data: resMon.data },
      },
      tue: {
        combined: { status: resTue.status, data: resTue.data },
      },
    });
  }
  const expected = seasonWeeks * SLOTS_PER_PLAY_DAY;
  const compactPerWeekExpected = seasonWeeks * 2;
  const compactLegacyMon = monIds.length === 2;
  const compactLegacyTue = tueIds.length === 2;
  const combinedClinicPerWeekLayout =
    monIds.length === seasonWeeks &&
    tueIds.length === seasonWeeks &&
    monIds.length > 0;
  const monOk = monIds.length === 0 || monIds.length === expected ||
    monIds.length === compactPerWeekExpected || compactLegacyMon ||
    combinedClinicPerWeekLayout;
  const tueOk = tueIds.length === 0 || tueIds.length === expected ||
    tueIds.length === compactPerWeekExpected || compactLegacyTue ||
    combinedClinicPerWeekLayout;
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
      locallyConvertedSlotsJson: "[]",
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
        sequentialClinicSteps: seasonWeeks * 2,
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
    message:
      hasIds && monOk && tueOk
        ? combinedClinicPerWeekLayout
          ? "Season block created (Club Locker returned one reservation id per play day per week for the combined two-court clinics; stored for conversion and cancel)."
          : "Season block created (one clinic per play day per week, both courts in each clinic). Reservation ids stored for weekly conversion."
        : !hasIds
          ? "Clinic(s) created but no reservation id parsed from response — conversion may not be able to release blocks."
          : `Clinic(s) were created, but stored id counts (Mon: ${monIds.length}, Tue: ${tueIds.length}) do not match a recognized layout (e.g. ${expected} per weekday for slot-level holds or ${seasonWeeks} per weekday for combined clinics). Check raw responses or Club Locker.`,
    rawResponse: { weeks: rawWeeks },
  };
}

export type ConvertResult = {
  runId: string;
  status: "ok" | "partial" | "error";
  summary: {
    holdKind: "season" | "week";
    deleted: { id: string; status: number; ok: boolean }[];
    created: { key: string; status: number; ok: boolean; reservationId?: string }[];
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
    const combinedClinicPerWeekStoredIds =
      mon.length === seasonHold.seasonWeeks &&
      tue.length === seasonHold.seasonWeeks;
    const usableShape =
      (mon.length === expected && tue.length === expected) ||
      compactPerWeekStoredIds ||
      compactSeriesStoredIds ||
      combinedClinicPerWeekStoredIds;
    if (!usableShape) {
      return {
        runId: "",
        status: "error",
        message:
          `Season hold is missing usable reservation id lists (expected ${expected} slot ids per weekday, ${compactPerWeekExpected} court-level ids per weekday, or ${seasonHold.seasonWeeks} combined-clinic ids per weekday). Re-run or fix API response shape.`,
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
    const d = seasonPlayDates(db, seasonHold.startMondayDate, input.week);
    mondayDate = d.mondayDate;
    tuesdayDate = d.tuesdayDate;
  } else {
    mondayDate = resolved.row.mondayDate;
    tuesdayDate = resolved.row.tuesdayDate;
    reservationIds = JSON.parse(resolved.row.externalReservationIdsJson) as string[];
  }

  const rosterResult = await fetchLiveBoxLeagueRosterForSeason(
    db,
    config,
    input.seasonId,
    client,
  );
  if ("error" in rosterResult) {
    return {
      runId: "",
      status: "error",
      message: rosterResult.error,
      summary: {
        holdKind: resolved.kind,
        deleted: [],
        created: [],
        holdId: resolved.row.id,
      },
    };
  }

  const groundTruth = optionalSeasonStartGroundTruth(db, input.seasonId);
  const seatOverrides = optionalSeatOverrides(db, input.seasonId);
  const live = buildLiveWeekPlan(
    input.week,
    rosterResult.roster,
    mondayDate,
    tuesdayDate,
    config.US_SQUASH_CLUB_ID,
    config.US_SQUASH_COURT_1_ID,
    config.US_SQUASH_COURT_2_ID,
    config.US_SQUASH_CUSTOM_MATCH_TYPE,
    groundTruth,
    seatOverrides,
  );
  if (!liveWeekPlanResolvable(live)) {
    const reason =
      live.issues[0]?.reason ??
      (live.items.length === 0
        ? "No managed match reservations to create from the live roster."
        : "Could not resolve the live roster for this week.");
    return {
      runId: "",
      status: "error",
      message: reason,
      summary: {
        holdKind: resolved.kind,
        deleted: [],
        created: [],
        holdId: resolved.row.id,
      },
    };
  }
  const items: LiveManagedReservationItem[] = live.items;
  const rosterById = new Map(rosterResult.roster.map((p) => [p.id, p]));

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

  const created: {
    key: string;
    status: number;
    ok: boolean;
    reservationId?: string;
  }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (i > 0) {
      await sleepMs(paceBetweenMatchBookingsMs());
    }
    const key = `b${it.boxNumber}-${it.playDate}-c${it.courtId}-${it.slot}`;
    const r = await client.createMatchReservation(
      config.US_SQUASH_CLUB_ID,
      it.body,
    );
    const reservationId =
      r.status >= 200 && r.status < 300
        ? extractReservationIdFromMatchResponse(r.data) ?? undefined
        : undefined;
    created.push({
      key,
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      reservationId,
    });
  }

  const allOk = created.every((c) => c.ok);
  const runId = crypto.randomUUID();

  if (allOk) {
    persistWeekPlanAuditRow(
      db,
      input.seasonId,
      input.week,
      auditPayloadWithLocalPlayerIds(db, live.payload, rosterResult.roster),
    );
  }

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

  for (const it of items) {
    const key = `b${it.boxNumber}-${it.playDate}-c${it.courtId}-${it.slot}`;
    const c = created.find((x) => x.key === key);
    if (!c?.ok) continue;
    const p1 = rosterById.get(it.ussquashPlayerIds[0]);
    const p2 = rosterById.get(it.ussquashPlayerIds[1]);
    if (!p1 || !p2) continue;
    const player1Id = ensurePlayerRowFromUssquash(
      db,
      p1.id,
      it.playerDisplayNames[0],
      p1.rating,
    );
    const player2Id = ensurePlayerRowFromUssquash(
      db,
      p2.id,
      it.playerDisplayNames[1],
      p2.rating,
    );
    try {
      db.insert(houseLeagueBookedOccurrences)
        .values({
          id: crypto.randomUUID(),
          seasonId: input.seasonId,
          weekNumber: input.week,
          playDate: it.playDate,
          slot: it.slot,
          courtId: it.courtId,
          boxNumber: it.boxNumber,
          player1Id,
          player2Id,
          bookingRunId: runId,
          reservationId: c.reservationId ?? null,
        })
        .run();
    } catch {
      // UNIQUE: idempotent inserts if the same matchup was duplicated in DB tooling.
    }
  }

  return {
    runId,
    status: allOk ? "ok" : "partial",
    message: allOk
      ? `Conversion complete: ${created.length} match reservation(s) created.`
      : "Some match reservations failed — see summary.",
    summary: { holdKind, deleted, created, holdId: holdRefId },
  };
}

export type RebookPlayDayResult = {
  runId: string;
  status: "ok" | "partial" | "error";
  message: string;
  summary: {
    playDay: "mon" | "tue";
    playDate: string;
    created: { key: string; status: number; ok: boolean; reservationId?: string }[];
  };
};

/**
 * Create match reservations for one play day (Mon or Tue) on an already-converted week.
 * Skips bulk-hold deletes — for refilling slots cancelled manually in Club Locker.
 */
export async function runRebookPlayDay(
  db: Db,
  config: AppConfig,
  input: {
    seasonId: string;
    week: number;
    playDay: "mon" | "tue";
    holdId?: string;
    startMondayDate?: string;
    confirm: boolean;
  },
  client: UssquashClient = createUssquashClient(config),
): Promise<RebookPlayDayResult> {
  const emptySummary = {
    playDay: input.playDay,
    playDate: "",
    created: [] as RebookPlayDayResult["summary"]["created"],
  };
  if (!input.confirm) {
    return {
      runId: "",
      status: "error",
      message: "confirm must be true to execute",
      summary: emptySummary,
    };
  }

  let hold: SeasonHoldRow | undefined;
  if (input.holdId) {
    hold = findSeasonHold(db, input.seasonId, input.holdId);
  } else if (input.startMondayDate) {
    hold = findSeasonHoldForStartMonday(db, input.seasonId, input.startMondayDate);
  } else {
    hold = findSeasonHold(db, input.seasonId);
  }
  if (!hold) {
    return {
      runId: "",
      status: "error",
      message: "No season hold found for this season.",
      summary: emptySummary,
    };
  }

  const converted = JSON.parse(hold.convertedWeeksJson) as number[];
  if (!converted.includes(input.week)) {
    return {
      runId: "",
      status: "error",
      message: `Week ${input.week} is not marked converted — use Convert visible week for the first booking run.`,
      summary: emptySummary,
    };
  }

  if (input.week < 1 || input.week > HOUSE_LEAGUE_SEMIS_WEEK_NUMBER - 1) {
    return {
      runId: "",
      status: "error",
      message: "Only regular season weeks 1–7 support play-day rebook.",
      summary: emptySummary,
    };
  }

  const dates = seasonPlayDates(db, hold.startMondayDate, input.week);
  const mondayDate = dates.mondayDate;
  const tuesdayDate = dates.tuesdayDate;
  const playDate = input.playDay === "mon" ? mondayDate : tuesdayDate;

  const rosterResult = await fetchLiveBoxLeagueRosterForSeason(
    db,
    config,
    input.seasonId,
    client,
  );
  if ("error" in rosterResult) {
    return {
      runId: "",
      status: "error",
      message: rosterResult.error,
      summary: { ...emptySummary, playDate },
    };
  }

  const groundTruth = optionalSeasonStartGroundTruth(db, input.seasonId);
  const seatOverrides = optionalSeatOverrides(db, input.seasonId);
  const live = buildLiveWeekPlan(
    input.week,
    rosterResult.roster,
    mondayDate,
    tuesdayDate,
    config.US_SQUASH_CLUB_ID,
    config.US_SQUASH_COURT_1_ID,
    config.US_SQUASH_COURT_2_ID,
    config.US_SQUASH_CUSTOM_MATCH_TYPE,
    groundTruth,
    seatOverrides,
  );
  if (!liveWeekPlanResolvable(live)) {
    const reason =
      live.issues[0]?.reason ??
      (live.items.length === 0
        ? "No managed match reservations to create from the live roster."
        : "Could not resolve the live roster for this week.");
    return {
      runId: "",
      status: "error",
      message: reason,
      summary: { ...emptySummary, playDate },
    };
  }

  const items = live.items.filter((it) => it.playDate === playDate);
  if (items.length === 0) {
    return {
      runId: "",
      status: "error",
      message: `No match slots found for ${playDate} in the live week plan.`,
      summary: { ...emptySummary, playDate },
    };
  }

  const rosterById = new Map(rosterResult.roster.map((p) => [p.id, p]));
  const created: RebookPlayDayResult["summary"]["created"] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (i > 0) {
      await sleepMs(paceBetweenMatchBookingsMs());
    }
    const key = `b${it.boxNumber}-${it.playDate}-c${it.courtId}-${it.slot}`;
    const r = await client.createMatchReservation(
      config.US_SQUASH_CLUB_ID,
      it.body,
    );
    const reservationId =
      r.status >= 200 && r.status < 300
        ? extractReservationIdFromMatchResponse(r.data) ?? undefined
        : undefined;
    created.push({
      key,
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      reservationId,
    });
  }

  const allOk = created.every((c) => c.ok);
  const runId = crypto.randomUUID();
  const dayLabel = input.playDay === "mon" ? "Monday" : "Tuesday";

  db.insert(bookingRuns)
    .values({
      id: runId,
      seasonId: input.seasonId,
      kind: "rebook_play_day",
      weekNumber: input.week,
      status: allOk ? "ok" : "partial",
      summaryJson: JSON.stringify({
        playDay: input.playDay,
        playDate,
        created,
        holdId: hold.id,
      }),
      holdId: null,
    })
    .run();

  for (const it of items) {
    const key = `b${it.boxNumber}-${it.playDate}-c${it.courtId}-${it.slot}`;
    const c = created.find((x) => x.key === key);
    if (!c?.ok) continue;
    const p1 = rosterById.get(it.ussquashPlayerIds[0]);
    const p2 = rosterById.get(it.ussquashPlayerIds[1]);
    if (!p1 || !p2) continue;
    const player1Id = ensurePlayerRowFromUssquash(
      db,
      p1.id,
      it.playerDisplayNames[0],
      p1.rating,
    );
    const player2Id = ensurePlayerRowFromUssquash(
      db,
      p2.id,
      it.playerDisplayNames[1],
      p2.rating,
    );
    try {
      db.insert(houseLeagueBookedOccurrences)
        .values({
          id: crypto.randomUUID(),
          seasonId: input.seasonId,
          weekNumber: input.week,
          playDate: it.playDate,
          slot: it.slot,
          courtId: it.courtId,
          boxNumber: it.boxNumber,
          player1Id,
          player2Id,
          bookingRunId: runId,
          reservationId: c.reservationId ?? null,
        })
        .run();
    } catch {
      // UNIQUE: prior occurrence row may still exist after a manual Club Locker cancel.
    }
  }

  const okCount = created.filter((c) => c.ok).length;
  return {
    runId,
    status: allOk ? "ok" : "partial",
    message: allOk
      ? `${dayLabel} rebook complete: ${okCount} match reservation(s) created for ${playDate}.`
      : `${dayLabel} rebook partial: ${okCount}/${items.length} match reservation(s) created — see summary.`,
    summary: { playDay: input.playDay, playDate, created },
  };
}

export type CancellableCalendarRow = {
  rowId: string;
  kind: "bulk" | "match";
  week: number;
  date: string;
  begin: string;
  end: string;
  label: string;
  /** Club Locker reservation ids to DELETE for this row (Stadium + Center). */
  reservationIds: string[];
  /** False when ids are missing (e.g. old convert run without stored ids). */
  complete: boolean;
};

function playDayKindForDate(
  weekDates: { firstPlayDate: string; secondPlayDate: string },
  iso: string,
): "mon" | "tue" | null {
  if (iso === weekDates.firstPlayDate) return "mon";
  if (iso === weekDates.secondPlayDate) return "tue";
  return null;
}

/** First–last clock window for all bulk slots on that league weekday. */
function bulkHoldDaySpan(day: "mon" | "tue"): { begin: string; end: string } {
  const slots = bulkHoldSlotsForWeekday(day);
  const first = slots[0];
  const last = slots[slots.length - 1];
  if (!first || !last) return { begin: "00:00", end: "23:59" };
  return { begin: first.begin, end: last.end };
}

function isFullBulkDaySpan(
  day: "mon" | "tue",
  begin: string,
  end: string,
): boolean {
  const span = bulkHoldDaySpan(day);
  return span.begin === begin && span.end === end;
}

function normalizeReservationIdListJson(json: string): string[] {
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((x) => String(x).trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

type InferredBulkHoldShape =
  | { kind: "full"; weeks: number }
  | { kind: "compact_weekly"; weeks: number }
  | { kind: "compact_series" }
  | { kind: "combined_clinic_per_week"; weeks: number }
  | { kind: "unknown" };

/**
 * Derive how many bulk weeks are actually stored from JSON lengths.
 * Declared `season_weeks` often disagrees (e.g. 8 vs 7 weeks actually booked).
 *
 * **Ambiguity**: live Club Locker bulk runs often store `seasonWeeks * 2` ids per weekday
 * (one id per court per week). That length can equal exactly one `"full"` week of ids
 * (16 = `SLOTS_PER_PLAY_DAY`). When {@link declaredSeasonWeeks} is known (from
 * `season_booking_holds.season_weeks`), prefer resolving against it first.
 */
export function inferBulkHoldShape(
  mon: string[],
  tue: string[],
  declaredSeasonWeeks?: number,
): InferredBulkHoldShape {
  if (mon.length !== tue.length || mon.length === 0) {
    return { kind: "unknown" };
  }
  const n = mon.length;
  const declaredOk =
    typeof declaredSeasonWeeks === "number" &&
    Number.isFinite(declaredSeasonWeeks) &&
    declaredSeasonWeeks >= 1 &&
    declaredSeasonWeeks <= 1000;

  /**
   * One `id` per league week per weekday (combined two-court clinic POST), not 16 slot-level ids.
   * Must run before `n === 2` compact_series so a 2-week season is not misread as stadium+center series.
   */
  if (declaredOk && n === declaredSeasonWeeks) {
    return { kind: "combined_clinic_per_week", weeks: declaredSeasonWeeks };
  }

  /** One Stadium + one Center recurring clinic covering all occurrences on this weekday. */
  if (n === 2) {
    return { kind: "compact_series" };
  }

  if (declaredOk) {
    const asCompactWeekly = declaredSeasonWeeks * 2;
    const asFull = declaredSeasonWeeks * SLOTS_PER_PLAY_DAY;
    if (n === asCompactWeekly) {
      return { kind: "compact_weekly", weeks: declaredSeasonWeeks };
    }
    if (n === asFull) {
      return { kind: "full", weeks: declaredSeasonWeeks };
    }
  }

  if (n % SLOTS_PER_PLAY_DAY === 0) {
    return { kind: "full", weeks: n / SLOTS_PER_PLAY_DAY };
  }
  if (n % 2 === 0) {
    return { kind: "compact_weekly", weeks: n / 2 };
  }
  return { kind: "unknown" };
}

function findSeasonHoldForStartMonday(
  db: Db,
  seasonId: string,
  startMondayDate: string,
): SeasonHoldRow | undefined {
  const rows = db
    .select()
    .from(seasonBookingHolds)
    .where(
      and(
        eq(seasonBookingHolds.seasonId, seasonId),
        eq(seasonBookingHolds.startMondayDate, startMondayDate),
      ),
    )
    .orderBy(desc(seasonBookingHolds.createdAt))
    .all();
  return rows.find((h) => h.status === "active" || h.status === "fully_converted");
}

/**
 * All reservation ids Club Locker holds for one league play day (Mon or Tue) in one season week.
 * - Full layout: 8 slots × 2 courts = 16 ids per day per week.
 * - Compact weekly: 2 ids (Stadium + Center) per day per booked week.
 * - Combined two-court clinic: one Club Locker `id` per weekday per league week (same id covers both courts).
 *
 * When {@link courtSide} is set, only that court’s ids are returned (one id for compact layouts;
 * all Stadium or all Center slot-ids for the day in the full layout).
 */
function getBulkDayReservationIds(
  db: Db,
  hold: SeasonHoldRow,
  week: number,
  playDate: string,
  courtSide?: "stadium" | "center",
): { ids: string[] } | { error: string } {
  const mon = normalizeReservationIdListJson(hold.mondayReservationIdsJson);
  const tue = normalizeReservationIdListJson(hold.tuesdayReservationIdsJson);
  const shape = inferBulkHoldShape(mon, tue, hold.seasonWeeks);
  const weekDates = seasonWeekPlayDatesForDb(db, hold.startMondayDate, week);
  const day = playDayKindForDate(weekDates, playDate);
  if (!day) {
    return { error: "That date is not a play day for this league week." };
  }
  const arr = day === "mon" ? mon : tue;

  const maxWeek =
    shape.kind === "full" ||
    shape.kind === "compact_weekly" ||
    shape.kind === "combined_clinic_per_week"
      ? Math.min(shape.weeks, hold.seasonWeeks)
      : hold.seasonWeeks;

  if (week < 1 || week > maxWeek) {
    return { error: "Week is outside this season block." };
  }

  if (shape.kind === "full") {
    const off = (week - 1) * SLOTS_PER_PLAY_DAY;
    const chunk = arr.slice(off, off + SLOTS_PER_PLAY_DAY);
    if (chunk.length !== SLOTS_PER_PLAY_DAY) {
      return { error: "Missing reservation ids for this day in the local hold." };
    }
    if (courtSide === "stadium") {
      const ids = chunk.filter((_, i) => i % 2 === 0);
      if (ids.length !== SLOTS_PER_PLAY_DAY / 2) {
        return { error: "Missing Stadium reservation ids for this day in the local hold." };
      }
      return { ids };
    }
    if (courtSide === "center") {
      const ids = chunk.filter((_, i) => i % 2 === 1);
      if (ids.length !== SLOTS_PER_PLAY_DAY / 2) {
        return { error: "Missing Center reservation ids for this day in the local hold." };
      }
      return { ids };
    }
    return { ids: chunk };
  }

  if (shape.kind === "combined_clinic_per_week") {
    const id = arr[week - 1];
    if (!id) {
      return { error: "Missing reservation ids for this day in the local hold." };
    }
    /**
     * Club Locker stores one reservation/clinic id for the whole two-court block that day.
     * Per-court UI rows still delete via this id (clears the combined booking).
     */
    return { ids: [id] };
  }

  if (shape.kind === "compact_weekly") {
    const off = (week - 1) * 2;
    const stadiumId = arr[off];
    const centerId = arr[off + 1];
    if (!stadiumId || !centerId) {
      return { error: "Missing reservation ids for this day in the local hold." };
    }
    if (courtSide === "stadium") return { ids: [stadiumId] };
    if (courtSide === "center") return { ids: [centerId] };
    return { ids: [stadiumId, centerId] };
  }

  if (shape.kind === "compact_series") {
    const stadiumId = arr[0];
    const centerId = arr[1];
    if (!stadiumId || !centerId) {
      return { error: "Missing reservation ids for this day in the local hold." };
    }
    if (courtSide === "stadium") return { ids: [stadiumId] };
    if (courtSide === "center") return { ids: [centerId] };
    return { ids: [stadiumId, centerId] };
  }

  /** Mismatched lengths or odd layout: try this weekday column only. */
  const off = (week - 1) * 2;
  if (off + 2 <= arr.length) {
    const stadiumId = arr[off];
    const centerId = arr[off + 1];
    if (stadiumId && centerId) {
      if (courtSide === "stadium") return { ids: [stadiumId] };
      if (courtSide === "center") return { ids: [centerId] };
      return { ids: [stadiumId, centerId] };
    }
  }

  return {
    error:
      "This season hold uses a legacy reservation id layout. Cancel in Club Locker or remove the local hold.",
  };
}

/**
 * Interleaved bulk layout: for each time slot, ids are [Stadium/court1, Center/court2]
 * (matches {@link allBulkSlotsForSingleDay} slot order; season bulk stores one combined clinic per play day).
 */
function getBulkReservationIdsForSlotFromHold(
  db: Db,
  hold: SeasonHoldRow,
  week: number,
  playDate: string,
  begin: string,
  end: string,
  courtSide?: "stadium" | "center",
): { ids: string[] } | { error: string } {
  const mon = normalizeReservationIdListJson(hold.mondayReservationIdsJson);
  const tue = normalizeReservationIdListJson(hold.tuesdayReservationIdsJson);
  const shape = inferBulkHoldShape(mon, tue, hold.seasonWeeks);
  if (shape.kind !== "full") {
    return {
      error:
        "Per-slot cancel needs the expanded (16 ids per weekday per week) hold layout. Right-click still cancels the whole play day for this week, or use the day rows in Cancel bookings.",
    };
  }
  const expected = shape.weeks * SLOTS_PER_PLAY_DAY;
  if (mon.length !== expected || tue.length !== expected) {
    return {
      error:
        "Per-slot cancel needs the expanded (16 ids per weekday per week) hold layout. Right-click still cancels the whole play day for this week, or use the day rows in Cancel bookings.",
    };
  }
  const maxWeek = Math.min(shape.weeks, hold.seasonWeeks);
  if (week < 1 || week > maxWeek) {
    return { error: "Week is outside this season block." };
  }
  const weekDates = seasonWeekPlayDatesForDb(db, hold.startMondayDate, week);
  const day = playDayKindForDate(weekDates, playDate);
  if (!day) {
    return { error: "That date is not a play day for this league week." };
  }
  const daySlots = bulkHoldSlotsForWeekday(day);
  const slotIdx = daySlots.findIndex((s) => s.begin === begin && s.end === end);
  if (slotIdx < 0) {
    return { error: "That time does not match a bulk league slot." };
  }
  const arr = day === "mon" ? mon : tue;
  const offset = (week - 1) * SLOTS_PER_PLAY_DAY + slotIdx * 2;
  const stadiumId = arr[offset];
  const centerId = arr[offset + 1];
  if (courtSide === "stadium") {
    if (!stadiumId) {
      return { error: "Missing reservation id for Stadium at this slot in the local hold." };
    }
    return { ids: [stadiumId] };
  }
  if (courtSide === "center") {
    if (!centerId) {
      return { error: "Missing reservation id for Center at this slot in the local hold." };
    }
    return { ids: [centerId] };
  }
  if (!stadiumId || !centerId) {
    return { error: "Missing reservation ids for this slot in the local hold." };
  }
  return { ids: [stadiumId, centerId] };
}

function resolveBulkReservationIdsForCancel(
  db: Db,
  hold: SeasonHoldRow,
  week: number,
  date: string,
  begin: string,
  end: string,
  courtSide?: "stadium" | "center",
): { ids: string[] } | { error: string } {
  const mon = normalizeReservationIdListJson(hold.mondayReservationIdsJson);
  const tue = normalizeReservationIdListJson(hold.tuesdayReservationIdsJson);
  const shape = inferBulkHoldShape(mon, tue, hold.seasonWeeks);
  const weekDates = seasonWeekPlayDatesForDb(db, hold.startMondayDate, week);
  const day = playDayKindForDate(weekDates, date);
  if (!day) {
    return { error: "That date is not a play day for this league week." };
  }

  if (shape.kind === "full") {
    if (isFullBulkDaySpan(day, begin, end)) {
      return getBulkDayReservationIds(db, hold, week, date, courtSide);
    }
    const slot = getBulkReservationIdsForSlotFromHold(
      db,
      hold,
      week,
      date,
      begin,
      end,
      courtSide,
    );
    if ("error" in slot) return slot;
    return { ids: [...slot.ids] };
  }

  /**
   * Compact layouts store one Stadium + one Center reservation per play day (or one recurring
   * series per weekday). There is no per-slot id — "replace green bulk" cancels the whole court
   * block for that day (test workflow), then books a single match.
   */
  if (
    shape.kind === "compact_weekly" ||
    shape.kind === "compact_series" ||
    shape.kind === "combined_clinic_per_week"
  ) {
    return getBulkDayReservationIds(db, hold, week, date, courtSide);
  }

  return getBulkDayReservationIds(db, hold, week, date, courtSide);
}

function stripReservationIdsFromSeasonHold(
  db: Db,
  holdId: string,
  idsToRemove: Set<string>,
): void {
  const h = db
    .select()
    .from(seasonBookingHolds)
    .where(eq(seasonBookingHolds.id, holdId))
    .get();
  if (!h) return;
  const mon = JSON.parse(h.mondayReservationIdsJson) as string[];
  const tue = JSON.parse(h.tuesdayReservationIdsJson) as string[];
  const mon2 = mon.filter((id) => !idsToRemove.has(id));
  const tue2 = tue.filter((id) => !idsToRemove.has(id));
  if (mon2.length === mon.length && tue2.length === tue.length) return;
  const bulkIdsGone = mon2.length === 0 && tue2.length === 0;
  db.update(seasonBookingHolds)
    .set({
      mondayReservationIdsJson: JSON.stringify(mon2),
      tuesdayReservationIdsJson: JSON.stringify(tue2),
      ...(bulkIdsGone ? { status: "cancelled" as const } : {}),
    })
    .where(eq(seasonBookingHolds.id, holdId))
    .run();
}

function latestConvertRunForWeek(
  db: Db,
  seasonId: string,
  week: number,
): { created: { key: string; ok: boolean; reservationId?: string }[] } | null {
  const row = db
    .select()
    .from(bookingRuns)
    .where(
      and(
        eq(bookingRuns.seasonId, seasonId),
        eq(bookingRuns.kind, "convert"),
        eq(bookingRuns.weekNumber, week),
      ),
    )
    .orderBy(desc(bookingRuns.createdAt))
    .limit(1)
    .get();
  if (!row || row.status === "error") return null;
  try {
    const s = JSON.parse(row.summaryJson) as {
      created?: { key: string; ok: boolean; reservationId?: string }[];
    };
    return { created: s.created ?? [] };
  } catch {
    return null;
  }
}

function previewItemReservationKey(item: {
  box: number;
  date: string;
  courtId: string;
  slot: string;
}): string {
  return `b${item.box}-${item.date}-c${item.courtId}-${item.slot}`;
}

export async function getMatchReservationIdsForCalendarSlot(
  db: Db,
  config: AppConfig,
  input: {
    seasonId: string;
    startMondayDate: string;
    week: number;
    date: string;
    begin: string;
    end: string;
  },
  client: UssquashClient = createUssquashClient(config),
): Promise<{ ids: string[] } | { error: string }> {
  const dates = seasonWeekPlayDatesForDb(db, input.startMondayDate, input.week);
  if (input.date !== dates.firstPlayDate && input.date !== dates.secondPlayDate) {
    return { error: "That date is not a play day for this league week." };
  }
  let preview:
    | {
        items: { box: number; date: string; courtId: string; slot: string; players: string[] }[];
      }
    | { error: string } = previewBookingFromStoredWeekPlan(
    db,
    config,
    input.seasonId,
    input.week,
    dates.firstPlayDate,
    dates.secondPlayDate,
  );
  if ("error" in preview) {
    preview = await previewBooking(
      db,
      config,
      input.seasonId,
      input.week,
      dates.firstPlayDate,
      dates.secondPlayDate,
      client,
    );
  }
  if ("error" in preview) {
    return { error: preview.error };
  }
  const conv = latestConvertRunForWeek(db, input.seasonId, input.week);
  if (!conv) {
    return { error: "No conversion run found for this week (reservation ids unknown)." };
  }
  const slotStr = `${input.begin}-${input.end}`;
  const itemsForSlot = preview.items.filter(
    (it) => it.date === input.date && it.slot === slotStr,
  );
  if (itemsForSlot.length === 0) {
    return { error: "No converted match reservations mapped to this slot." };
  }
  const idByKey = new Map<string, string>();
  for (const c of conv.created) {
    if (c.ok && c.reservationId) idByKey.set(c.key, c.reservationId);
  }
  const ids: string[] = [];
  for (const it of itemsForSlot) {
    const id = idByKey.get(previewItemReservationKey(it));
    if (id) ids.push(id);
  }
  if (ids.length === 0) {
    return {
      error:
        "Reservation ids were not stored for this week (convert again, or cancel in Club Locker).",
    };
  }
  return { ids };
}

function twoPlayerVsFromNames(players: string[]): string | null {
  const [a, b] = players;
  if (!a || !b) return null;
  return `${a} v ${b}`;
}

async function listMatchCancellableRowsForWeek(
  db: Db,
  config: AppConfig,
  seasonId: string,
  startMondayDate: string,
  week: number,
  client: UssquashClient = createUssquashClient(config),
): Promise<CancellableCalendarRow[]> {
  const dates = seasonWeekPlayDatesForDb(db, startMondayDate, week);
  let preview:
    | {
        items: { box: number; date: string; courtId: string; slot: string; players: string[] }[];
      }
    | { error: string } = previewBookingFromStoredWeekPlan(
    db,
    config,
    seasonId,
    week,
    dates.firstPlayDate,
    dates.secondPlayDate,
  );
  if ("error" in preview) {
    preview = await previewBooking(
      db,
      config,
      seasonId,
      week,
      dates.firstPlayDate,
      dates.secondPlayDate,
      client,
    );
  }
  if ("error" in preview) return [];

  const conv = latestConvertRunForWeek(db, seasonId, week);
  const idByKey = new Map<string, string>();
  if (conv) {
    for (const c of conv.created) {
      if (c.ok && c.reservationId) idByKey.set(c.key, c.reservationId);
    }
  }

  const rows: CancellableCalendarRow[] = [];
  const bySlot = new Map<
    string,
    { date: string; slot: string; items: typeof preview.items }
  >();
  for (const it of preview.items) {
    const k = `${it.date}|${it.slot}`;
    let g = bySlot.get(k);
    if (!g) {
      g = { date: it.date, slot: it.slot, items: [] };
      bySlot.set(k, g);
    }
    g.items.push(it);
  }

  for (const g of bySlot.values()) {
    const parts = g.slot.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
    const begin = parts?.[1] ?? "";
    const end = parts?.[2] ?? "";
    const reservationIds: string[] = [];
    for (const it of g.items) {
      const id = idByKey.get(previewItemReservationKey(it));
      if (id) reservationIds.push(id);
    }
    const vs = [...new Set(g.items.map((i) => twoPlayerVsFromNames(i.players)))].filter(
      Boolean,
    );
    const slotNote = begin && end ? `${begin}–${end}` : g.slot;
    rows.push({
      rowId: `match-${week}-${g.date}-${g.slot}`,
      kind: "match",
      week,
      date: g.date,
      begin,
      end,
      label: `Match · ${bulkCancelWeekLabelPart(week)} · ${g.date} · ${slotNote}${vs.length ? ` · ${vs.join(" · ")}` : ""}`,
      reservationIds,
      complete: reservationIds.length === g.items.length && g.items.length > 0,
    });
  }

  return rows;
}

/**
 * All cancellable rows for this season hold (every booked week: two play days per bulk week,
 * or match rows for converted weeks).
 */
export async function listAllCancellableBookings(
  db: Db,
  config: AppConfig,
  seasonId: string,
  startMondayDate: string,
  client: UssquashClient = createUssquashClient(config),
): Promise<CancellableCalendarRow[]> {
  const hold = findSeasonHoldForStartMonday(db, seasonId, startMondayDate);
  if (!hold) return [];

  const converted = JSON.parse(hold.convertedWeeksJson) as number[];
  const rows: CancellableCalendarRow[] = [];
  const mon = normalizeReservationIdListJson(hold.mondayReservationIdsJson);
  const tue = normalizeReservationIdListJson(hold.tuesdayReservationIdsJson);

  /** No Mon/Tue bulk ids left — avoid showing every week as "incomplete" after a full cancel. */
  if (hold.status === "active" && mon.length === 0 && tue.length === 0) {
    for (let week = 1; week <= hold.seasonWeeks; week++) {
      if (converted.includes(week)) {
        rows.push(
          ...(await listMatchCancellableRowsForWeek(
            db,
            config,
            seasonId,
            startMondayDate,
            week,
            client,
          )),
        );
      }
    }
    return rows;
  }

  const shape = inferBulkHoldShape(mon, tue, hold.seasonWeeks);
  const bulkWeekCap =
    shape.kind === "full" ||
    shape.kind === "compact_weekly" ||
    shape.kind === "combined_clinic_per_week"
      ? Math.min(shape.weeks, hold.seasonWeeks)
      : hold.seasonWeeks;

  for (let week = 1; week <= hold.seasonWeeks; week++) {
    if (converted.includes(week)) {
      rows.push(
        ...(await listMatchCancellableRowsForWeek(
          db,
          config,
          seasonId,
          startMondayDate,
          week,
          client,
        )),
      );
    } else if (hold.status === "active") {
      if (
        (shape.kind === "full" ||
          shape.kind === "compact_weekly" ||
          shape.kind === "combined_clinic_per_week") &&
        week > bulkWeekCap
      ) {
        continue;
      }
      const dates = seasonWeekPlayDatesForDb(db, startMondayDate, week);
      for (const day of ["mon", "tue"] as const) {
        const iso = day === "mon" ? dates.firstPlayDate : dates.secondPlayDate;
        const span = bulkHoldDaySpan(day);
        const resolved = getBulkDayReservationIds(db, hold, week, iso);
        const complete = !("error" in resolved);
        const ids = complete ? resolved.ids : [];
        rows.push({
          rowId: `bulk-${week}-${iso}-day`,
          kind: "bulk",
          week,
          date: iso,
          begin: span.begin,
          end: span.end,
          label: `Bulk hold · ${bulkCancelWeekLabelPart(week)} · ${iso} · ${day === "mon" ? "Monday" : "Tuesday"} · all slots (both courts)`,
          reservationIds: ids,
          complete,
        });
      }
    }
  }

  return rows;
}

/**
 * Rows the booking calendar can cancel for one season week (subset of {@link listAllCancellableBookings}).
 */
export async function listCancellableBookingsForWeek(
  db: Db,
  config: AppConfig,
  seasonId: string,
  startMondayDate: string,
  week: number,
  client: UssquashClient = createUssquashClient(config),
): Promise<CancellableCalendarRow[]> {
  return (await listAllCancellableBookings(db, config, seasonId, startMondayDate, client)).filter(
    (r) => r.week === week,
  );
}

export type CancelCalendarItem =
  | {
      kind: "bulk";
      week: number;
      date: string;
      begin: string;
      end: string;
      /** When set (full layout only), only that court’s bulk clinic id is cancelled for the slot. */
      courtSide?: "stadium" | "center";
    }
  | { kind: "match"; week: number; date: string; begin: string; end: string };

function calendarCancelDedupeKey(it: CancelCalendarItem): string {
  const court =
    it.kind === "bulk" && it.courtSide != null ? `:${it.courtSide}` : "";
  return `${it.kind}:${it.week}:${it.date}:${it.begin}:${it.end}${court}`;
}

/**
 * Delete Club Locker reservations for calendar picks and drop their ids from the local season hold.
 */
export async function cancelBookingCalendarItems(
  db: Db,
  config: AppConfig,
  input: {
    seasonId: string;
    startMondayDate: string;
    notifyUsers: boolean;
    items: CancelCalendarItem[];
  },
  client: UssquashClient = createUssquashClient(config),
): Promise<
  | {
      ok: true;
      deleted: { id: string; status: number; ok: boolean }[];
      message: string;
    }
  | { ok: false; error: string }
> {
  const hold = findSeasonHoldForStartMonday(db, input.seasonId, input.startMondayDate);
  if (!hold) {
    return { ok: false, error: "No season hold found for this start Monday." };
  }

  const seen = new Set<string>();
  const unique: CancelCalendarItem[] = [];
  for (const it of input.items) {
    const k = calendarCancelDedupeKey(it);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(it);
  }

  const toDelete: string[] = [];
  for (const item of unique) {
    if (item.kind === "bulk") {
      const r = resolveBulkReservationIdsForCancel(
        db,
        hold,
        item.week,
        item.date,
        item.begin,
        item.end,
        item.courtSide,
      );
      if ("error" in r) return { ok: false, error: r.error };
      toDelete.push(...r.ids);
    } else {
      const r = await getMatchReservationIdsForCalendarSlot(db, config, {
        seasonId: input.seasonId,
        startMondayDate: input.startMondayDate,
        week: item.week,
        date: item.date,
        begin: item.begin,
        end: item.end,
      }, client);
      if ("error" in r) return { ok: false, error: r.error };
      toDelete.push(...r.ids);
    }
  }

  const uniqueIds = [...new Set(toDelete)];
  if (uniqueIds.length === 0) {
    return { ok: false, error: "Nothing to cancel." };
  }

  const deleted: { id: string; status: number; ok: boolean }[] = [];
  for (const id of uniqueIds) {
    const d = await client.deleteReservation(id, input.notifyUsers);
    deleted.push({ id, status: d.status, ok: d.status >= 200 && d.status < 300 });
  }

  const okIds = new Set(
    deleted.filter((x) => x.ok).map((x) => x.id),
  );
  if (okIds.size > 0) {
    stripReservationIdsFromSeasonHold(db, hold.id, okIds);
  }

  const okCount = deleted.filter((x) => x.ok).length;
  if (okCount === 0) {
    return {
      ok: false,
      error: "Club Locker did not delete any reservations (check ids / credentials).",
    };
  }

  const message =
    okCount === deleted.length
      ? `Cancelled ${okCount} reservation(s) in Club Locker and updated the local season hold.`
      : `${okCount} of ${deleted.length} reservation delete(s) succeeded; check Club Locker for failures.`;

  return { ok: true, deleted, message };
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

function findLatestSeasonHoldRow(
  db: Db,
  seasonId: string,
  startMondayDate: string,
): SeasonHoldRow | undefined {
  return db
    .select()
    .from(seasonBookingHolds)
    .where(
      and(
        eq(seasonBookingHolds.seasonId, seasonId),
        eq(seasonBookingHolds.startMondayDate, startMondayDate),
      ),
    )
    .orderBy(desc(seasonBookingHolds.createdAt))
    .get();
}

export type MarkWeekLocalDisplay = "bulk_held" | "converted";

export type LocalBookingSlotRef = {
  week: number;
  date: string;
  begin: string;
  end: string;
};

export function localBookingSlotKey(slot: LocalBookingSlotRef): string {
  return `${slot.week}|${slot.date}|${slot.begin}-${slot.end}`;
}

function parseLocallyConvertedSlotKeys(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === "string" && k.includes("|"));
  } catch {
    return [];
  }
}

/**
 * Update season-hold metadata so the booking calendar reflects Club Locker reality
 * without calling Club Locker (green = bulk-held week, purple = converted week).
 */
export function markWeekBookingDisplayLocal(
  db: Db,
  input: {
    seasonId: string;
    startMondayDate: string;
    week: number;
    display: MarkWeekLocalDisplay;
  },
): { ok: true; message: string; holdId: string } | { ok: false; error: string } {
  const hold = findLatestSeasonHoldRow(db, input.seasonId, input.startMondayDate);
  if (!hold) {
    return {
      ok: false,
      error:
        "No season hold record for this start Monday. Run season block (bulk) once so a hold row exists, then mark locally.",
    };
  }
  if (input.week < 1 || input.week > hold.seasonWeeks) {
    return { ok: false, error: `Week must be 1–${hold.seasonWeeks} for this hold.` };
  }

  const converted = JSON.parse(hold.convertedWeeksJson) as number[];
  const localSlots = parseLocallyConvertedSlotKeys(hold.locallyConvertedSlotsJson);
  let nextConverted: number[];
  let nextLocalSlots: string[];
  let nextStatus: "active" | "fully_converted";

  if (input.display === "bulk_held") {
    nextConverted = converted.filter((w) => w !== input.week);
    nextLocalSlots = localSlots.filter((k) => !k.startsWith(`${input.week}|`));
    nextStatus = "active";
  } else {
    nextConverted = [...new Set([...converted, input.week])].sort((a, b) => a - b);
    nextLocalSlots = localSlots.filter((k) => !k.startsWith(`${input.week}|`));
    nextStatus =
      nextConverted.length >= hold.seasonWeeks ? "fully_converted" : "active";
    if (!latestConvertRunForWeek(db, input.seasonId, input.week)) {
      db.insert(bookingRuns)
        .values({
          id: crypto.randomUUID(),
          seasonId: input.seasonId,
          kind: "convert",
          weekNumber: input.week,
          status: "ok",
          summaryJson: JSON.stringify({
            holdKind: "season",
            deleted: [],
            created: [],
            holdId: hold.id,
            localDisplayOnly: true,
          }),
          holdId: null,
        })
        .run();
    }
  }

  db.update(seasonBookingHolds)
    .set({
      convertedWeeksJson: JSON.stringify(nextConverted),
      locallyConvertedSlotsJson: JSON.stringify(nextLocalSlots),
      status: nextStatus,
    })
    .where(eq(seasonBookingHolds.id, hold.id))
    .run();

  const label =
    input.display === "bulk_held"
      ? "bulk-held (green on calendar)"
      : "converted to matches (purple on calendar)";
  return {
    ok: true,
    holdId: hold.id,
    message: `Week ${input.week} marked as ${label} in this app only. Club Locker was not changed.`,
  };
}

/**
 * Mark one league time row as converted (purple) or bulk-held (green) on the calendar only.
 */
export function markSlotBookingDisplayLocal(
  db: Db,
  input: {
    seasonId: string;
    startMondayDate: string;
    week: number;
    date: string;
    begin: string;
    end: string;
    display: MarkWeekLocalDisplay;
  },
): { ok: true; message: string; holdId: string } | { ok: false; error: string } {
  const hold = findLatestSeasonHoldRow(db, input.seasonId, input.startMondayDate);
  if (!hold) {
    return {
      ok: false,
      error:
        "No season hold record for this start Monday. Run season block (bulk) once so a hold row exists.",
    };
  }
  if (input.week < 1 || input.week > hold.seasonWeeks) {
    return { ok: false, error: `Week must be 1–${hold.seasonWeeks} for this hold.` };
  }

  const convertedWeeks = JSON.parse(hold.convertedWeeksJson) as number[];
  if (convertedWeeks.includes(input.week)) {
    return {
      ok: false,
      error: `Week ${input.week} is already marked converted for the whole week — use “Show week as bulk-held” to revert.`,
    };
  }

  const key = localBookingSlotKey(input);
  const localSlots = new Set(parseLocallyConvertedSlotKeys(hold.locallyConvertedSlotsJson));

  if (input.display === "converted") {
    localSlots.add(key);
  } else {
    localSlots.delete(key);
  }

  db.update(seasonBookingHolds)
    .set({
      locallyConvertedSlotsJson: JSON.stringify([...localSlots].sort()),
    })
    .where(eq(seasonBookingHolds.id, hold.id))
    .run();

  const timeLabel = `${input.begin}–${input.end}`;
  const label =
    input.display === "converted"
      ? "converted (purple on calendar)"
      : "bulk-held (green on calendar)";
  return {
    ok: true,
    holdId: hold.id,
    message: `${formatISODateLongEn(input.date)} ${timeLabel} marked as ${label} in this app only. Club Locker was not changed.`,
  };
}

function formatISODateLongEn(iso: string): string {
  const [y, mo, day] = iso.split("-").map(Number);
  if (!y || !mo || !day) return iso;
  const d = new Date(y, mo - 1, day);
  const weekdayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const monthShort = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][d.getMonth()];
  return `${weekdayShort}, ${monthShort} ${d.getDate()}, ${d.getFullYear()}`;
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

/** TEMP: fixed Stadium test window (verified open in Club Locker). */
export const STADIUM_ID_MAP_TEST_SLOT = { begin: "15:10", end: "15:50" } as const;

/**
 * TEMP: Book Stadium-court players from one green bulk slot at 15:10 using the same
 * live-roster resolution as Convert Visible Week (ussquash player ids → Club Locker).
 */
export async function runStadiumIdMapTestBooking(
  db: Db,
  config: AppConfig,
  input: {
    seasonId: string;
    week: number;
    mondayDate: string;
    tuesdayDate: string;
    date: string;
    sourceBegin: string;
    sourceEnd: string;
  },
  client: UssquashClient = createUssquashClient(config),
) {
  const rosterResult = await fetchLiveBoxLeagueRosterForSeason(
    db,
    config,
    input.seasonId,
    client,
  );
  if ("error" in rosterResult) {
    return { ok: false as const, message: rosterResult.error };
  }

  const court1Id = config.US_SQUASH_COURT_1_ID;
  const groundTruth = optionalSeasonStartGroundTruth(db, input.seasonId);
  const seatOverrides = optionalSeatOverrides(db, input.seasonId);
  const live = buildLiveWeekPlan(
    input.week,
    rosterResult.roster,
    input.mondayDate,
    input.tuesdayDate,
    config.US_SQUASH_CLUB_ID,
    court1Id,
    config.US_SQUASH_COURT_2_ID,
    config.US_SQUASH_CUSTOM_MATCH_TYPE,
    groundTruth,
    seatOverrides,
  );
  if (!liveWeekPlanResolvable(live)) {
    const reason =
      live.issues[0]?.reason ??
      (live.items.length === 0
        ? "No managed match reservations to create from the live roster."
        : "Could not resolve the live roster for this week.");
    return { ok: false as const, message: reason };
  }

  const sourceSlot = formatReservationSlot(input.sourceBegin, input.sourceEnd);
  const match = live.items.find(
    (it) =>
      it.playDate === input.date &&
      it.courtId === court1Id &&
      it.slot === sourceSlot,
  );
  if (!match) {
    return {
      ok: false as const,
      message: `No Stadium match found for ${input.date} ${sourceSlot} in the live week plan.`,
    };
  }

  const [player1SsmId, player2SsmId] = match.ussquashPlayerIds;
  const [player1Name, player2Name] = match.playerDisplayNames;
  const booking = await runSingleCourtMatchBooking(config, {
    date: input.date,
    slotBegin: STADIUM_ID_MAP_TEST_SLOT.begin,
    slotEnd: STADIUM_ID_MAP_TEST_SLOT.end,
    courtSide: "stadium",
    player1SsmId,
    player2SsmId,
    player1Name,
    player2Name,
  });

  return {
    ok: booking.ok,
    message: booking.message,
    sourceMatch: {
      boxNumber: match.boxNumber,
      player1SsmId,
      player2SsmId,
      player1Name,
      player2Name,
    },
    testSlot: STADIUM_ID_MAP_TEST_SLOT,
    booking,
  };
}

export type BookSlotBothCourtsCourtResult = {
  courtSide: "stadium" | "center";
  boxNumber: number;
  player1Name: string;
  player2Name: string;
  ok: boolean;
  message: string;
};

export type BookSlotBothCourtsNoBulkCancelResult = {
  ok: boolean;
  message: string;
  courts: BookSlotBothCourtsCourtResult[];
};

/**
 * Book Stadium and Center matches for one green bulk slot from the live US Squash roster.
 * Does not cancel bulk holds (overlapping bulk + match is possible until converted).
 */
export async function runBookSlotBothCourtsNoBulkCancel(
  db: Db,
  config: AppConfig,
  input: {
    seasonId: string;
    week: number;
    mondayDate: string;
    tuesdayDate: string;
    date: string;
    begin: string;
    end: string;
  },
  client: UssquashClient = createUssquashClient(config),
): Promise<BookSlotBothCourtsNoBulkCancelResult> {
  const rosterResult = await fetchLiveBoxLeagueRosterForSeason(
    db,
    config,
    input.seasonId,
    client,
  );
  if ("error" in rosterResult) {
    return { ok: false, message: rosterResult.error, courts: [] };
  }

  const court1Id = config.US_SQUASH_COURT_1_ID;
  const court2Id = config.US_SQUASH_COURT_2_ID;
  const groundTruth = optionalSeasonStartGroundTruth(db, input.seasonId);
  const seatOverrides = optionalSeatOverrides(db, input.seasonId);
  const live = buildLiveWeekPlan(
    input.week,
    rosterResult.roster,
    input.mondayDate,
    input.tuesdayDate,
    config.US_SQUASH_CLUB_ID,
    court1Id,
    court2Id,
    config.US_SQUASH_CUSTOM_MATCH_TYPE,
    groundTruth,
    seatOverrides,
  );
  if (!liveWeekPlanResolvable(live)) {
    const reason =
      live.issues[0]?.reason ??
      (live.items.length === 0
        ? "No managed match reservations to create from the live roster."
        : "Could not resolve the live roster for this week.");
    return { ok: false, message: reason, courts: [] };
  }

  const sourceSlot = formatReservationSlot(input.begin, input.end);
  const stadiumMatch = live.items.find(
    (it) =>
      it.playDate === input.date &&
      it.courtId === court1Id &&
      it.slot === sourceSlot,
  );
  const centerMatch = live.items.find(
    (it) =>
      it.playDate === input.date &&
      it.courtId === court2Id &&
      it.slot === sourceSlot,
  );
  if (!stadiumMatch && !centerMatch) {
    return {
      ok: false,
      message: `No Stadium or Center match found for ${input.date} ${sourceSlot} in the live week plan.`,
      courts: [],
    };
  }

  const courts: BookSlotBothCourtsCourtResult[] = [];
  const pairs: {
    courtSide: "stadium" | "center";
    match: (typeof live.items)[number];
  }[] = [];
  if (stadiumMatch) pairs.push({ courtSide: "stadium", match: stadiumMatch });
  if (centerMatch) pairs.push({ courtSide: "center", match: centerMatch });

  for (const { courtSide, match } of pairs) {
    const [player1SsmId, player2SsmId] = match.ussquashPlayerIds;
    const [player1Name, player2Name] = match.playerDisplayNames;
    const booking = await runSingleCourtMatchBooking(config, {
      date: input.date,
      slotBegin: input.begin,
      slotEnd: input.end,
      courtSide,
      player1SsmId,
      player2SsmId,
      player1Name,
      player2Name,
    });
    courts.push({
      courtSide,
      boxNumber: match.boxNumber,
      player1Name,
      player2Name,
      ok: booking.ok,
      message: booking.message,
    });
  }

  const allOk = courts.every((c) => c.ok);
  const anyOk = courts.some((c) => c.ok);
  const label = (c: BookSlotBothCourtsCourtResult) =>
    `${c.courtSide === "stadium" ? "Stadium" : "Center"}: ${c.player1Name} vs ${c.player2Name}`;
  const message = allOk
    ? `Booked ${courts.length} match${courts.length === 1 ? "" : "es"} (${courts.map(label).join("; ")}).`
    : anyOk
      ? `Partial booking: ${courts.map((c) => `${label(c)} — ${c.ok ? "ok" : c.message}`).join("; ")}`
      : courts.map((c) => `${label(c)}: ${c.message}`).join("; ");

  return { ok: allOk, message, courts };
}
