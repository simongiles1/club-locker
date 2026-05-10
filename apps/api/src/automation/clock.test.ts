import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { advanceClockMs, nowForAutomation, setClockIso } from "./clock.js";
import { seedAutomationSettings, setSetting } from "./settings.js";

function testDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `automation-clock-${crypto.randomUUID()}.sqlite`,
  ).replaceAll("\\", "/");
  const template = path.resolve(process.cwd(), "data", "squash.db");
  fs.copyFileSync(template, dbPath);
  return createDb(`file:${dbPath}`);
}

describe("automation clock", () => {
  it("uses virtual clock when test mode is enabled", () => {
    const db = testDb();
    seedAutomationSettings(db);
    setSetting(db, "automation.test_mode", "on");
    setClockIso(db, "2026-01-01T12:00:00.000Z");
    expect(nowForAutomation(db).toISOString()).toBe("2026-01-01T12:00:00.000Z");
    advanceClockMs(db, 60_000);
    expect(nowForAutomation(db).toISOString()).toBe("2026-01-01T12:01:00.000Z");
  });
});
