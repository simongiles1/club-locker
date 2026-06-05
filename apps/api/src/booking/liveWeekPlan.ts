import {
  boxNumberForScheduleSlot,
  bulkHoldSlotsForWeekday,
  getWeekMatchups,
  livePlayerAtScheduleSeat,
  MANAGED_BOX_NUMBER_MAX,
  scheduleMatchPairNeedsCourtBooking,
  REGULAR_SEASON_GRID_WEEKS,
} from "@squash/shared";
import type { CreateMatchReservationBody } from "./clubLockerClient.js";
import { formatReservationSlot } from "./slotMap.js";
import type { WeekPlanBox, WeekPlanPayload } from "./payloads.js";

/** US Squash box league player row (subset used for booking). */
export type LiveBoxLeaguePlayer = {
  id: number;
  firstName: string;
  lastName: string;
  level: number;
  playerCurrentRank: number;
  rating: number;
};

export function normalizeLiveBoxLeaguePlayers(data: unknown): LiveBoxLeaguePlayer[] {
  if (!Array.isArray(data)) return [];
  const out: LiveBoxLeaguePlayer[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = Number(r.id);
    const level = Number(r.level);
    const playerCurrentRank = Number(r.playerCurrentRank);
    if (
      !Number.isFinite(id) ||
      id <= 0 ||
      !Number.isFinite(level) ||
      !Number.isFinite(playerCurrentRank)
    ) {
      continue;
    }
    const firstName = typeof r.firstName === "string" ? r.firstName : "";
    const lastName = typeof r.lastName === "string" ? r.lastName : "";
    const rating = Number(r.rating);
    out.push({
      id,
      firstName,
      lastName,
      level,
      playerCurrentRank,
      rating: Number.isFinite(rating) ? rating : 3,
    });
  }
  return out;
}

export function livePlayerDisplayName(p: LiveBoxLeaguePlayer): string {
  return `${p.firstName.trim()} ${p.lastName.trim()}`.trim() || `Player ${p.id}`;
}

function buildUssquashMemberPayload(
  p: LiveBoxLeaguePlayer,
): CreateMatchReservationBody["players"][number] {
  const rating = Number.isFinite(p.rating) ? p.rating : null;
  const name = livePlayerDisplayName(p);
  return {
    type: "member",
    confirmed: false,
    id: p.id,
    text: name,
    rating,
    name: `${name} (CL id ${p.id})`,
    adultJunior: "Adult",
    location: "—",
    country: "—",
    mainAffiliation: "—",
    mainAffiliationId: 0,
  };
}

export type LiveManagedReservationItem = {
  boxNumber: number;
  playDate: string;
  courtId: number;
  slot: string;
  slotLabel: string;
  body: CreateMatchReservationBody;
  ussquashPlayerIds: [number, number];
  playerDisplayNames: [string, string];
};

export type LiveWeekPlanBuildIssue = {
  boxNumber: number;
  slotLabel: string;
  court: 1 | 2;
  reason: string;
};

export type BuildLiveWeekPlanResult = {
  payload: WeekPlanPayload;
  items: LiveManagedReservationItem[];
  issues: LiveWeekPlanBuildIssue[];
};

function auditPlayerRef(p: LiveBoxLeaguePlayer): string {
  return `ussquash:${p.id}`;
}

/**
 * Build match reservations from live US Squash roster + league schedule grid
 * (same geometry as the Booking calendar “Player names” checkbox).
 */
