import { randomUUID } from "node:crypto";
import { statutoryHolidaysForYear } from "@squash/shared";
import { count } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema.js";
import { statutoryHolidays } from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

/** When the table is empty, insert the shared-package Canada statutory template for nearby club years. */
export function ensureStatutoryHolidaysSeeded(db: Db): void {
  const row = db.select({ c: count() }).from(statutoryHolidays).get();
  if (row && row.c > 0) return;

  const cy = new Date().getFullYear();
  const years = [cy - 1, cy, cy + 1, cy + 2];
  for (const y of years) {
    for (const h of statutoryHolidaysForYear(y)) {
      db.insert(statutoryHolidays)
        .values({
          id: randomUUID(),
          name: h.name,
          date: h.date,
          openTime: h.hours.open,
          closeTime: h.hours.close,
          closed: h.hours.closed ? 1 : 0,
        })
        .run();
    }
  }
}
