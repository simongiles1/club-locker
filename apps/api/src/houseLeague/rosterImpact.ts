import { and, asc, eq, inArray } from "drizzle-orm";
import {
  bulkHoldSlotsForWeekday,
  MANAGED_BOX_NUMBER_MAX,
  parseReservationSlotWindow,
  REGULAR_SEASON_GRID_WEEKS,
  seasonWeekPlayDatesWithRegistry,
  type StatHoliday,
} from "@squash/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  houseLeagueBookedOccurrences,
  houseLeagueMatchReminderSends,
  houseLeagueWeeklyBoxSends,
  players,
  seasonBookingHolds,
  seasons,
  statutoryHolidays,
} from "../db/schema.js";
import {
  createUssquashClient,
  extractReservationIdFromMatchResponse,
  type UssquashClient,
} from "../booking/clubLockerClient.js";
import {
  buildLiveWeekPlan,
  liveWeekPlanResolvable,
  type LiveManagedReservationItem,
  type LiveWeekPlanBuildIssue,
} from "../booking/liveWeekPlan.js";
import {
  ensurePlayerRowFromUssquash,
  fetchLiveBoxLeagueRosterForSeason,
  seasonPlayDates,
} from "../booking/service.js";
import { loadSeasonStartGroundTruthPlayers } from "./seasonStartRoster.js";
import { loadSeatOverridesForSeason } from "./relativeRankOverrides.js";
import { stageWeeklyBoxEmails } from "./weeklyBoxEmail.js";
import type { EmailAdapter } from "../adapters/email.js";
import type { LiveBoxLeaguePlayer } from "../booking/liveWeekPlan.js";

export type CourtImpactStatus =
  | "mismatch"
  | "missing_booking"
  | "extra_booking"
  | "ok";

export type WeekFilter =
  | "current_and_future"
  | "all_converted"
  | { weekNumbers: number[] };

export type CourtImpactRow = {
  weekNumber: number;
  playDate: string;
  boxNumber: number;
  slotLabel: string;
  courtId: number;
  slot: string;
  status: CourtImpactStatus;
  managed: boolean;
  before: {
    playerNames: [string, string] | null;
    ussquashPlayerIds: [number, number] | null;
    reservationId: string | null;
    occurrenceId: string | null;
  };
  after: {
    playerNames: [string, string];
    ussquashPlayerIds: [number, number];
  } | null;
};

export type EmailImpactKind = "weekly_box" | "season_box_eml" | "match_reminder";

export type EmailImpactRow = {
  kind: EmailImpactKind;
  weekNumber: number | null;
  boxNumber: number | null;
  label: string;
  alreadySent: boolean;
  sentAt: string | null;
  action: "force_resend" | "regenerate_download" | "info_only";
  detail?: string;
};

export type RosterImpactBlocker = {
  weekNumber: number;
  issues: LiveWeekPlanBuildIssue[];
};

export type ComputeRosterImpactOptions = {
  weekFilter?: WeekFilter;
  /** YYYY-MM-DD local club date; defaults to today UTC date slice */
  asOfDate?: string;
};

export type RosterImpactResult = {
  seasonId: string;
  asOfDate: string;
  convertedWeeks: number[];
  weeksScanned: number[];
  courtRows: CourtImpactRow[];
  emailRows: EmailImpactRow[];
  blockers: RosterImpactBlocker[];
  court1Id: number;
  court2Id: number;
  summary: {
    courtSlotsNeedingUpdate: number;
    weeksWithCourtChanges: number[];
    boxesForSeasonEml: number[];
  };
};

function todayIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function statHolidayRegistryFromDb(db: Db): StatHoliday[] {
  return db
    .select()
    .from(statutoryHolidays)
    .orderBy(asc(statutoryHolidays.date))
    .all()
    .map((r) => ({
      name: r.name,
      date: r.date,
      hours: {
        open: r.openTime,
        close: r.closeTime,
        closed: r.closed === 1,
      },
      kind: r.closureKind === "event" ? ("event" as const) : ("holiday" as const),
    }));
}

