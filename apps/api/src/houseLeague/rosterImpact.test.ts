import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { LiveBoxLeaguePlayer } from "../booking/liveWeekPlan.js";
import { buildLiveWeekPlan } from "../booking/liveWeekPlan.js";
import { formatReservationSlot } from "../booking/slotMap.js";
import type { UssquashClient } from "../booking/clubLockerClient.js";
import { createDb } from "../db/client.js";
import {
  houseLeagueBookedOccurrences,
  players,
  seasonBookingHolds,
  seasons,
} from "../db/schema.js";
import { loadConfig } from "../config.js";
import { computeHouseLeagueRosterImpact } from "./rosterImpact.js";

function testDb() {
  const dbPath = path
    .join(os.tmpdir(), `roster-impact-${crypto.randomUUID()}.sqlite`)
    .replaceAll("\\", "/");
  const template = path.resolve(process.cwd(), "data", "squash.db");
  fs.copyFileSync(template, dbPath);
  return createDb(`file:${dbPath}`);
}

function rosterForManagedBoxes(): LiveBoxLeaguePlayer[] {
  const out: LiveBoxLeaguePlayer[] = [];
  for (let box = 1; box <= 16; box++) {
    const baseRank = (box - 1) * 6;
    for (let seat = 1; seat <= 6; seat++) {
      out.push({
        id: 100_000 + baseRank + seat,
        firstName: "Box",
        lastName: `${box}-S${seat}`,
        level: box,
        playerCurrentRank: baseRank + seat,
        rating: 4,
      });
    }
  }
  out.push({
    id: 200_001,
    firstName: "High",
    lastName: "Box",
    level: 17,
    playerCurrentRank: 1,
    rating: 4,
  });
  return out;
}

function mockClient(roster: LiveBoxLeaguePlayer[]): UssquashClient {
  return {
    listBoxLeaguePlayers: async () => ({ status: 200, data: roster }),
  } as unknown as UssquashClient;
}