export function buildLiveWeekPlan(
  week: number,
  roster: readonly LiveBoxLeaguePlayer[],
  mondayDate: string,
  tuesdayDate: string,
  clubId: number,
  court1Id: number,
  court2Id: number,
  customMatchType: number,
  groundTruthRoster?: readonly LiveBoxLeaguePlayer[],
): BuildLiveWeekPlanResult {
  if (week < 1 || week > REGULAR_SEASON_GRID_WEEKS) {
    return {
      payload: { week, boxes: [] },
      items: [],
      issues: [
        {
          boxNumber: 0,
          slotLabel: "",
          court: 1,
          reason:
            week > REGULAR_SEASON_GRID_WEEKS
              ? "Semi-finals and playoff weeks are not supported for live roster conversion yet."
              : "week must be >= 1",
        },
      ],
    };
  }

  const mu = getWeekMatchups(week);
  const monSlots = bulkHoldSlotsForWeekday("mon");
  const tueSlots = bulkHoldSlotsForWeekday("tue");
  const items: LiveManagedReservationItem[] = [];
  const issues: LiveWeekPlanBuildIssue[] = [];
  const boxPayloads = new Map<number, WeekPlanBox>();

  const ensureBoxPayload = (boxNumber: number): WeekPlanBox => {
    let row = boxPayloads.get(boxNumber);
    if (!row) {
      const matchups: [string | undefined, string | undefined][] = mu.matches.map(
        ([a, b]) => {
          const pa = livePlayerAtScheduleSeat(
            boxNumber,
            a,
            roster,
            groundTruthRoster,
          );
          const pb = livePlayerAtScheduleSeat(
            boxNumber,
            b,
            roster,
            groundTruthRoster,
          );
          return [
            pa ? auditPlayerRef(pa) : undefined,
            pb ? auditPlayerRef(pb) : undefined,
          ];
        },
      );
      row = {
        boxId: `live-box-${boxNumber}`,
        boxNumber,
        managed: boxNumber <= MANAGED_BOX_NUMBER_MAX,
        matchups,
        bySeatNumbers: mu.byes,
        courtPreview: [],
      };
      boxPayloads.set(boxNumber, row);
    }
    return row;
  };

  for (const day of ["mon", "tue"] as const) {
    const slots = day === "mon" ? monSlots : tueSlots;
    const playDate = day === "mon" ? mondayDate : tuesdayDate;
    for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
      const slotRow = slots[slotIdx]!;
      const boxNumber = boxNumberForScheduleSlot(week, day, slotIdx);
      if (boxNumber == null || boxNumber > MANAGED_BOX_NUMBER_MAX) continue;

      const boxPayload = ensureBoxPayload(boxNumber);

      for (let matchIdx = 0; matchIdx < mu.matches.length; matchIdx++) {
        const court = (matchIdx === 0 ? 1 : 2) as 1 | 2;
        const courtId = court === 1 ? court1Id : court2Id;
        const seatPair = mu.matches[matchIdx]!;
        if (
          !scheduleMatchPairNeedsCourtBooking(
            boxNumber,
            seatPair,
            roster,
            groundTruthRoster,
          )
        ) {
          continue;
        }
        const p1 = livePlayerAtScheduleSeat(
          boxNumber,
          seatPair[0],
          roster,
          groundTruthRoster,
        );
        const p2 = livePlayerAtScheduleSeat(
          boxNumber,
          seatPair[1],
          roster,
          groundTruthRoster,
        );
        if (!p1 || !p2) {
          issues.push({
            boxNumber,
            slotLabel: slotRow.slotLabel,
            court,
            reason: `Box ${boxNumber}: missing player for seats ${seatPair[0]} v ${seatPair[1]}`,
          });
          continue;
        }

        boxPayload.courtPreview.push({
          match: seatPair,
          court,
          slotLabel: slotRow.slotLabel,
        });

        const slot = formatReservationSlot(slotRow.begin, slotRow.end);
        const body: CreateMatchReservationBody = {
          type: "match",
          applyUserRestrictionsForAdmin: false,
          clubId,
          courtId,
          date: playDate,
          slot,
          isPrivate: false,
          notes: [],
          players: [
            buildUssquashMemberPayload(p1),
            buildUssquashMemberPayload(p2),
          ],
          payingForAll: false,
          MatchProperties: {
            restrictJoinByRating: false,
            matchType: 1,
            customMatchType,
          },
        };

        items.push({
          boxNumber,
          playDate,
          courtId,
          slot,
          slotLabel: slotRow.slotLabel,
          body,
          ussquashPlayerIds: [p1.id, p2.id],
          playerDisplayNames: [livePlayerDisplayName(p1), livePlayerDisplayName(p2)],
        });
      }
    }
  }

  const payload: WeekPlanPayload = {
    week,
    boxes: [...boxPayloads.values()].sort((a, b) => a.boxNumber - b.boxNumber),
  };

  return { payload, items, issues };
}

/** True when roster is large enough to attempt managed booking for this week. */
export function liveWeekPlanResolvable(
  result: BuildLiveWeekPlanResult,
): boolean {
  return result.issues.length === 0 && result.items.length > 0;
}