function latestSeasonHold(db: Db, seasonId: string) {
  return db
    .select()
    .from(seasonBookingHolds)
    .where(eq(seasonBookingHolds.seasonId, seasonId))
    .all()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

function convertedWeeksFromHold(hold: { convertedWeeksJson: string }): number[] {
  try {
    const raw = JSON.parse(hold.convertedWeeksJson) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n >= 1);
  } catch {
    return [];
  }
}

function slotKey(parts: {
  weekNumber: number;
  playDate: string;
  slot: string;
  courtId: number;
  boxNumber: number;
}): string {
  return `${parts.weekNumber}|${parts.playDate}|${parts.slot}|${parts.courtId}|${parts.boxNumber}`;
}

function ussquashPairFromLocalIds(
  db: Db,
  player1Id: string,
  player2Id: string,
): [number, number] | null {
  const p1 = db.select().from(players).where(eq(players.id, player1Id)).get();
  const p2 = db.select().from(players).where(eq(players.id, player2Id)).get();
  if (!p1?.externalId || !p2?.externalId) return null;
  const a = Number(p1.externalId);
  const b = Number(p2.externalId);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}

function playerNamesFromLocalIds(
  db: Db,
  player1Id: string,
  player2Id: string,
): [string, string] {
  const p1 = db.select().from(players).where(eq(players.id, player1Id)).get();
  const p2 = db.select().from(players).where(eq(players.id, player2Id)).get();
  return [p1?.displayName ?? "?", p2?.displayName ?? "?"];
}

function pairsEqual(
  a: [number, number] | null,
  b: [number, number] | null,
): boolean {
  if (a == null || b == null) return false;
  return (
    (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0])
  );
}

function weekPassesDateFilter(
  weekNumber: number,
  startMondayDate: string,
  asOfDate: string,
  holidays: StatHoliday[],
  filter: WeekFilter,
): boolean {
  if (filter === "all_converted") return true;
  if (typeof filter === "object" && "weekNumbers" in filter) {
    return filter.weekNumbers.includes(weekNumber);
  }
  const dates = seasonWeekPlayDatesWithRegistry(
    startMondayDate,
    weekNumber,
    holidays,
  );
  return (
    dates.firstPlayDate >= asOfDate || dates.secondPlayDate >= asOfDate
  );
}

function resolveWeeksToScan(
  converted: number[],
  startMondayDate: string,
  asOfDate: string,
  holidays: StatHoliday[],
  filter: WeekFilter,
): number[] {
  return converted
    .filter((w) => w >= 1 && w <= REGULAR_SEASON_GRID_WEEKS)
    .filter((w) =>
      weekPassesDateFilter(w, startMondayDate, asOfDate, holidays, filter),
    )
    .sort((a, b) => a - b);
}

