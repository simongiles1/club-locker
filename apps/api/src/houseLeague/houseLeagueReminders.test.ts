import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import {
  emailOutbox,
  emailTemplates,
  houseLeagueBookedOccurrences,
  houseLeagueMatchReminderSends,
  players,
  seasons,
} from "../db/schema.js";
import { seedAutomationSettings, setSetting } from "../automation/settings.js";
import {
  patchHouseLeagueEmailReminderSettings,
  seedHouseLeagueEmailReminderSettings,
} from "../houseLeague/emailReminderSettings.js";
import { playDateAlignedWithReminderDay } from "../houseLeague/reminderDates.js";
import { processHouseLeagueMatchReminders } from "../houseLeague/matchReminderScheduler.js";
import { processScheduledOutbox } from "../houseLeague/scheduledOutbox.js";

function testDb() {
  const dbPath = path
    .join(os.tmpdir(), `hl-reminder-${crypto.randomUUID()}.sqlite`)
    .replaceAll("\\", "/");
  const template = path.resolve(process.cwd(), "data", "squash.db");
  fs.copyFileSync(template, dbPath);
  return createDb(`file:${dbPath}`);
}

describe("house league reminder cron", () => {
  it("processScheduledOutbox sends due scheduled rows once", async () => {
    const db = testDb();
    seedAutomationSettings(db);
    seedHouseLeagueEmailReminderSettings(db);
    const now = new Date("2099-01-15T12:00:00.000Z");
    const sends: { subject: string }[] = [];
    const emailAdapter = {
      send: async (x: { subject: string }) => {
        sends.push({ subject: x.subject });
        return { ok: true as const };
      },
    };
    db.insert(emailOutbox)
      .values({
        id: "scheduled-test-1",
        kind: "house_league_reminder_test",
        seasonId: null,
        status: "scheduled",
        scheduledSendAt: "2099-01-01T00:00:00.000Z",
        toAddress: "director@example.test",
        subject: "Hi",
        body: "Body",
        metaJson: JSON.stringify({ purpose: "test_scheduled_reminder" }),
      })
      .run();

    await processScheduledOutbox(db, emailAdapter, now);
    expect(sends).toHaveLength(1);

    const row = db.select().from(emailOutbox).where(eq(emailOutbox.id, "scheduled-test-1")).get();
    expect(row?.status).toBe("sent");

    await processScheduledOutbox(db, emailAdapter, now);
    expect(sends).toHaveLength(1);
  });

  it("stages HL match reminders for occurrences on reminder day", async () => {
    const db = testDb();
    seedAutomationSettings(db);
    seedHouseLeagueEmailReminderSettings(db);
    setSetting(db, "automation.test_mode", "on");

    const seasonId = crypto.randomUUID();
    const pA = crypto.randomUUID();
    const pB = crypto.randomUUID();
    const tm = crypto.randomUUID();
    db.insert(seasons)
      .values({
        id: seasonId,
        name: "Test season",
      })
      .run();
    db.insert(players)
      .values([
        { id: pA, displayName: "Ada", email: "ada@example.test", rating: "3.0" },
        { id: pB, displayName: "Bob", email: "bob@example.test", rating: "3.0" },
      ])
      .run();
    const now = new Date("2026-07-09T13:20:00.000Z");
    const matchPlayDay = playDateAlignedWithReminderDay(3, now);
    db.insert(emailTemplates)
      .values({
        id: tm,
        name: "HL remind",
        scope: "house_league",
        subjectTemplate: "{{playerName}} / {{matchDate}}",
        bodyTemplate: "vs {{opponentName}} {{matchSlot}}",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    patchHouseLeagueEmailReminderSettings(db, {
      enabled: true,
      daysBefore: 3,
      templateId: tm,
    });

    const occId = crypto.randomUUID();
    db.insert(houseLeagueBookedOccurrences)
      .values({
        id: occId,
        seasonId,
        weekNumber: 4,
        playDate: matchPlayDay,
        slot: "19:30-20:15",
        courtId: 1,
        boxNumber: 2,
        player1Id: pA,
        player2Id: pB,
        bookingRunId: null,
        reservationId: "r42",
      })
      .run();

    const config = loadConfig();
    const sentLog: Array<{ subject: string; to: string }> = [];
    const emailAdapter = {
      send: async (x: { to: string; subject: string }) => {
        sentLog.push({ to: x.to, subject: x.subject });
        return { ok: true as const };
      },
    };

    const out = await processHouseLeagueMatchReminders(
      db,
      config,
      emailAdapter,
      now,
      true,
      "normal",
    );

    expect(out.staged).toBe(2);
    expect(sentLog).toHaveLength(2);

    const follow = db.select().from(houseLeagueMatchReminderSends).all();
    expect(follow).toHaveLength(2);

    const out2 = await processHouseLeagueMatchReminders(
      db,
      config,
      emailAdapter,
      now,
      true,
      "normal",
    );
    expect(out2.staged).toBe(0);
  });
});
