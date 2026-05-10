import type { Db } from "../db/client.js";
import { getSetting, isTestMode, setSetting } from "./settings.js";

export function nowForAutomation(db: Db): Date {
  if (!isTestMode(db)) return new Date();
  const raw = getSetting(db, "clock.virtual_now_iso", new Date().toISOString());
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

export function readClockState(db: Db): {
  mode: "real" | "virtual";
  nowIso: string;
} {
  const mode = isTestMode(db) ? "virtual" : "real";
  return { mode, nowIso: nowForAutomation(db).toISOString() };
}

export function setClockIso(db: Db, iso: string): { nowIso: string } {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("invalid_iso_datetime");
  }
  const normalized = parsed.toISOString();
  setSetting(db, "clock.virtual_now_iso", normalized);
  return { nowIso: normalized };
}

export function advanceClockMs(db: Db, deltaMs: number): { nowIso: string } {
  const next = new Date(nowForAutomation(db).getTime() + deltaMs).toISOString();
  setSetting(db, "clock.virtual_now_iso", next);
  return { nowIso: next };
}