export async function computeHouseLeagueRosterImpact(
  db: Db,
  config: AppConfig,
  seasonId: string,
  options: ComputeRosterImpactOptions = {},
  client: UssquashClient = createUssquashClient(config),
): Promise<RosterImpactResult | { error: string }> {
  const asOfDate = options.asOfDate ?? todayIsoDate();
  const weekFilter: WeekFilter = options.weekFilter ?? "current_and_future";

  const season = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
  if (!season) return { error: "season_not_found" };

  const hold = latestSeasonHold(db, seasonId);
  const court1Id = config.US_SQUASH_COURT_1_ID;
  const court2Id = config.US_SQUASH_COURT_2_ID;

  if (!hold) {
    return {
      seasonId,
      asOfDate,
      convertedWeeks: [],
      weeksScanned: [],
      courtRows: [],
      emailRows: [],
      blockers: [],
      court1Id,
      court2Id,
      summary: {
        courtSlotsNeedingUpdate: 0,
        weeksWithCourtChanges: [],
        boxesForSeasonEml: [],
      },
    };
  }

  const convertedWeeks = convertedWeeksFromHold(hold);
  const holidays = statHolidayRegistryFromDb(db);
  const weeksScanned = resolveWeeksToScan(
    convertedWeeks,
    hold.startMondayDate,
    asOfDate,
    holidays,
    weekFilter,
  );

  const rosterResult = await fetchLiveBoxLeagueRosterForSeason(
    db,
    config,
    seasonId,
    client,
  );
  if ("error" in rosterResult) return rosterResult;

  const groundTruthRoster = loadSeasonStartGroundTruthPlayers(
    db,
    seasonId,
  ) as LiveBoxLeaguePlayer[];

  const courtRows: CourtImpactRow[] = [];
  const blockers: RosterImpactBlocker[] = [];
  const weeksWithCourtChanges = new Set<number>();
  const boxesTouched = new Set<number>();

  for (const weekNumber of weeksScanned) {
    const { mondayDate, tuesdayDate } = seasonPlayDates(
      db,
      hold.startMondayDate,
      weekNumber,
      holidays,
    );
    const live = buildLiveWeekPlan(
      weekNumber,
      rosterResult.roster,
      mondayDate,
      tuesdayDate,
      config.US_SQUASH_CLUB_ID,
      config.US_SQUASH_COURT_1_ID,
      config.US_SQUASH_COURT_2_ID,
      config.US_SQUASH_CUSTOM_MATCH_TYPE,
      groundTruthRoster.length > 0 ? groundTruthRoster : undefined,
      loadSeatOverridesForSeason(db, seasonId),
    );

    if (live.issues.length > 0) {
      blockers.push({ weekNumber, issues: live.issues });
    }

    const expectedByKey = new Map<
      string,
      LiveManagedReservationItem & { weekNumber: number }
    >();
    for (const it of live.items) {
      expectedByKey.set(
        slotKey({
          weekNumber,
          playDate: it.playDate,
          slot: it.slot,
          courtId: it.courtId,
          boxNumber: it.boxNumber,
        }),
        { ...it, weekNumber },
      );
    }

    const occurrences = db
      .select()
      .from(houseLeagueBookedOccurrences)
      .where(
        and(
          eq(houseLeagueBookedOccurrences.seasonId, seasonId),
          eq(houseLeagueBookedOccurrences.weekNumber, weekNumber),
        ),
      )
      .all();

    const actualByKey = new Map<string, (typeof occurrences)[number]>();
    for (const occ of occurrences) {
      actualByKey.set(
        slotKey({
          weekNumber: occ.weekNumber,
          playDate: occ.playDate,
          slot: occ.slot,
          courtId: occ.courtId,
          boxNumber: occ.boxNumber,
        }),
        occ,
      );
    }

    const allKeys = new Set([...expectedByKey.keys(), ...actualByKey.keys()]);

    for (const key of allKeys) {
      const expected = expectedByKey.get(key);
      const actual = actualByKey.get(key);
      const boxNumber = expected?.boxNumber ?? actual?.boxNumber ?? 0;
      const managed = boxNumber <= MANAGED_BOX_NUMBER_MAX;

      if (!managed) continue;

      if (expected && !actual) {
        weeksWithCourtChanges.add(weekNumber);
        boxesTouched.add(boxNumber);
        courtRows.push({
          weekNumber,
          playDate: expected.playDate,
          boxNumber,
          slotLabel: expected.slotLabel,
          courtId: expected.courtId,
          slot: expected.slot,
          status: "missing_booking",
          managed: true,
          before: {
            playerNames: null,
            ussquashPlayerIds: null,
            reservationId: null,
            occurrenceId: null,
          },
          after: {
            playerNames: expected.playerDisplayNames,
            ussquashPlayerIds: expected.ussquashPlayerIds,
          },
        });
        continue;
      }

      if (actual && !expected) {
        weeksWithCourtChanges.add(weekNumber);
        boxesTouched.add(boxNumber);
        const names = playerNamesFromLocalIds(
          db,
          actual.player1Id,
          actual.player2Id,
        );
        const slotWindow = parseReservationSlotWindow(actual.slot);
        const slotLabel =
          bulkHoldSlotsForWeekday(
            actual.playDate === mondayDate ? "mon" : "tue",
          ).find(
            (s) =>
              slotWindow != null &&
              s.begin === slotWindow.begin &&
              s.end === slotWindow.end,
          )?.slotLabel ?? actual.slot;
        courtRows.push({
          weekNumber,
          playDate: actual.playDate,
          boxNumber,
          slotLabel,
          courtId: actual.courtId,
          slot: actual.slot,
          status: "extra_booking",
          managed: true,
          before: {
            playerNames: names,
            ussquashPlayerIds: ussquashPairFromLocalIds(
              db,
              actual.player1Id,
              actual.player2Id,
            ),
            reservationId: actual.reservationId,
            occurrenceId: actual.id,
          },
          after: null,
        });
        continue;
      }

      if (expected && actual) {
        const beforeIds = ussquashPairFromLocalIds(
          db,
          actual.player1Id,
          actual.player2Id,
        );
        const match = pairsEqual(beforeIds, expected.ussquashPlayerIds);
        const status: CourtImpactStatus = match ? "ok" : "mismatch";
        if (!match) {
          weeksWithCourtChanges.add(weekNumber);
          boxesTouched.add(boxNumber);
        }
        courtRows.push({
          weekNumber,
          playDate: expected.playDate,
          boxNumber,
          slotLabel: expected.slotLabel,
          courtId: expected.courtId,
          slot: expected.slot,
          status,
          managed: true,
          before: {
            playerNames: playerNamesFromLocalIds(
              db,
              actual.player1Id,
              actual.player2Id,
            ),
            ussquashPlayerIds: beforeIds,
            reservationId: actual.reservationId,
            occurrenceId: actual.id,
          },
          after: {
            playerNames: expected.playerDisplayNames,
            ussquashPlayerIds: expected.ussquashPlayerIds,
          },
        });
      }
    }
  }

  const emailRows: EmailImpactRow[] = [];
  const rosterBoxNumbers = [
    ...new Set(
      rosterResult.roster
        .map((p) => p.level)
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ].sort((a, b) => a - b);

  for (const weekNumber of weeksWithCourtChanges) {
    const boxesInWeek = new Set(
      courtRows
        .filter(
          (r) =>
            r.weekNumber === weekNumber &&
            r.status !== "ok" &&
            r.managed,
        )
        .map((r) => r.boxNumber),
    );
    const weekHasManagedCourtChange = boxesInWeek.size > 0;
    for (const boxNumber of rosterBoxNumbers) {
      const managed = boxNumber <= MANAGED_BOX_NUMBER_MAX;
      const include =
        (managed && boxesInWeek.has(boxNumber)) ||
        (!managed && weekHasManagedCourtChange);
      if (!include) continue;

      const sendRow = db
        .select()
        .from(houseLeagueWeeklyBoxSends)
        .where(
          and(
            eq(houseLeagueWeeklyBoxSends.seasonId, seasonId),
            eq(houseLeagueWeeklyBoxSends.weekNumber, weekNumber),
            eq(houseLeagueWeeklyBoxSends.boxNumber, boxNumber),
            eq(houseLeagueWeeklyBoxSends.matchIndex, 0),
          ),
        )
        .get();

      emailRows.push({
        kind: "weekly_box",
        weekNumber,
        boxNumber,
        label: `Week ${weekNumber} · Box ${boxNumber}`,
        alreadySent: sendRow != null,
        sentAt: sendRow?.sentAt ?? null,
        action: "force_resend",
        detail: managed
          ? "Court bookings changed for this box."
          : "Roster changed in a converted week; re-send weekly email.",
      });
    }
  }

  if (boxesTouched.size > 0 || weeksWithCourtChanges.size > 0) {
    for (const boxNumber of rosterBoxNumbers) {
      emailRows.push({
        kind: "season_box_eml",
        weekNumber: null,
        boxNumber,
        label: `Season schedule · Box ${boxNumber}`,
        alreadySent: false,
        sentAt: null,
        action: "regenerate_download",
        detail: "Download updated box .eml from Emails tab.",
      });
    }
  }

  const staleOccurrenceIds = courtRows
    .filter((r) => r.status !== "ok" && r.before.occurrenceId)
    .map((r) => r.before.occurrenceId!)
    .filter(Boolean);

  if (staleOccurrenceIds.length > 0) {
    const reminderCount = db
      .select()
      .from(houseLeagueMatchReminderSends)
      .where(
        inArray(
          houseLeagueMatchReminderSends.occurrenceId,
          staleOccurrenceIds,
        ),
      )
      .all().length;
    if (reminderCount > 0) {
      emailRows.push({
        kind: "match_reminder",
        weekNumber: null,
        boxNumber: null,
        label: "Match reminders",
        alreadySent: true,
        sentAt: null,
        action: "info_only",
        detail: `${reminderCount} reminder(s) were sent for bookings that will change. No automatic resend in v1.`,
      });
    }
  }

  const courtSlotsNeedingUpdate = courtRows.filter(
    (r) => r.status !== "ok",
  ).length;

  return {
    seasonId,
    asOfDate,
    convertedWeeks,
    weeksScanned,
    courtRows,
    emailRows,
    blockers,
    court1Id,
    court2Id,
    summary: {
      courtSlotsNeedingUpdate,
      weeksWithCourtChanges: [...weeksWithCourtChanges].sort((a, b) => a - b),
      boxesForSeasonEml: [...boxesTouched].sort((a, b) => a - b),
    },
  };
}

const MATCH_BOOKING_PACE_BASE_MS = 5000;
const MATCH_BOOKING_PACE_JITTER_MS = 2000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paceBetweenMatchBookingsMs(): number {
  return (
    MATCH_BOOKING_PACE_BASE_MS +
    Math.random() * MATCH_BOOKING_PACE_JITTER_MS
  );
}

export type ApplyRosterBookingInput = {
  seasonId: string;
  weekNumbers: number[];
  confirm: boolean;
  notifyOnDelete?: boolean;
  dryRun?: boolean;
};

export type ApplyRosterBookingResult = {
  ok: boolean;
  dryRun: boolean;
  message: string;
  weeks: {
    weekNumber: number;
    cancelled: { reservationId: string; ok: boolean }[];
    created: { key: string; ok: boolean; reservationId?: string }[];
    occurrencesRemoved: number;
    occurrencesAdded: number;
    error?: string;
  }[];
};

export async function applyHouseLeagueRosterBookingUpdates(
  db: Db,
  config: AppConfig,
  input: ApplyRosterBookingInput,
  client: UssquashClient = createUssquashClient(config),
): Promise<ApplyRosterBookingResult> {
  if (!input.confirm) {
    return {
      ok: false,
      dryRun: !!input.dryRun,
      message: "confirm must be true to execute",
      weeks: [],
    };
  }

  const hold = latestSeasonHold(db, input.seasonId);
  if (!hold) {
    return {
      ok: false,
      dryRun: !!input.dryRun,
      message: "No season booking hold for this season.",
      weeks: [],
    };
  }

  const converted = new Set(convertedWeeksFromHold(hold));
  const invalidWeek = input.weekNumbers.find((w) => !converted.has(w));
  if (invalidWeek != null) {
    return {
      ok: false,
      dryRun: !!input.dryRun,
      message: `Week ${invalidWeek} is not converted yet.`,
      weeks: [],
    };
  }

  const rosterResult = await fetchLiveBoxLeagueRosterForSeason(
    db,
    config,
    input.seasonId,
    client,
  );
  if ("error" in rosterResult) {
    return {
      ok: false,
      dryRun: !!input.dryRun,
      message: rosterResult.error,
      weeks: [],
    };
  }

  const holidays = statHolidayRegistryFromDb(db);
  const notify = input.notifyOnDelete !== false;
  const weekResults: ApplyRosterBookingResult["weeks"] = [];
  const groundTruthRoster = loadSeasonStartGroundTruthPlayers(
    db,
    input.seasonId,
  ) as LiveBoxLeaguePlayer[];

  for (const weekNumber of [...input.weekNumbers].sort((a, b) => a - b)) {
    const { mondayDate, tuesdayDate } = seasonPlayDates(
      db,
      hold.startMondayDate,
      weekNumber,
      holidays,
    );
    const live = buildLiveWeekPlan(
      weekNumber,
      rosterResult.roster,
      mondayDate,
      tuesdayDate,
      config.US_SQUASH_CLUB_ID,
      config.US_SQUASH_COURT_1_ID,
      config.US_SQUASH_COURT_2_ID,
      config.US_SQUASH_CUSTOM_MATCH_TYPE,
      groundTruthRoster.length > 0 ? groundTruthRoster : undefined,
      loadSeatOverridesForSeason(db, input.seasonId),
    );

    if (!liveWeekPlanResolvable(live)) {
      const reason =
        live.issues[0]?.reason ?? "Live roster cannot be resolved for this week.";
      weekResults.push({
        weekNumber,
        cancelled: [],
        created: [],
        occurrencesRemoved: 0,
        occurrencesAdded: 0,
        error: reason,
      });
      continue;
    }

    const occurrences = db
      .select()
      .from(houseLeagueBookedOccurrences)
      .where(
        and(
          eq(houseLeagueBookedOccurrences.seasonId, input.seasonId),
          eq(houseLeagueBookedOccurrences.weekNumber, weekNumber),
        ),
      )
      .all();

    const cancelled: ApplyRosterBookingResult["weeks"][number]["cancelled"] =
      [];

    if (!input.dryRun) {
      for (const occ of occurrences) {
        const rid = occ.reservationId?.trim();
        if (!rid) continue;
        const d = await client.deleteReservation(rid, notify);
        cancelled.push({
          reservationId: rid,
          ok: d.status >= 200 && d.status < 300,
        });
      }

      if (cancelled.some((c) => !c.ok)) {
        weekResults.push({
          weekNumber,
          cancelled,
          created: [],
          occurrencesRemoved: 0,
          occurrencesAdded: 0,
          error:
            "Some Club Locker reservations could not be cancelled; week left unchanged.",
        });
        continue;
      }

      for (const occ of occurrences) {
        db.delete(houseLeagueBookedOccurrences)
          .where(eq(houseLeagueBookedOccurrences.id, occ.id))
          .run();
      }
    }

    const created: ApplyRosterBookingResult["weeks"][number]["created"] = [];
    const rosterById = new Map(rosterResult.roster.map((p) => [p.id, p]));

    if (!input.dryRun) {
      for (let i = 0; i < live.items.length; i++) {
        const it = live.items[i]!;
        if (i > 0) await sleepMs(paceBetweenMatchBookingsMs());
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
          ok: r.status >= 200 && r.status < 300,
          reservationId,
        });
      }

      for (const it of live.items) {
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
        db.insert(houseLeagueBookedOccurrences)
          .values({
            id: crypto.randomUUID(),
            seasonId: input.seasonId,
            weekNumber,
            playDate: it.playDate,
            slot: it.slot,
            courtId: it.courtId,
            boxNumber: it.boxNumber,
            player1Id,
            player2Id,
            bookingRunId: null,
            reservationId: c.reservationId ?? null,
          })
          .run();
      }
    } else {
      for (const it of live.items) {
        const key = `b${it.boxNumber}-${it.playDate}-c${it.courtId}-${it.slot}`;
        created.push({ key, ok: true });
      }
    }

    const okCount = created.filter((c) => c.ok).length;
    weekResults.push({
      weekNumber,
      cancelled: input.dryRun
        ? occurrences
            .filter((o) => o.reservationId)
            .map((o) => ({
              reservationId: o.reservationId!,
              ok: true,
            }))
        : cancelled,
      created,
      occurrencesRemoved: input.dryRun ? occurrences.length : occurrences.length,
      occurrencesAdded: input.dryRun ? live.items.length : okCount,
      error:
        !input.dryRun && okCount < live.items.length
          ? `Only ${okCount}/${live.items.length} match reservations created.`
          : undefined,
    });
  }

  const allOk = weekResults.every((w) => !w.error);
  return {
    ok: allOk,
    dryRun: !!input.dryRun,
    message: input.dryRun
      ? "Dry run: no Club Locker or database changes made."
      : allOk
        ? "Court bookings updated for selected weeks."
        : "Some weeks failed — see per-week errors.",
    weeks: weekResults,
  };
}

