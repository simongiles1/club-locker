import { DEFAULT_MONDAY_SLOTS, DEFAULT_TUESDAY_SLOTS } from "./rotation.js";

/**
 * 40-minute windows aligned with rotation slot labels (HH:mm 24h, club local time).
 * Keep in sync with US Squash reservation payloads.
 *
 * Note: Facilities often *open booking* at **6:30 AM** club local — that opening time is
 * separate from the league reservation *slot* windows declared here.
 */

/** Mondays — 40-minute blocks **4:30 PM–9:50 PM** (last window ends **21:50**). */
export const BULK_MONDAY_TIME_WINDOWS: readonly { begin: string; end: string }[] = [
  { begin: "16:30", end: "17:10" },
  { begin: "17:10", end: "17:50" },
  { begin: "17:50", end: "18:30" },
  { begin: "18:30", end: "19:10" },
  { begin: "19:10", end: "19:50" },
  { begin: "19:50", end: "20:30" },
  { begin: "20:30", end: "21:10" },
  { begin: "21:10", end: "21:50" },
];

/**
 * Tuesdays — **11:50 AM–1:50 PM** lunch block, then **4:30–7:50 PM**
 * (last window ends **19:50**). Labels follow the legacy Mon/Tue slot naming in `rotation.ts`.
 */
export const BULK_TUESDAY_TIME_WINDOWS: readonly { begin: string; end: string }[] = [
  { begin: "11:50", end: "12:30" },
  { begin: "12:30", end: "13:10" },
  { begin: "13:10", end: "13:50" },
  { begin: "16:30", end: "17:10" },
  { begin: "17:10", end: "17:50" },
  { begin: "17:50", end: "18:30" },
  { begin: "18:30", end: "19:10" },
  { begin: "19:10", end: "19:50" },
];

export type BulkSlotRow = {
  slotLabel: string;
  begin: string;
  end: string;
};

/** Slot labels + time windows for one league weekday (bulk hold template). */
export function bulkHoldSlotsForWeekday(day: "mon" | "tue"): BulkSlotRow[] {
  const labels = day === "mon" ? DEFAULT_MONDAY_SLOTS : DEFAULT_TUESDAY_SLOTS;
  const wins = day === "mon" ? BULK_MONDAY_TIME_WINDOWS : BULK_TUESDAY_TIME_WINDOWS;
  return labels.map((slotLabel, i) => {
    const w = wins[i];
    if (!w) {
      throw new Error(`bulk hold window missing for ${day} index ${i}`);
    }
    return { slotLabel, begin: w.begin, end: w.end };
  });
}
