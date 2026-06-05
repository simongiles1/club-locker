import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  playMondayForWednesdayAnnouncement,
  resolveTargetWeekForWednesday,
} from "@squash/shared";
import { createDb } from "../db/client.js";
import {
  houseLeagueBookedOccurrences,
  houseLeagueWeeklyBoxSends,
  players,
  seasonBookingHolds,
  seasons,
} from "../db/schema.js";
import { loadConfig } from "../config.js";
import {
  managedWeekReadyForWeeklyEmail,
  stageWeeklyBoxEmails,
} from "./weeklyBoxEmail.js";
import { seedHouseLeagueWeeklyBoxEmailSettings } from "./weeklyBoxEmailTemplateSettings.js";

function testDb() {
  const dbPath = path
    .join(os.tmpdir(), `weekly-box-${crypto.randomUUID()}.sqlite`)
    .replaceAll("\\", "/");
  const template = path.resolve(process.cwd(), "data", "squash.db");
  fs.copyFileSync(template, dbPath);
  return createDb(`file:${dbPath}`);
}

describe("weekly box email", () => {
  it("playMondayForWednesdayAnnouncement matches resolveTargetWeek", () => {
    const wed = new Date(2026, 5, 10, 12, 0, 0);
    expect(playMondayForWednesdayAnnouncement(wed)).toBe("2026-06-15");
    const target = resolveTargetWeekForWednesday(wed, "2026-06-01");
    expect(target?.weekNumber).toBe(3);
    expect(target?.playMonday).toBe("2026-06-15");
  });

  it("managedWeekReady requires convert and occurrences", () => {
    const db = testDb();
    seedHouseLeagueWeeklyBoxEmailSettings(db);
    const seasonId = crypto.randomUUID();
    db.insert(seasons).values({ id: seasonId, name: "T" }).run();
    db.insert(seasonBookingHolds)
      .values({
        id: crypto.randomUUID(),
        seasonId,
        startMondayDate: "2026-06-01",
        seasonWeeks: 8,
        mondayReservationIdsJson: "[]",
        tuesdayReservationIdsJson: "[]",
        convertedWeeksJson: "[2]",
      })
      .run();
    expect(managedWeekReadyForWeeklyEmail(db, seasonId, 2)).toBe(false);

    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    db.insert(players)
      .values([
        { id: p1, displayName: "A", email: "a@test", rating: "3" },
        { id: p2, displayName: "B", email: "b@test", rating: "3" },
      ])
      .run();
    db.insert(houseLeagueBookedOccurrences)
      .values({
        id: crypto.randomUUID(),
        seasonId,
        weekNumber: 2,
        playDate: "2026-06-08",
        slot: "19:30-20:15",
        courtId: 1,
        boxNumber: 1,
        player1Id: p1,
        player2Id: p2,
      })
      .run();
    expect(managedWeekReadyForWeeklyEmail(db, seasonId, 2)).toBe(true);
  });

  it("dedupes weekly box sends per season week box", async () => {
    const db = testDb();
    seedHouseLeagueWeeklyBoxEmailSettings(db);
    const seasonId = crypto.randomUUID();
    db.insert(seasons).values({ id: seasonId, name: "T" }).run();
    const sends: string[] = [];
    const emailAdapter = {
      send: async (x: { subject: string }) => {
        sends.push(x.subject);
        return { ok: true as const };
      },
    };
    const config = loadConfig();

    const out1 = await stageWeeklyBoxEmails(db, config, emailAdapter, {
      seasonId,
      weekNumber: 1,
      autoSend: false,
      mode: "normal",
      dryRun: true,
    });
    expect(out1.staged).toBeGreaterThanOrEqual(0);

    db.insert(houseLeagueWeeklyBoxSends)
      .values({
        id: crypto.randomUUID(),
        seasonId,
        weekNumber: 1,
        boxNumber: 99,
        matchIndex: 0,
        sentAt: new Date().toISOString(),
      })
      .run();

    const rows = db
      .select()
      .from(houseLeagueWeeklyBoxSends)
      .where(eq(houseLeagueWeeklyBoxSends.seasonId, seasonId))
      .all();
    expect(rows).toHaveLength(1);
  });
});