export type ApplyCourtSlotInput = {
  seasonId: string;
  weekNumber: number;
  playDate: string;
  slot: string;
  courtId: number;
  boxNumber: number;
  confirm: boolean;
  notifyOnDelete?: boolean;
};

export type ApplyCourtSlotResult = {
  ok: boolean;
  message: string;
  skipped?: boolean;
  deletedReservationId?: string | null;
  createdReservationId?: string | null;
};

export async function applyHouseLeagueRosterCourtSlot(
  db: Db,
  config: AppConfig,
  input: ApplyCourtSlotInput,
  client: UssquashClient = createUssquashClient(config),
): Promise<ApplyCourtSlotResult> {
  if (!input.confirm) {
    return { ok: false, message: "confirm must be true to execute" };
  }
  if (input.boxNumber > MANAGED_BOX_NUMBER_MAX) {
    return {
      ok: false,
      message: `Box ${input.boxNumber} is not a managed match box (1–${MANAGED_BOX_NUMBER_MAX}).`,
    };
  }

  const hold = latestSeasonHold(db, input.seasonId);
  if (!hold) {
    return { ok: false, message: "No season booking hold for this season." };
  }
  const converted = convertedWeeksFromHold(hold);
  if (!converted.includes(input.weekNumber)) {
    return {
      ok: false,
      message: `Week ${input.weekNumber} is not converted yet.`,
    };
  }

  const rosterResult = await fetchLiveBoxLeagueRosterForSeason(
    db,
    config,
    input.seasonId,
    client,
  );
  if ("error" in rosterResult) {
    return { ok: false, message: rosterResult.error };
  }

  const holidays = statHolidayRegistryFromDb(db);
  const { mondayDate, tuesdayDate } = seasonPlayDates(
    db,
    hold.startMondayDate,
    input.weekNumber,
    holidays,
  );
  const groundTruthRoster = loadSeasonStartGroundTruthPlayers(
    db,
    input.seasonId,
  ) as LiveBoxLeaguePlayer[];
  const live = buildLiveWeekPlan(
    input.weekNumber,
    rosterResult.roster,
    mondayDate,
    tuesdayDate,
    config.US_SQUASH_CLUB_ID,
    config.US_SQUASH_COURT_1_ID,
    config.US_SQUASH_COURT_2_ID,
    config.US_SQUASH_CUSTOM_MATCH_TYPE,
    groundTruthRoster.length > 0 ? groundTruthRoster : undefined,
    loadSeatOverridesForSeason(db, input.seasonId),
  );
  const key = slotKey({
    weekNumber: input.weekNumber,
    playDate: input.playDate,
    slot: input.slot,
    courtId: input.courtId,
    boxNumber: input.boxNumber,
  });
  const expected = live.items.find(
    (it) =>
      slotKey({
        weekNumber: input.weekNumber,
        playDate: it.playDate,
        slot: it.slot,
        courtId: it.courtId,
        boxNumber: it.boxNumber,
      }) === key,
  );

  const actual = db
    .select()
    .from(houseLeagueBookedOccurrences)
    .where(
      and(
        eq(houseLeagueBookedOccurrences.seasonId, input.seasonId),
        eq(houseLeagueBookedOccurrences.weekNumber, input.weekNumber),
        eq(houseLeagueBookedOccurrences.playDate, input.playDate),
        eq(houseLeagueBookedOccurrences.slot, input.slot),
        eq(houseLeagueBookedOccurrences.courtId, input.courtId),
        eq(houseLeagueBookedOccurrences.boxNumber, input.boxNumber),
      ),
    )
    .get();

  const beforeIds =
    actual != null
      ? ussquashPairFromLocalIds(db, actual.player1Id, actual.player2Id)
      : null;
  const alreadyOk =
    expected != null &&
    actual != null &&
    pairsEqual(beforeIds, expected.ussquashPlayerIds);
  if (alreadyOk) {
    return {
      ok: true,
      skipped: true,
      message: "Booking already matches live roster.",
    };
  }
  if (expected == null && actual == null) {
    return { ok: true, skipped: true, message: "No booking to update." };
  }

  const notify = input.notifyOnDelete !== false;
  let deletedReservationId: string | null = null;

  if (actual) {
    const rid = actual.reservationId?.trim();
    if (rid) {
      const d = await client.deleteReservation(rid, notify);
      if (d.status < 200 || d.status >= 300) {
        return {
          ok: false,
          message: `Could not cancel Club Locker reservation ${rid}.`,
          deletedReservationId: rid,
        };
      }
      deletedReservationId = rid;
    }
    db.delete(houseLeagueBookedOccurrences)
      .where(eq(houseLeagueBookedOccurrences.id, actual.id))
      .run();
  }

  if (!expected) {
    return {
      ok: true,
      message: "Removed extra booking.",
      deletedReservationId,
      createdReservationId: null,
    };
  }

  const r = await client.createMatchReservation(
    config.US_SQUASH_CLUB_ID,
    expected.body,
  );
  const createdReservationId =
    r.status >= 200 && r.status < 300
      ? extractReservationIdFromMatchResponse(r.data) ?? null
      : null;
  if (!createdReservationId) {
    return {
      ok: false,
      message: "Club Locker did not return a reservation id for the new match.",
      deletedReservationId,
      createdReservationId: null,
    };
  }

  const rosterById = new Map(rosterResult.roster.map((p) => [p.id, p]));
  const p1 = rosterById.get(expected.ussquashPlayerIds[0]);
  const p2 = rosterById.get(expected.ussquashPlayerIds[1]);
  if (!p1 || !p2) {
    return {
      ok: false,
      message: "Could not resolve roster players for the new booking.",
      deletedReservationId,
      createdReservationId,
    };
  }
  const player1Id = ensurePlayerRowFromUssquash(
    db,
    p1.id,
    expected.playerDisplayNames[0],
    p1.rating,
  );
  const player2Id = ensurePlayerRowFromUssquash(
    db,
    p2.id,
    expected.playerDisplayNames[1],
    p2.rating,
  );
  db.insert(houseLeagueBookedOccurrences)
    .values({
      id: crypto.randomUUID(),
      seasonId: input.seasonId,
      weekNumber: input.weekNumber,
      playDate: expected.playDate,
      slot: expected.slot,
      courtId: expected.courtId,
      boxNumber: expected.boxNumber,
      player1Id,
      player2Id,
      bookingRunId: null,
      reservationId: createdReservationId,
    })
    .run();

  return {
    ok: true,
    message: "Court booking updated.",
    deletedReservationId,
    createdReservationId,
  };
}

