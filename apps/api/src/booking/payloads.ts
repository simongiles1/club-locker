import {
  formatReservationSlot,
  slotLabelToWindow,
} from "./slotMap.js";
import {
  buildUssquashPlayerFromRow,
  getClubLockerIdForPlayer,
  type PlayerRow,
} from "./playerResolver.js";
import type { CreateMatchReservationBody } from "./clubLockerClient.js";

export type WeekPlanBox = {
  boxId: string;
  boxNumber: number;
  managed: boolean;
  matchups: [string | undefined, string | undefined][];
  bySeatNumbers: [number, number];
  courtPreview: {
    match: [number, number];
    court: 1 | 2;
    slotLabel: string;
  }[];
};

export type WeekPlanPayload = { week: number; boxes: WeekPlanBox[] };

/**
 * The i-th court preview row corresponds to the i-th rotation match (not seat indices).
 * Matchup player ids for that same index give the two players to book.
 */
export function playDateForSlotDay(
  day: "mon" | "tue",
  mondayDate: string,
  tuesdayDate: string,
): string {
  return day === "mon" ? mondayDate : tuesdayDate;
}

export function courtIndexToId(
  court: 1 | 2,
  court1: number,
  court2: number,
): number {
  return court === 1 ? court1 : court2;
}

export type ManagedReservationItem = {
  boxNumber: number;
  playDate: string;
  courtId: number;
  slot: string;
  body: CreateMatchReservationBody;
  internalPlayerIds: [string, string];
};

export function buildManagedMatchReservations(
  plan: WeekPlanPayload,
  playersById: Map<string, PlayerRow>,
  seasonId: string,
  mondayDate: string,
  tuesdayDate: string,
  clubId: number,
  court1Id: number,
  court2Id: number,
  customMatchType: number,
): {
  items: ManagedReservationItem[];
  missingExternal: { playerId: string; displayName: string; box: number }[];
} {
  const items: ManagedReservationItem[] = [];
  const missingExternal: { playerId: string; displayName: string; box: number }[] = [];

  for (const b of plan.boxes) {
    if (!b.managed) continue;
    b.courtPreview.forEach((c, i) => {
      const pair = b.matchups[i];
      if (!pair || !pair[0] || !pair[1]) return;
      const p1 = playersById.get(pair[0]);
      const p2 = playersById.get(pair[1]);
      if (!p1 || !p2) {
        missingExternal.push({
          playerId: pair[0]!,
          displayName: "unknown",
          box: b.boxNumber,
        });
        return;
      }
      const e1 = getClubLockerIdForPlayer(p1, { seasonId, week: plan.week });
      const e2 = getClubLockerIdForPlayer(p2, { seasonId, week: plan.week });
      if ("error" in e1) {
        missingExternal.push({ playerId: p1.id, displayName: p1.displayName, box: b.boxNumber });
        return;
      }
      if ("error" in e2) {
        missingExternal.push({ playerId: p2.id, displayName: p2.displayName, box: b.boxNumber });
        return;
      }
      const win = slotLabelToWindow(c.slotLabel);
      const playDate = playDateForSlotDay(
        win.day,
        mondayDate,
        tuesdayDate,
      );
      const courtId = courtIndexToId(c.court, court1Id, court2Id);
      const slot = formatReservationSlot(win.begin, win.end);
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
          buildUssquashPlayerFromRow(p1, e1.externalId),
          buildUssquashPlayerFromRow(p2, e2.externalId),
        ],
        payingForAll: false,
        MatchProperties: {
          restrictJoinByRating: false,
          matchType: 1,
          customMatchType,
        },
      };
      items.push({
        boxNumber: b.boxNumber,
        playDate,
        courtId,
        slot,
        body,
        internalPlayerIds: [p1.id, p2.id],
      });
    });
  }

  return { items, missingExternal };
}
