import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { championshipDraws, championshipMatchFollowups, championshipMatches, championshipEntries, championships, emailOutbox, players } from "../db/schema.js";
import { runSchedulerTick } from "./scheduler.js";
import { seedAutomationSettings, setSetting } from "./settings.js";

function testDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `automation-scheduler-${crypto.randomUUID()}.sqlite`,
  ).replaceAll("\\", "/");
  const template = path.resolve(process.cwd(), "data", "squash.db");
  fs.copyFileSync(template, dbPath);
  return createDb(`file:${dbPath}`);
}

describe("runSchedulerTick", () => {
  it("stages round announcement and deadline reminders", async () => {
    const db = testDb();
    seedAutomationSettings(db);
    setSetting(db, "automation.test_mode", "on");
    setSetting(db, "clock.virtual_now_iso", "2026-05-01T12:00:00.000Z");

    const championshipId = crypto.randomUUID();
    const drawId = crypto.randomUUID();
    const matchId = crypto.randomUUID();
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    const e1 = crypto.randomUUID();
    const e2 = crypto.randomUUID();
    db.insert(players)
      .values([
        { id: p1, displayName: "Player A", email: "pgartenburg+a@gmail.com", rating: "4.2" },
        { id: p2, displayName: "Player B", email: "pgartenburg+b@gmail.com", rating: "4.1" },
      ])
      .run();
    db.insert(championships)
      .values({
        id: championshipId,
        seasonId: null,
        format: "singles",
        divisionKind: "skill",
        divisionLabel: "A",
        name: "Club Champs A",
        status: "published",
        roundOneDueDate: "2026-05-03T12:00:00.000Z",
      })
      .run();
    db.insert(championshipEntries)
      .values([
        { id: e1, championshipId, playerId: p1, partnerPlayerId: null, seed: 1 },
        { id: e2, championshipId, playerId: p2, partnerPlayerId: null, seed: 2 },
      ])
      .run();
    db.insert(championshipDraws)
      .values({
        id: drawId,
        championshipId,
        status: "published",
        size: 2,
        snapshotJson: "{}",
      })
      .run();
    db.insert(championshipMatches)
      .values({
        id: matchId,
        championshipId,
        drawId,
        round: 1,
        matchIndex: 0,
        topEntryId: e1,
        topIsBye: 0,
        bottomEntryId: e2,
        bottomIsBye: 0,
        winnerEntryId: null,
        dueDate: null,
        scheduledAt: null,
        completedAt: null,
      })
      .run();

    const config = loadConfig();
    const emailAdapter = { send: async () => ({ ok: true as const }) };
    const outcome = await runSchedulerTick(db, config, emailAdapter, {
      kind: "manual",
    });
    expect(outcome.staged).toBeGreaterThanOrEqual(1);

    const outboxRows = db.select().from(emailOutbox).all();
    expect(outboxRows.length).toBeGreaterThanOrEqual(1);
    const followups = db
      .select()
      .from(championshipMatchFollowups)
      .where(eq(championshipMatchFollowups.matchId, matchId))
      .all();
    expect(followups.length).toBeGreaterThanOrEqual(1);
  });
});