export type ApplyRosterEmailInput = {
  seasonId: string;
  weekly: { weekNumber: number; boxNumbers?: number[] }[];
  confirm: boolean;
  dryRun?: boolean;
};

export type ApplyRosterEmailResult = {
  ok: boolean;
  dryRun: boolean;
  message: string;
  weekly: {
    weekNumber: number;
    staged: number;
    sent: number;
    skipped: number;
    warnings: string[];
  }[];
  seasonBoxNumbers: number[];
};

export async function applyHouseLeagueRosterEmailUpdates(
  db: Db,
  config: AppConfig,
  emailAdapter: EmailAdapter,
  input: ApplyRosterEmailInput,
  autoSend: boolean,
): Promise<ApplyRosterEmailResult> {
  if (!input.confirm) {
    return {
      ok: false,
      dryRun: !!input.dryRun,
      message: "confirm must be true to execute",
      weekly: [],
      seasonBoxNumbers: [],
    };
  }

  const weeklyResults: ApplyRosterEmailResult["weekly"] = [];

  for (const row of input.weekly) {
    const out = await stageWeeklyBoxEmails(db, config, emailAdapter, {
      seasonId: input.seasonId,
      weekNumber: row.weekNumber,
      autoSend: input.dryRun ? false : autoSend,
      mode: "normal",
      dryRun: input.dryRun,
      force: true,
      boxNumbers: row.boxNumbers,
    });
    weeklyResults.push({
      weekNumber: row.weekNumber,
      staged: out.staged,
      sent: out.sent,
      skipped: out.skipped,
      warnings: out.warnings,
    });
  }

  const seasonBoxNumbers = [
    ...new Set(
      input.weekly.flatMap((w) => w.boxNumbers ?? []).filter((n) => n > 0),
    ),
  ].sort((a, b) => a - b);

  return {
    ok: true,
    dryRun: !!input.dryRun,
    message: input.dryRun
      ? "Dry run: weekly sends counted but not staged."
      : "Weekly emails staged or sent.",
    weekly: weeklyResults,
    seasonBoxNumbers,
  };
}