describe("computeHouseLeagueRosterImpact", () => {
  it("detects player mismatch on a booked slot", async () => {
    const db = testDb();
    const config = loadConfig();
    const seasonId = crypto.randomUUID();
    db.insert(seasons)
      .values({
        id: seasonId,
        name: "Test",
        houseLeagueEventId: 99,
        startMondayDate: "2026-06-01",
      })
      .run();
    db.insert(seasonBookingHolds)
      .values({
        id: crypto.randomUUID(),
        seasonId,
        startMondayDate: "2026-06-01",
        seasonWeeks: 7,
        mondayReservationIdsJson: "[]",
        tuesdayReservationIdsJson: "[]",
        convertedWeeksJson: "[1]",
      })
      .run();

    const roster = rosterForManagedBoxes();
    const live = buildLiveWeekPlan(
      1,
      roster,
      "2026-06-01",
      "2026-06-02",
      config.US_SQUASH_CLUB_ID,
      config.US_SQUASH_COURT_1_ID,
      config.US_SQUASH_COURT_2_ID,
      config.US_SQUASH_CUSTOM_MATCH_TYPE,
    );
    const first = live.items[0]!;
    const wrongP1 = crypto.randomUUID();
    const wrongP2 = crypto.randomUUID();
    db.insert(players)
      .values([
        {
          id: wrongP1,
          externalId: "999001",
          displayName: "Wrong A",
          email: null,
          rating: "3",
        },
        {
          id: wrongP2,
          externalId: "999002",
          displayName: "Wrong B",
          email: null,
          rating: "3",
        },
      ])
      .run();
    db.insert(houseLeagueBookedOccurrences)
      .values({
        id: crypto.randomUUID(),
        seasonId,
        weekNumber: 1,
        playDate: first.playDate,
        slot: first.slot,
        courtId: first.courtId,
        boxNumber: first.boxNumber,
        player1Id: wrongP1,
        player2Id: wrongP2,
      })
      .run();

    const impact = await computeHouseLeagueRosterImpact(
      db,
      config,
      seasonId,
      { weekFilter: "all_converted", asOfDate: "2026-05-01" },
      mockClient(roster),
    );
    expect("error" in impact).toBe(false);
    if ("error" in impact) return;
    const mismatches = impact.courtRows.filter((r) => r.status === "mismatch");
    expect(mismatches.length).toBeGreaterThanOrEqual(1);
    expect(impact.summary.courtSlotsNeedingUpdate).toBeGreaterThan(0);
  });

  it("excludes past weeks when weekFilter is current_and_future", async () => {
    const db = testDb();
    const config = loadConfig();
    const seasonId = crypto.randomUUID();
    db.insert(seasons)
      .values({
        id: seasonId,
        name: "Test",
        houseLeagueEventId: 99,
        startMondayDate: "2026-06-01",
      })
      .run();
    db.insert(seasonBookingHolds)
      .values({
        id: crypto.randomUUID(),
        seasonId,
        startMondayDate: "2026-06-01",
        seasonWeeks: 7,
        mondayReservationIdsJson: "[]",
        tuesdayReservationIdsJson: "[]",
        convertedWeeksJson: "[1]",
      })
      .run();

    const roster = rosterForManagedBoxes();
    const impact = await computeHouseLeagueRosterImpact(
      db,
      config,
      seasonId,
      { weekFilter: "current_and_future", asOfDate: "2026-12-01" },
      mockClient(roster),
    );
    expect("error" in impact).toBe(false);
    if ("error" in impact) return;
    expect(impact.weeksScanned).toEqual([]);
  });

  it("flags stale bookings as extra when roster no longer fills a matchup", async () => {
    const db = testDb();
    const config = loadConfig();
    const seasonId = crypto.randomUUID();
    const roster = rosterForManagedBoxes();
    db.insert(seasons)
      .values({
        id: seasonId,
        name: "Test",
        houseLeagueEventId: 99,
        startMondayDate: "2026-06-01",
        seasonStartRosterJson: JSON.stringify(roster),
        seasonStartRosterSavedAt: new Date().toISOString(),
      })
      .run();
    db.insert(seasonBookingHolds)
      .values({
        id: crypto.randomUUID(),
        seasonId,
        startMondayDate: "2026-06-01",
        seasonWeeks: 7,
        mondayReservationIdsJson: "[]",
        tuesdayReservationIdsJson: "[]",
        convertedWeeksJson: "[2]",
      })
      .run();

    const live = buildLiveWeekPlan(
      2,
      roster,
      "2026-06-08",
      "2026-06-09",
      config.US_SQUASH_CLUB_ID,
      config.US_SQUASH_COURT_1_ID,
      config.US_SQUASH_COURT_2_ID,
      config.US_SQUASH_CUSTOM_MATCH_TYPE,
      roster,
    );
    const center2v5 = live.items.find(
      (it) =>
        it.boxNumber === 2 &&
        it.courtId === config.US_SQUASH_COURT_2_ID &&
        it.slot === formatReservationSlot("17:50", "18:30"),
    );
    expect(center2v5).toBeDefined();
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    db.insert(players)
      .values([
        {
          id: p1,
          externalId: String(center2v5!.ussquashPlayerIds[0]),
          displayName: "A",
          email: null,
          rating: "3",
        },
        {
          id: p2,
          externalId: String(center2v5!.ussquashPlayerIds[1]),
          displayName: "B",
          email: null,
          rating: "3",
        },
      ])
      .run();
    db.insert(houseLeagueBookedOccurrences)
      .values({
        id: crypto.randomUUID(),
        seasonId,
        weekNumber: 2,
        playDate: center2v5!.playDate,
        slot: center2v5!.slot,
        courtId: center2v5!.courtId,
        boxNumber: 2,
        player1Id: p1,
        player2Id: p2,
        reservationId: "res-stale-2v5",
      })
      .run();

    const holeInBox2 = roster.filter(
      (p) => !(p.level === 2 && p.playerCurrentRank === 8),
    );
    const impact = await computeHouseLeagueRosterImpact(
      db,
      config,
      seasonId,
      { weekFilter: "all_converted", asOfDate: "2026-06-01" },
      mockClient(holeInBox2),
    );
    expect("error" in impact).toBe(false);
    if ("error" in impact) return;
    const extras = impact.courtRows.filter(
      (r) =>
        r.weekNumber === 2 &&
        r.boxNumber === 2 &&
        r.status === "extra_booking" &&
        r.slot === center2v5!.slot,
    );
    expect(extras.length).toBeGreaterThanOrEqual(1);
    expect(extras[0]?.after).toBeNull();
  });

  it("does not flag 4v6 when only an unrelated seat is vacant in the box", async () => {
    const db = testDb();
    const config = loadConfig();
    const seasonId = crypto.randomUUID();
    const roster = rosterForManagedBoxes();
    db.insert(seasons)
      .values({
        id: seasonId,
        name: "Test",
        houseLeagueEventId: 99,
        startMondayDate: "2026-06-01",
        seasonStartRosterJson: JSON.stringify(roster),
        seasonStartRosterSavedAt: new Date().toISOString(),
      })
      .run();
    db.insert(seasonBookingHolds)
      .values({
        id: crypto.randomUUID(),
        seasonId,
        startMondayDate: "2026-06-01",
        seasonWeeks: 7,
        mondayReservationIdsJson: "[]",
        tuesdayReservationIdsJson: "[]",
        convertedWeeksJson: "[2]",
      })
      .run();

    const holeSeat3 = roster.filter(
      (p) => !(p.level === 9 && p.playerCurrentRank === 51),
    );
    const live = buildLiveWeekPlan(
      2,
      holeSeat3,
      "2026-06-08",
      "2026-06-09",
      config.US_SQUASH_CLUB_ID,
      config.US_SQUASH_COURT_1_ID,
      config.US_SQUASH_COURT_2_ID,
      config.US_SQUASH_CUSTOM_MATCH_TYPE,
      roster,
    );
    const stadium4v6 = live.items.find(
      (it) =>
        it.boxNumber === 9 &&
        it.playDate === "2026-06-09" &&
        it.courtId === config.US_SQUASH_COURT_1_ID &&
        it.slot === "12:30-13:10",
    );
    expect(stadium4v6).toBeDefined();
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    db.insert(players)
      .values([
        {
          id: p1,
          externalId: String(stadium4v6!.ussquashPlayerIds[0]),
          displayName: "A",
          email: null,
          rating: "3",
        },
        {
          id: p2,
          externalId: String(stadium4v6!.ussquashPlayerIds[1]),
          displayName: "B",
          email: null,
          rating: "3",
        },
      ])
      .run();
    db.insert(houseLeagueBookedOccurrences)
      .values({
        id: crypto.randomUUID(),
        seasonId,
        weekNumber: 2,
        playDate: stadium4v6!.playDate,
        slot: stadium4v6!.slot,
        courtId: stadium4v6!.courtId,
        boxNumber: 9,
        player1Id: p1,
        player2Id: p2,
        reservationId: "res-box9-4v6",
      })
      .run();

    const impact = await computeHouseLeagueRosterImpact(
      db,
      config,
      seasonId,
      { weekFilter: "all_converted", asOfDate: "2026-06-01" },
      mockClient(holeSeat3),
    );
    expect("error" in impact).toBe(false);
    if ("error" in impact) return;
    const stadiumExtras = impact.courtRows.filter(
      (r) =>
        r.weekNumber === 2 &&
        r.boxNumber === 9 &&
        r.slot === "12:30-13:10" &&
        r.courtId === config.US_SQUASH_COURT_1_ID &&
        r.status !== "ok",
    );
    expect(stadiumExtras).toHaveLength(0);
  });

  it("reports blockers when roster cannot fill managed week", async () => {
    const db = testDb();
    const config = loadConfig();
    const seasonId = crypto.randomUUID();
    db.insert(seasons)
      .values({
        id: seasonId,
        name: "Test",
        houseLeagueEventId: 99,
        startMondayDate: "2026-06-01",
      })
      .run();
    db.insert(seasonBookingHolds)
      .values({
        id: crypto.randomUUID(),
        seasonId,
        startMondayDate: "2026-06-01",
        seasonWeeks: 7,
        mondayReservationIdsJson: "[]",
        tuesdayReservationIdsJson: "[]",
        convertedWeeksJson: "[1]",
      })
      .run();

    const sparse: LiveBoxLeaguePlayer[] = [
      {
        id: 1,
        firstName: "Only",
        lastName: "One",
        level: 1,
        playerCurrentRank: 1,
        rating: 4,
      },
    ];
    const impact = await computeHouseLeagueRosterImpact(
      db,
      config,
      seasonId,
      { weekFilter: "all_converted", asOfDate: "2026-05-01" },
      mockClient(sparse),
    );
    expect("error" in impact).toBe(false);
    if ("error" in impact) return;
    expect(impact.summary.courtSlotsNeedingUpdate).toBe(0);
    expect(impact.courtRows.filter((r) => r.status !== "ok")).toHaveLength(0);
  });

  it("does not emit managed court rows for box 17", async () => {
    const db = testDb();
    const config = loadConfig();
    const seasonId = crypto.randomUUID();
    db.insert(seasons)
      .values({
        id: seasonId,
        name: "Test",
        houseLeagueEventId: 99,
        startMondayDate: "2026-06-01",
      })
      .run();
    db.insert(seasonBookingHolds)
      .values({
        id: crypto.randomUUID(),
        seasonId,
        startMondayDate: "2026-06-01",
        seasonWeeks: 7,
        mondayReservationIdsJson: "[]",
        tuesdayReservationIdsJson: "[]",
        convertedWeeksJson: "[1]",
      })
      .run();

    const roster = rosterForManagedBoxes();
    const impact = await computeHouseLeagueRosterImpact(
      db,
      config,
      seasonId,
      { weekFilter: "all_converted", asOfDate: "2026-05-01" },
      mockClient(roster),
    );
    expect("error" in impact).toBe(false);
    if ("error" in impact) return;
    expect(impact.courtRows.every((r) => r.boxNumber <= 16)).toBe(true);
  });
});
