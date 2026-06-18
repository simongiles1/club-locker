import {
  bulkHoldSlotsForWeekday,
  formatCompactMatchPair,
  getWeekMatchups,
  parseReservationSlotWindow,
  livePlayerAtScheduleSeat,
  OPEN_BOX_SEAT_LABEL,
  rosterImpactCalendarChipKey,
  scheduleMatchPairNeedsCourtBooking,
  seasonWeekPlayDatesWithRegistry,
  statHolidayForDateInRegistry,
  statutoryHolidaysForYear,
  type StatHoliday,
} from "@squash/shared";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { api } from "./api.js";
import { leagueSchedule } from "./Schedule.js";
import type { ClubMember } from "./MembersPage.js";
import { MemberSearchSelect } from "./MemberSearchSelect.js";
import type {
  CourtImpactRow,
  RosterImpactPayload,
} from "./RosterImpactReview.js";

function humanBookingPaceDelayMs(): number {
  return 5000 + Math.random() * 2000;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RosterImpactCalendarHighlight = {
  chipKeys: Set<string>;
  stadiumChipKeys: Set<string>;
  centerChipKeys: Set<string>;
  afterLabelByChipCourt: Map<string, string>;
};

type BulkSlotBookingRef = {
  date: string;
  begin: string;
  end: string;
};

type SeasonBulkPreviewResponse = {
  seasonId: string;
  startMondayDate: string;
  week1Tuesday: string;
  seasonWeeks: number;
  /** Four items: Mon Stadium, Mon Center, Tue Stadium, Tue Center (one POST /clinics each). */
  usSquashClinicCalls: {
    label: string;
    firstDate: string;
    slotCount: number;
    weeklyOccurrences: number;
    includesCourts: [number, number];
  }[];
  bff: {
    method: string;
    path: string;
    body: Record<string, unknown>;
  };
};

type PreviewResult =
  | {
      weekPlanId: string;
      bulkSlotCount: number;
      managedMatchCount: number;
      items: {
        box: number;
        date: string;
        courtId: string;
        slot: string;
        players: string[];
      }[];
      missingExternal: { playerId: string; displayName: string; box: number }[];
    }
  | { error: string };

type SeasonBulkResult = {
  runId: string;
  seasonHoldId: string;
  status: string;
  message: string;
  idempotent?: boolean;
  /** Club Locker reported existing reservations in those slots. */
  conflict?: boolean;
  mondayStatus?: number;
  tuesdayStatus?: number;
  mondayReservationIdCount: number;
  tuesdayReservationIdCount: number;
  rawResponse?: unknown;
};

type SeasonHoldListRow = {
  id: string;
  startMondayDate: string;
  seasonWeeks: number;
  status: string;
  convertedWeeksJson: string;
  locallyConvertedSlotsJson?: string;
};

function localBookingSlotKey(
  week: number,
  date: string,
  begin: string,
  end: string,
): string {
  return `${week}|${date}|${begin}-${end}`;
}

type CancellableCalendarRow = {
  rowId: string;
  kind: "bulk" | "match";
  week: number;
  date: string;
  begin: string;
  end: string;
  label: string;
  reservationIds: string[];
  complete: boolean;
};

type SlotContextMenuState =
  | {
      x: number;
      y: number;
      date: string;
      begin: string;
      end: string;
      mode: "book";
    }
  | {
      x: number;
      y: number;
      date: string;
      begin: string;
      end: string;
      mode: "bulk" | "match";
    };

type ConvertResult = {
  runId: string;
  status: string;
  message: string;
  summary: {
    holdKind: string;
    deleted: { id: string; status: number; ok: boolean }[];
    created: { key: string; status: number; ok: boolean }[];
    holdId: string;
  };
};

type RebookPlayDayResult = {
  runId: string;
  status: string;
  message: string;
  summary: {
    playDay: "mon" | "tue";
    playDate: string;
    created: { key: string; status: number; ok: boolean }[];
  };
};

/** "Wed 2026-10-14" → "Wed, Oct 14, 2026" (matches weekday + ISO date segments). */
const WEEKDAY_PREFIX_ISO_RE =
  /(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d{4}-\d{2}-\d{2})/g;

function formatISODateLongEn(iso: string): string {
  const [y, mo, day] = iso.split("-").map(Number);
  if (!y || !mo || !day) return iso;
  const d = new Date(y, mo - 1, day);
  const weekdayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const monthShort = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][d.getMonth()];
  return `${weekdayShort}, ${monthShort} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatConflictDatesInLine(line: string): string {
  return line.replace(WEEKDAY_PREFIX_ISO_RE, (_, iso: string) => formatISODateLongEn(iso));
}

function extractSeasonBulkIssueLines(
  payload: SeasonBulkResult | { error: string },
): string[] {
  const simplifyConflictMessage = (raw: string): string => {
    const text = raw.replace(/\s+/g, " ").trim();
    const overlapMatch = text.match(
      /(there\s+is\s+an\s+)?overlapping\s+(\w+)\s+at\s+times?\s*([0-9:]+\s*-\s*[0-9:]+)/i,
    );
    if (overlapMatch) {
      const prefix = overlapMatch[1] ?? "";
      const kind = overlapMatch[2];
      const rangeStr = overlapMatch[3];
      const [start, end] = rangeStr.split("-").map((v) => v.trim());
      const hasValidWindow = /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end);
      if (hasValidWindow) {
        const times = `${formatHHMMAs12Hour(start)} - ${formatHHMMAs12Hour(end)}`;
        return `${prefix}overlapping ${kind} at times ${times}.`;
      }
      return `${prefix}overlapping ${kind} at times ${rangeStr.replace(/\s+/g, "")}.`;
    }
    if (/slot cannot be booked/i.test(text)) {
      return text
        .replace(/^slot cannot be booked because\s*/i, "")
        .replace(/[.;]\s*$/g, "")
        .trim()
        .replace(/^./, (c) => c.toUpperCase())
        .concat(".");
    }
    return text;
  };

  const formatConflictLine = (step: string, msg: string, week?: number): string => {
    const prefix = [
      typeof week === "number" ? `Week ${week}` : "",
      step.replace(/\s*·\s*/g, " - ").trim(),
    ]
      .filter(Boolean)
      .join(", ");
    const clean = msg.replace(/[.;]\s*$/g, "");
    return prefix ? `${prefix}: ${clean}.` : `${clean}.`;
  };

  if ("error" in payload) {
    return [formatConflictDatesInLine(simplifyConflictMessage(payload.error))];
  }
  const lines: string[] = [];
  const raw = payload.rawResponse as
    | {
        failed?: {
          week?: unknown;
          step?: unknown;
          plannedDates?: {
            firstPlayDate?: unknown;
            secondPlayDate?: unknown;
            shiftedByHoliday?: unknown;
            holidayName?: unknown;
          };
          response?: {
            status?: unknown;
            data?: { error?: { message?: unknown; text?: unknown; name?: unknown } };
          };
        };
      }
    | undefined;
  const failed = raw?.failed;
  if (failed) {
    const step = typeof failed.step === "string" ? failed.step : "";
    const week = typeof failed.week === "number" ? failed.week : undefined;
    const errObj = failed.response?.data?.error;
    const errMsg =
      typeof errObj?.message === "string"
        ? errObj.message
        : typeof errObj?.text === "string"
          ? errObj.text
          : "Unknown API error";
    const simpleErr = simplifyConflictMessage(errMsg);
    lines.push(formatConflictLine(step, simpleErr, week));
  } else if (payload.status === "error" || payload.status === "partial") {
    lines.push(simplifyConflictMessage(payload.message));
  }
  return [...new Set(lines.filter(Boolean).map(formatConflictDatesInLine))];
}

function formatSeasonConflictForCard(line: string): { context: string; detail: string } {
  const text = line.replace(/\s+/g, " ").trim();
  const colonIndex = text.indexOf(":");
  if (colonIndex <= 0) {
    return { context: "Scheduling conflict", detail: text };
  }
  const context = text.slice(0, colonIndex).trim();
  const detail = text.slice(colonIndex + 1).trim();
  return {
    context: context || "Scheduling conflict",
    detail: detail || text,
  };
}

/** Trailing ` - Center` / ` - Stadium` from conflict context → badge + leading text. */
function parseCourtFromConflictContext(context: string): {
  beforeCourt: string;
  courtName: "Center" | "Stadium" | null;
} {
  const m = context.match(/^(.*?)\s+-\s+(Center|Stadium)$/);
  if (m) {
    return {
      beforeCourt: m[1].trim(),
      courtName: m[2] as "Center" | "Stadium",
    };
  }
  return { beforeCourt: context, courtName: null };
}

/** Calendar week columns: Sunday first (Google Calendar style). */
const WEEK_SUN_FIRST = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

const SEASON_BULK_PX_PER_MINUTE = 1.35;

/**
 * Season bulk calendar: seven regular panes (weeks 1–7) plus an eighth pane for semi-finals.
 * Bulk-hold (green) styling applies only to the first seven; semis stays preview (blue) unless converted.
 */
const SEASON_BLOCK_CALENDAR_STEPS = 8;
const REGULAR_SEASON_WEEKS_IN_CALENDAR = 7;

/** League blocks are always 40 minutes; gap/padding splits use the same thickness. */
const SLOT_BOOK_STEP_MIN = 40;

/** Dedupe Mon/Tue template windows for “quiet” day columns (same calendar geometry). */
function mergeCanonicalBookingWindows(
  mon: { begin: string; end: string }[],
  tue: { begin: string; end: string }[],
): { begin: string; end: string }[] {
  const m = new Map<string, { begin: string; end: string }>();
  for (const row of [...mon, ...tue]) {
    m.set(`${row.begin}|${row.end}`, { begin: row.begin, end: row.end });
  }
  return [...m.values()].sort(
    (a, b) => parseHHMMToMinutes(a.begin) - parseHHMMToMinutes(b.begin),
  );
}

type SlotHoverBand = {
  reactKey: string;
  top: number;
  height: number;
  /** Clock range this band covers on the grid (must match layout / tick marks). */
  sliceBegin: string;
  sliceEnd: string;
  /** League window submitted on right-click (nearest real slot in padding/gaps). */
  bookBegin: string;
  bookEnd: string;
};

const HOVER_BAND_Y_EPS_PX = 2;

function findSlotHoverBandAtRelativeY(
  bands: readonly SlotHoverBand[],
  y: number,
): SlotHoverBand | null {
  for (const b of bands) {
    if (
      y >= b.top - HOVER_BAND_Y_EPS_PX &&
      y < b.top + b.height + HOVER_BAND_Y_EPS_PX
    ) {
      return b;
    }
  }
  return null;
}

/** Fallback when Y falls between stacked bands — still use that band row’s slice times. */
function nearestSlotHoverBandByMidY(
  bands: readonly SlotHoverBand[],
  y: number,
): SlotHoverBand | null {
  if (bands.length === 0) return null;
  let best = bands[0]!;
  let bestAbs = Infinity;
  for (const b of bands) {
    const mid = b.top + b.height / 2;
    const d = Math.abs(y - mid);
    if (d < bestAbs) {
      bestAbs = d;
      best = b;
    }
  }
  return best;
}

/**
 * Which league `[begin,end)` block to book after a click/minute probe.
 *
 * - **Containment** `[begin,end)`: timestamps at the block end (**e.g. 13:50** Tue lunch finish)
 *   are **outside** lunch; the next probe maps to **afternoon**, not backwards at `13:10–13:50`
 *   (those blocks conflict with bulk **clinic** holds on play days — US Squash “overlapping
 *   clinic at 13:10–13:50” despite the user intending the empty band after lunch).
 *
 * - **Gaps** (padding, Tue **13:50–16:30** hole): smallest `begin` with `begin >= probe`. Top
 *   padding picks the first playable block; trailing padding picks the **last**.
 */
function resolveBookingWindowForMinute(
  tMinutes: number,
  slots: readonly { begin: string; end: string }[],
): { begin: string; end: string } | null {
  if (slots.length === 0) return null;

  const parsed = [...slots]
    .map((s) => ({
      begin: s.begin,
      end: s.end,
      a: parseHHMMToMinutes(s.begin),
      b: parseHHMMToMinutes(s.end),
    }))
    .sort((x, y) => x.a - y.a);

  const last = parsed[parsed.length - 1]!;
  const t = Number(tMinutes);

  for (const s of parsed) {
    if (t >= s.a && t < s.b) {
      return { begin: s.begin, end: s.end };
    }
  }

  const nextStart = parsed.find((s) => s.a >= t);
  if (nextStart) {
    return { begin: nextStart.begin, end: nextStart.end };
  }

  return { begin: last.begin, end: last.end };
}

/**
 * Cover [gridStart, gridEnd) with hover targets: one band per real league window, plus
 * 40‑minute slices in padding and between lunch/evening so every visible row is hoverable/bookable.
 */
function slotHoverBandsForColumn(
  gridStart: number,
  gridEnd: number,
  canonical: readonly { begin: string; end: string }[],
  pxPerMinute: number,
  bandKeyPrefix: string,
): SlotHoverBand[] {
  if (canonical.length === 0) return [];

  const intervals = [...canonical]
    .map((s) => ({
      a: parseHHMMToMinutes(s.begin),
      b: parseHHMMToMinutes(s.end),
      begin: s.begin,
      end: s.end,
    }))
    .sort((x, y) => x.a - y.a);

  const bands: SlotHoverBand[] = [];
  let bandIdx = 0;

  const pushSlice = (
    lo: number,
    hi: number,
    book: { begin: string; end: string },
  ): void => {
    if (!(hi > lo)) return;
    const sliceBegin = totalMinutesToClockHHMM(lo);
    const sliceEnd = totalMinutesToClockHHMM(hi);
    const top = (lo - gridStart) * pxPerMinute;
    const height = Math.max((hi - lo) * pxPerMinute, 4);
    bands.push({
      reactKey: `${bandKeyPrefix}-s${bandIdx++}-${Math.round(lo)}-${Math.round(hi)}`,
      top,
      height,
      sliceBegin,
      sliceEnd,
      bookBegin: book.begin,
      bookEnd: book.end,
    });
  };

  /** 40-minute hover slices in [t0,t1); pack backward from t1 so alignment matches across columns (Monday long quiet span vs shorter Tue lunch→evening gap). */
  const sliceGapWithResolvedBook = (t0: number, t1: number): void => {
    const chunks: { lo: number; hi: number }[] = [];
    let hi = t1;
    while (hi > t0) {
      const lo = Math.max(t0, hi - SLOT_BOOK_STEP_MIN);
      chunks.push({ lo, hi });
      hi = lo;
    }
    chunks.reverse();
    for (const { lo, hi } of chunks) {
      const mid = (lo + hi) / 2;
      const book =
        resolveBookingWindowForMinute(mid, canonical) ?? {
          begin: canonical[0]!.begin,
          end: canonical[0]!.end,
        };
      pushSlice(lo, hi, book);
    }
  };

  let cursor = gridStart;

  for (const iv of intervals) {
    if (iv.b <= gridStart) continue;
    if (iv.a >= gridEnd) break;

    const gapEnd = Math.min(iv.a, gridEnd);
    if (cursor < gapEnd) {
      sliceGapWithResolvedBook(cursor, gapEnd);
    }
    const lo = Math.max(gridStart, iv.a);
    const hi = Math.min(gridEnd, iv.b);
    if (hi > lo) {
      pushSlice(lo, hi, { begin: iv.begin, end: iv.end });
    }
    cursor = Math.max(cursor, iv.b);
    if (cursor >= gridEnd) break;
  }
  if (cursor < gridEnd) {
    sliceGapWithResolvedBook(cursor, gridEnd);
  }

  return bands;
}

/** Minutes-from-midnight → "HH:MM" (24h) for pairing with `formatHHMMRange12HourCompact`. */
function totalMinutesToClockHHMM(totalMinutes: number): string {
  let m = Math.round(totalMinutes) % (24 * 60);
  if (m < 0) m += 24 * 60;
  const h24 = Math.floor(m / 60);
  const mi = m % 60;
  return `${String(h24).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** Snap to one of the league’s real 40-minute windows — never interpolate odd times into padding. */
function nearestCanonicalSlotFromRightClick(
  clientY: number,
  columnEl: HTMLElement,
  gridStart: number,
  pxPerMinute: number,
  slots: readonly { begin: string; end: string }[],
): { begin: string; end: string } | null {
  const rect = columnEl.getBoundingClientRect();
  const y = clientY - rect.top;
  if (!Number.isFinite(y) || y < 0 || y > rect.height + 1) return null;

  const clickMinutes = gridStart + y / pxPerMinute;
  return resolveBookingWindowForMinute(clickMinutes, slots);
}

function parseHHMMToMinutes(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

/** "HH:MM" → "h:mm am" / "h:mm pm" (start time only, for event chips). */
function formatHHMMAs12Hour(hhmm: string): string {
  const m = parseHHMMToMinutes(hhmm);
  const h24 = Math.floor(m / 60);
  const min = m % 60;
  const period = h24 >= 12 ? "pm" : "am";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(min).padStart(2, "0")} ${period}`;
}

/** Two "HH:MM" times compact, e.g. "1:50pm - 2:30pm" (slot hover hints). */
function formatHHMMRange12HourCompact(begin: string, end: string): string {
  const compact = (hhmm: string) => formatHHMMAs12Hour(hhmm).replace(/\s+/g, "");
  return `${compact(begin)} - ${compact(end)}`;
}

/** Minutes from midnight → "h:mm am" / "h:mm pm" (time-axis labels). */
function formatTotalMinutesAs12Hour(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const mi = totalMinutes % 60;
  return formatHHMMAs12Hour(
    `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`,
  );
}

function parseISODateLocal(iso: string): Date | null {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function addDaysToDate(d: Date, days: number): Date {
  const n = new Date(d);
  n.setDate(n.getDate() + days);
  return n;
}

function formatISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Label for a season week in bulk run UI (1-based week index). */
function seasonBulkModalWeekLabel(weekNum: number): string {
  if (weekNum === SEASON_BLOCK_CALENDAR_STEPS) return `Week ${weekNum} (Semi-finals)`;
  return `Week ${weekNum}`;
}

/** "Jane Q. Doe" → first token + last token's first letter (for matchup chips). */
function shortPlayerMatchupLabel(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) return displayName;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) return tokens[0]!;
  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  const initial = last[0] ? last[0]!.toUpperCase() : "";
  return initial ? `${first} ${initial}` : first;
}

function twoPlayerVsChip(players: string[]): string | null {
  const [a, b] = players;
  if (!a || !b) return null;
  return `${shortPlayerMatchupLabel(a)} v  ${shortPlayerMatchupLabel(b)}`;
}

type BoxLeaguePlayerForMatchups = {
  id: number;
  level: number;
  playerCurrentRank: number;
  firstName: string;
  lastName: string;
};

function isVacantCourtChipLabel(label: string | undefined): boolean {
  if (!label) return true;
  const t = label.trim();
  return t === "—" || t === OPEN_BOX_SEAT_LABEL;
}

function formatSeatMatchupAsNamesFromRoster(
  pair: [number, number],
  boxLevel: number,
  roster: readonly BoxLeaguePlayerForMatchups[],
  seasonStartPlayers?: readonly BoxLeaguePlayerForMatchups[],
): string {
  const groundTruth =
    seasonStartPlayers && seasonStartPlayers.length > 0
      ? seasonStartPlayers
      : undefined;
  if (
    groundTruth &&
    roster.length > 0 &&
    !scheduleMatchPairNeedsCourtBooking(boxLevel, pair, roster, groundTruth)
  ) {
    return OPEN_BOX_SEAT_LABEL;
  }
  const p1 = livePlayerAtScheduleSeat(
    boxLevel,
    pair[0],
    roster,
    groundTruth,
  ) as BoxLeaguePlayerForMatchups | null;
  const p2 = livePlayerAtScheduleSeat(
    boxLevel,
    pair[1],
    roster,
    groundTruth,
  ) as BoxLeaguePlayerForMatchups | null;
  if (!p1 || !p2) return formatCompactMatchPair(pair);
  const n1 = `${p1.firstName.trim()} ${p1.lastName.trim()}`.trim();
  const n2 = `${p2.firstName.trim()} ${p2.lastName.trim()}`.trim();
  return `${shortPlayerMatchupLabel(n1)} v  ${shortPlayerMatchupLabel(n2)}`;
}

function matchupLabelsForBoxLevel(
  scheduleRowIndex: number,
  boxLevel: number,
  showPlayerNames: boolean,
  players: readonly BoxLeaguePlayerForMatchups[] | undefined,
  seasonStartPlayers?: readonly BoxLeaguePlayerForMatchups[],
): { c1: string; c2: string } | null {
  const row = leagueSchedule[scheduleRowIndex];
  if (!row) return null;
  if (row.isPlayoffs) {
    const parts = row.matches.split(",").map((p) => p.trim()).filter(Boolean);
    return {
      c1: parts[0] ?? "—",
      c2: parts[1] ?? "—",
    };
  }
  const w = getWeekMatchups(scheduleRowIndex + 1);
  if (showPlayerNames && players?.length) {
    return {
      c1: formatSeatMatchupAsNamesFromRoster(
        w.matches[0],
        boxLevel,
        players,
        seasonStartPlayers,
      ),
      c2: formatSeatMatchupAsNamesFromRoster(
        w.matches[1],
        boxLevel,
        players,
        seasonStartPlayers,
      ),
    };
  }
  return {
    c1: formatCompactMatchPair(w.matches[0]),
    c2: formatCompactMatchPair(w.matches[1]),
  };
}

function bookingMemberPickLabel(m: ClubMember): string {
  const n = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim();
  return n || (m.userName?.trim() ?? "") || `Member ${m.ssmId}`;
}

/** Key: `${isoDate}|${HH:MM-HH:MM}` → Stadium / Center labels from week preview. */
function buildSlotPlayerLabelsFromPreview(
  preview: PreviewResult,
  court1Id?: number,
  court2Id?: number,
): Map<string, { stadium: string; center: string }> {
  const out = new Map<string, { stadium: string; center: string }>();
  if (!("items" in preview)) return out;
  const byKey = new Map<string, Map<string, string>>();
  for (const item of preview.items) {
    const slotKey = `${item.date}|${item.slot}`;
    const label = twoPlayerVsChip(item.players);
    if (!label) continue;
    let byCourt = byKey.get(slotKey);
    if (!byCourt) {
      byCourt = new Map();
      byKey.set(slotKey, byCourt);
    }
    byCourt.set(item.courtId, label);
  }
  for (const [slotKey, byCourt] of byKey) {
    let stadium = "—";
    let center = "—";
    if (court1Id != null || court2Id != null) {
      if (court1Id != null) {
        stadium = byCourt.get(String(court1Id)) ?? "—";
      }
      if (court2Id != null) {
        center = byCourt.get(String(court2Id)) ?? "—";
      }
    } else {
      const ids = [...byCourt.keys()].sort(
        (a, b) => Number(a) - Number(b) || a.localeCompare(b),
      );
      if (ids.length > 0) stadium = byCourt.get(ids[0]!) ?? "—";
      if (ids.length > 1) center = byCourt.get(ids[1]!) ?? "—";
    }
    out.set(slotKey, { stadium, center });
  }
  return out;
}

function SeasonBlockWeekCalendar({
  preview,
  weekIndex,
  onWeekIndexChange,
  booked,
  bulkWeekConvertedToMatches,
  locallyConvertedSlotKeys,
  slotPlayerLabels,
  showMatchupPlayerNames = false,
  boxLeaguePlayers,
  seasonStartPlayers,
  onBulkSlotContextMenu,
  onReservedSlotContextMenu,
  statHolidayRegistry,
  rosterImpactHighlight,
}: {
  preview: SeasonBulkPreviewResponse;
  weekIndex: number;
  onWeekIndexChange: (i: number) => void;
  /** True when a season block already exists in Club Locker for this start Monday. */
  booked: boolean;
  /** True when this play week’s bulk block was already converted to individual match bookings. */
  bulkWeekConvertedToMatches: boolean;
  /** Per-slot purple display (local only) while the week is still bulk-held. */
  locallyConvertedSlotKeys?: ReadonlySet<string>;
  /** Optional: player-name matchup lines per date+slot (from week plan preview). */
  slotPlayerLabels?: Map<string, { stadium: string; center: string }>;
  /** When true, show roster names on matchup chips (relative rank within each box). */
  showMatchupPlayerNames?: boolean;
  boxLeaguePlayers?: readonly BoxLeaguePlayerForMatchups[];
  /** Season-start ground truth for schedule seat → player (when saved). */
  seasonStartPlayers?: readonly BoxLeaguePlayerForMatchups[];
  /** Right-click: empty column area (any day) or blue preview bulk blocks. */
  onBulkSlotContextMenu?: (e: ReactMouseEvent, slot: BulkSlotBookingRef) => void;
  /** Right-click: green bulk hold blocks or violet converted match blocks. */
  onReservedSlotContextMenu?: (
    e: ReactMouseEvent,
    slot: BulkSlotBookingRef,
    kind: "bulk" | "match",
  ) => void;
  /** Dates and hours from /api/statutory-holidays (or fallback template). */
  statHolidayRegistry: readonly StatHoliday[];
  /** Mismatched managed match bookings for the visible converted week (boxes 1–16). */
  rosterImpactHighlight?: RosterImpactCalendarHighlight;
}) {
  const monSlots = useMemo(() => bulkHoldSlotsForWeekday("mon"), []);
  const tueSlots = useMemo(() => bulkHoldSlotsForWeekday("tue"), []);

  const { gridStart, gridEnd, bodyHeight } = useMemo(() => {
    const mins = [...monSlots, ...tueSlots].flatMap((s) => [
      parseHHMMToMinutes(s.begin),
      parseHHMMToMinutes(s.end),
    ]);
    const lo = Math.min(...mins);
    const hi = Math.max(...mins);
    const padMin = 25;
    const g0 = Math.floor(Math.max(0, lo - padMin) / 30) * 30;
    const g1 = Math.ceil((hi + padMin) / 30) * 30;
    return {
      gridStart: g0,
      gridEnd: g1,
      bodyHeight: (g1 - g0) * SEASON_BULK_PX_PER_MINUTE,
    };
  }, [monSlots, tueSlots]);

  const hourTicks = useMemo(() => {
    const out: number[] = [];
    const first = Math.ceil(gridStart / 60) * 60;
    for (let m = first; m <= gridEnd; m += 60) {
      out.push(m);
    }
    return out;
  }, [gridStart, gridEnd]);

  const halfHourLines = useMemo(() => {
    const out: number[] = [];
    for (let m = Math.ceil(gridStart / 30) * 30; m <= gridEnd; m += 30) {
      out.push(m);
    }
    return out;
  }, [gridStart, gridEnd]);

  const mergedQuietBookingSlots = useMemo(
    () => mergeCanonicalBookingWindows(monSlots, tueSlots),
    [monSlots, tueSlots],
  );

  const hoverBandsMon = useMemo(
    () =>
      slotHoverBandsForColumn(
        gridStart,
        gridEnd,
        monSlots.map((s) => ({ begin: s.begin, end: s.end })),
        SEASON_BULK_PX_PER_MINUTE,
        "mon",
      ),
    [gridStart, gridEnd, monSlots],
  );
  const hoverBandsTue = useMemo(
    () =>
      slotHoverBandsForColumn(
        gridStart,
        gridEnd,
        tueSlots.map((s) => ({ begin: s.begin, end: s.end })),
        SEASON_BULK_PX_PER_MINUTE,
        "tue",
      ),
    [gridStart, gridEnd, tueSlots],
  );
  const hoverBandsQuiet = useMemo(
    () =>
      slotHoverBandsForColumn(
        gridStart,
        gridEnd,
        mergedQuietBookingSlots,
        SEASON_BULK_PX_PER_MINUTE,
        "quiet",
      ),
    [gridStart, gridEnd, mergedQuietBookingSlots],
  );

  const startMonday = parseISODateLocal(preview.startMondayDate);
  if (!startMonday) {
    return (
      <p className="weekly-empty">
        Preview data is incomplete. Refresh the preview after setting the season start Monday.
      </p>
    );
  }

  const playDates = seasonWeekPlayDatesWithRegistry(
    preview.startMondayDate,
    weekIndex + 1,
    statHolidayRegistry,
  );
  const playMonday = parseISODateLocal(playDates.weekMonday) ?? addDaysToDate(startMonday, weekIndex * 7);
  const firstPlayCol = playDates.shiftedByHoliday ? 2 : 1; // Tue when shifted, else Mon
  const secondPlayCol = playDates.shiftedByHoliday ? 3 : 2; // Wed when shifted, else Tue
  const weekStartSunday = addDaysToDate(playMonday, -1);
  const weekEndSaturday = addDaysToDate(playMonday, 5);
  const canPrev = weekIndex > 0;
  const canNext = weekIndex < SEASON_BLOCK_CALENDAR_STEPS - 1;
  const isSemisPane = weekIndex === SEASON_BLOCK_CALENDAR_STEPS - 1;
  /** Green “bulk hold” only for the seven regular season weeks; semis uses preview (blue) unless converted. */
  const bulkHoldShowsBooked =
    booked && weekIndex < REGULAR_SEASON_WEEKS_IN_CALENDAR;

  const scheduleRowIndex = weekIndex % leagueSchedule.length;
  const weekScheduleRow = leagueSchedule[scheduleRowIndex];

  const weekCourtMatchups = useMemo((): { c1: string; c2: string } | null => {
    const row = leagueSchedule[scheduleRowIndex];
    if (!row) return null;
    if (row.isPlayoffs) {
      const parts = row.matches.split(",").map((p) => p.trim()).filter(Boolean);
      return {
        c1: parts[0] ?? "—",
        c2: parts[1] ?? "—",
      };
    }
    const w = getWeekMatchups(scheduleRowIndex + 1);
    return {
      c1: formatCompactMatchPair(w.matches[0]),
      c2: formatCompactMatchPair(w.matches[1]),
    };
  }, [scheduleRowIndex]);

  const fmtRange = (d: Date) =>
    d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });

  return (
    <div className="season-bulk-cal">
      <div className="season-bulk-cal-toolbar">
        <div
          className="season-bulk-cal-nav"
          role="group"
          aria-label={
            isSemisPane ? "Semi-finals week navigation" : "Regular season week navigation"
          }
        >
          <button
            type="button"
            className="icon-btn"
            aria-label={isSemisPane ? "Back to regular season" : "Previous week"}
            disabled={!canPrev}
            onClick={() => onWeekIndexChange(weekIndex - 1)}
          >
            <ChevronLeft size={18} aria-hidden />
          </button>
          <span style={{ fontWeight: 600, minWidth: "11rem", textAlign: "center" }}>
            {isSemisPane ? "Semis" : `Season week ${weekIndex + 1} of ${REGULAR_SEASON_WEEKS_IN_CALENDAR}`}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label={
              weekIndex === REGULAR_SEASON_WEEKS_IN_CALENDAR - 1
                ? "Go to semi-finals"
                : "Next week"
            }
            disabled={!canNext}
            onClick={() => onWeekIndexChange(weekIndex + 1)}
          >
            <ChevronRight size={18} aria-hidden />
          </button>
        </div>
        <div className="season-bulk-cal-legend-wrap">
          <ul className="season-bulk-cal-legend" aria-label="Calendar legend">
            <li>
              <span
                className="season-bulk-legend-swatch season-bulk-legend-swatch--unbooked"
                aria-hidden
              />
              <span>Unbooked (preview)</span>
            </li>
            <li>
              <span
                className="season-bulk-legend-swatch season-bulk-legend-swatch--booked"
                aria-hidden
              />
              <span>Bulk season block (held)</span>
            </li>
            <li>
              <span
                className="season-bulk-legend-swatch season-bulk-legend-swatch--match-booked"
                aria-hidden
              />
              <span>Match bookings (week converted)</span>
            </li>
            <li>
              <span
                className="season-bulk-legend-swatch season-bulk-legend-swatch--roster-stale"
                aria-hidden
              />
              <span>Roster changed — update booking</span>
            </li>
            <li>
              <span
                className="season-bulk-legend-swatch season-bulk-legend-swatch--holiday"
                aria-hidden
              />
              <span>Holiday, event, or closed day</span>
            </li>
            <li>
              <span
                className="season-bulk-legend-swatch season-bulk-legend-swatch--play-day"
                aria-hidden
              />
              <span>League play days</span>
            </li>
          </ul>
        </div>
        <p className="season-bulk-cal-range">
          {fmtRange(weekStartSunday)} – {fmtRange(weekEndSaturday)}
        </p>
      </div>

      <div className="gcal-week-scroll" role="region" aria-label="Week grid, Sunday through Saturday">
        <div className="gcal-week">
          <div className="gcal-week-header">
            <div className="gcal-week-header-spacer" aria-hidden />
            {WEEK_SUN_FIRST.map((dowLabel, col) => {
              const d = addDaysToDate(playMonday, col - 1);
              const iso = formatISODate(d);
              const dateShort = d.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              });
              const active = col === firstPlayCol || col === secondPlayCol;
              return (
                <div
                  key={iso}
                  className={`gcal-week-head-cell${active ? " gcal-week-head-cell--play" : ""}`}
                >
                  <span className="gcal-week-head-dow">{dowLabel}</span>
                  <span className="gcal-week-head-date">{dateShort}</span>
                  <span className="gcal-week-head-iso">{iso}</span>
                </div>
              );
            })}
          </div>

          <div className="gcal-week-body">
            <div
              className="gcal-time-gutter"
              style={{ height: bodyHeight }}
              aria-hidden
            >
              {hourTicks.map((m) => (
                <div
                  key={m}
                  className="gcal-time-tick"
                  style={{
                    top: (m - gridStart) * SEASON_BULK_PX_PER_MINUTE,
                  }}
                >
                  {formatTotalMinutesAs12Hour(m)}
                </div>
              ))}
            </div>

            <div className="gcal-day-columns">
              {WEEK_SUN_FIRST.map((dowLabel, col) => {
                const d = addDaysToDate(playMonday, col - 1);
                const iso = formatISODate(d);
                const holiday = statHolidayForDateInRegistry(iso, statHolidayRegistry);
                const active = col === firstPlayCol || col === secondPlayCol;
                const slots = col === firstPlayCol ? monSlots : col === secondPlayCol ? tueSlots : [];
                const holidayCloseMinutes = holiday?.hours.close
                  ? parseHHMMToMinutes(holiday.hours.close)
                  : null;
                const holidayBlockedStart = holiday?.hours.closed
                  ? gridStart
                  : holidayCloseMinutes != null
                    ? holidayCloseMinutes
                    : null;
                const holidayBlockedEnd = gridEnd;
                const shouldRenderHolidayBlock = holiday != null &&
                  holidayBlockedStart != null &&
                  holidayBlockedStart < holidayBlockedEnd;

                const bookingSlotsForRightClick =
                  col === firstPlayCol
                    ? monSlots.map((s) => ({ begin: s.begin, end: s.end }))
                    : col === secondPlayCol
                      ? tueSlots.map((s) => ({ begin: s.begin, end: s.end }))
                      : mergedQuietBookingSlots;

                const bookingHoverBands =
                  col === firstPlayCol
                    ? hoverBandsMon
                    : col === secondPlayCol
                      ? hoverBandsTue
                      : hoverBandsQuiet;

                return (
                  <div
                    key={iso}
                    className={`gcal-day-col${active ? " gcal-day-col--play" : " gcal-day-col--quiet"}`}
                    role="group"
                    aria-label={`${dowLabel} ${iso}${active ? ", season bulk holds" : ", no bulk holds"}`}
                  >
                    <div
                      className="gcal-day-col-inner"
                      style={{ height: bodyHeight }}
                    >
                      {onBulkSlotContextMenu ? (
                        <div
                          className="gcal-day-book-capture"
                          aria-hidden
                          onContextMenu={(e) => {
                            e.preventDefault();
                            const rect = e.currentTarget.getBoundingClientRect();
                            const y = e.clientY - rect.top;
                            const hit = findSlotHoverBandAtRelativeY(
                              bookingHoverBands,
                              y,
                            );
                            const picked =
                              hit ??
                              nearestSlotHoverBandByMidY(bookingHoverBands, y);
                            if (picked) {
                              onBulkSlotContextMenu(e, {
                                date: iso,
                                begin: picked.sliceBegin,
                                end: picked.sliceEnd,
                              });
                              return;
                            }
                            const slot = nearestCanonicalSlotFromRightClick(
                              e.clientY,
                              e.currentTarget,
                              gridStart,
                              SEASON_BULK_PX_PER_MINUTE,
                              bookingSlotsForRightClick,
                            );
                            if (slot) {
                              onBulkSlotContextMenu(e, {
                                date: iso,
                                begin: slot.begin,
                                end: slot.end,
                              });
                            }
                          }}
                        />
                      ) : null}
                      <div className="gcal-day-grid-lines" aria-hidden>
                        {halfHourLines.map((m) => (
                          <div
                            key={m}
                            className={
                              m % 60 === 0 ? "gcal-grid-line gcal-grid-line--hour" : "gcal-grid-line"
                            }
                            style={{
                              top: (m - gridStart) * SEASON_BULK_PX_PER_MINUTE,
                            }}
                          />
                        ))}
                      </div>
                      {onBulkSlotContextMenu
                        ? bookingHoverBands.map((band) => {
                            const displayRange = formatHHMMRange12HourCompact(
                              band.sliceBegin,
                              band.sliceEnd,
                            );
                            return (
                              <div
                                key={`${iso}-${band.reactKey}`}
                                className="gcal-slot-book-band"
                                aria-label={`Book ${displayRange}. Right-click.`}
                                style={{ top: band.top, height: band.height }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  onBulkSlotContextMenu(e, {
                                    date: iso,
                                    begin: band.sliceBegin,
                                    end: band.sliceEnd,
                                  });
                                }}
                              >
                                <span className="gcal-slot-book-band-label" aria-hidden>
                                  {displayRange}
                                </span>
                              </div>
                            );
                          })
                        : null}
                      {active &&
                        slots.map((s, slotIdx) => {
                          const level = weekScheduleRow?.levels[slotIdx];
                          const isSecondPlayDay = col === secondPlayCol;
                          const box =
                            level != null
                              ? isSecondPlayDay
                                ? level + 8
                                : level
                              : null;
                          const t0 = parseHHMMToMinutes(s.begin);
                          const t1 = parseHHMMToMinutes(s.end);
                          const top = (t0 - gridStart) * SEASON_BULK_PX_PER_MINUTE;
                          const h = Math.max(
                            (t1 - t0) * SEASON_BULK_PX_PER_MINUTE,
                            20,
                          );
                          const slotLookupKey = `${iso}|${s.begin}-${s.end}`;
                          const previewLabels = showMatchupPlayerNames
                            ? slotPlayerLabels?.get(slotLookupKey)
                            : undefined;
                          const boxMatchups =
                            box != null
                              ? matchupLabelsForBoxLevel(
                                  scheduleRowIndex,
                                  box,
                                  showMatchupPlayerNames,
                                  boxLeaguePlayers,
                                  seasonStartPlayers,
                                )
                              : null;
                          const stadiumMu =
                            previewLabels?.stadium ??
                            boxMatchups?.c1 ??
                            weekCourtMatchups?.c1;
                          const centerMu =
                            previewLabels?.center ??
                            boxMatchups?.c2 ??
                            weekCourtMatchups?.c2;
                          const titleBits = [
                            `${s.begin}–${s.end}`,
                            box != null ? `box ${box}` : null,
                            !isVacantCourtChipLabel(stadiumMu) ||
                            !isVacantCourtChipLabel(centerMu)
                              ? [
                                  !isVacantCourtChipLabel(stadiumMu)
                                    ? `Stadium: ${stadiumMu}`
                                    : null,
                                  !isVacantCourtChipLabel(centerMu)
                                    ? `Center: ${centerMu}`
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : null,
                          ].filter(Boolean);
                          const slotLocalKey = localBookingSlotKey(
                            weekIndex + 1,
                            iso,
                            s.begin,
                            s.end,
                          );
                          const slotShowAsConverted =
                            bulkWeekConvertedToMatches ||
                            (locallyConvertedSlotKeys?.has(slotLocalKey) ?? false);
                          const weekBulkBlockHeld =
                            bulkHoldShowsBooked && !slotShowAsConverted;
                          const chipKey =
                            box != null && bulkWeekConvertedToMatches
                              ? rosterImpactCalendarChipKey(
                                  weekIndex + 1,
                                  iso,
                                  s.begin,
                                  s.end,
                                  box,
                                )
                              : null;
                          const chipNeedsRosterUpdate =
                            chipKey != null &&
                            rosterImpactHighlight?.chipKeys.has(chipKey);
                          const stadiumNeedsUpdate =
                            chipKey != null &&
                            rosterImpactHighlight?.stadiumChipKeys.has(chipKey);
                          const centerNeedsUpdate =
                            chipKey != null &&
                            rosterImpactHighlight?.centerChipKeys.has(chipKey);
                          const stadiumAfter =
                            chipKey != null
                              ? rosterImpactHighlight?.afterLabelByChipCourt.get(
                                  `${chipKey}|stadium`,
                                )
                              : undefined;
                          const centerAfter =
                            chipKey != null
                              ? rosterImpactHighlight?.afterLabelByChipCourt.get(
                                  `${chipKey}|center`,
                                )
                              : undefined;
                          const rosterTitleBits = [
                            ...titleBits,
                            chipNeedsRosterUpdate
                              ? `Update booking: Stadium → ${stadiumAfter ?? "—"}; Center → ${centerAfter ?? "—"}`
                              : null,
                          ].filter(Boolean);
                          return (
                            <div
                              key={`${iso}-${s.slotLabel}`}
                              className={[
                                slotShowAsConverted
                                  ? "gcal-event gcal-event--bulk gcal-event--match-booked"
                                  : weekBulkBlockHeld
                                    ? "gcal-event gcal-event--bulk gcal-event--booked"
                                    : onBulkSlotContextMenu
                                      ? "gcal-event gcal-event--bulk gcal-event--slot-book"
                                      : "gcal-event gcal-event--bulk",
                                chipNeedsRosterUpdate
                                  ? "gcal-event--roster-needs-update"
                                  : "",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                              style={{ top, height: h }}
                              title={rosterTitleBits.join(" · ")}
                              onContextMenu={
                                slotShowAsConverted
                                  ? onReservedSlotContextMenu
                                    ? (e) => {
                                        e.preventDefault();
                                        onReservedSlotContextMenu(e, {
                                          date: iso,
                                          begin: s.begin,
                                          end: s.end,
                                        }, "match");
                                      }
                                    : undefined
                                  : weekBulkBlockHeld
                                    ? onReservedSlotContextMenu
                                      ? (e) => {
                                          e.preventDefault();
                                          onReservedSlotContextMenu(e, {
                                            date: iso,
                                            begin: s.begin,
                                            end: s.end,
                                          }, "bulk");
                                        }
                                      : (e) => {
                                          e.preventDefault();
                                        }
                                    : onBulkSlotContextMenu
                                      ? (e) => {
                                          e.preventDefault();
                                          onBulkSlotContextMenu(e, {
                                            date: iso,
                                            begin: s.begin,
                                            end: s.end,
                                          });
                                        }
                                      : undefined
                              }
                            >
                              <div className="gcal-event-toprow">
                                <span className="gcal-event-time">
                                  {formatHHMMAs12Hour(s.begin)}
                                </span>
                                {box != null ? (
                                  <span className="gcal-event-meta gcal-event-box">
                                    Box {box}
                                  </span>
                                ) : null}
                              </div>
                              {!isVacantCourtChipLabel(stadiumMu) ||
                              !isVacantCourtChipLabel(centerMu) ? (
                                <div
                                  className="gcal-event-courts"
                                  aria-label="This week: Stadium and Center matchups"
                                >
                                  <div
                                    className={[
                                      "gcal-event-court",
                                      isVacantCourtChipLabel(stadiumMu)
                                        ? "gcal-event-court--vacant"
                                        : "",
                                      stadiumNeedsUpdate
                                        ? "gcal-event-court--roster-needs-update"
                                        : "",
                                    ]
                                      .filter(Boolean)
                                      .join(" ")}
                                  >
                                    <span className="gcal-event-court-hd">Stadium</span>
                                    <span className="gcal-event-court-mu">
                                      {stadiumMu ?? "—"}
                                    </span>
                                    {stadiumNeedsUpdate && stadiumAfter ? (
                                      <span className="gcal-event-court-after">
                                        → {stadiumAfter}
                                      </span>
                                    ) : null}
                                  </div>
                                  <div
                                    className={[
                                      "gcal-event-court",
                                      isVacantCourtChipLabel(centerMu)
                                        ? "gcal-event-court--vacant"
                                        : "",
                                      centerNeedsUpdate
                                        ? "gcal-event-court--roster-needs-update"
                                        : "",
                                    ]
                                      .filter(Boolean)
                                      .join(" ")}
                                  >
                                    <span className="gcal-event-court-hd">Center</span>
                                    <span className="gcal-event-court-mu">
                                      {centerMu ?? "—"}
                                    </span>
                                    {centerNeedsUpdate && centerAfter ? (
                                      <span className="gcal-event-court-after">
                                        → {centerAfter}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      {shouldRenderHolidayBlock ? (
                        <div
                          className="gcal-event"
                          style={{
                            top: (holidayBlockedStart - gridStart) * SEASON_BULK_PX_PER_MINUTE,
                            height: Math.max(
                              (holidayBlockedEnd - holidayBlockedStart) * SEASON_BULK_PX_PER_MINUTE,
                              20,
                            ),
                            background: "#dc2626",
                            borderColor: "#b91c1c",
                            color: "#fff",
                            zIndex: 4,
                          }}
                          title={holiday.name}
                          onContextMenu={(e) => {
                            e.preventDefault();
                          }}
                        >
                          <div className="gcal-event-toprow">
                            <span className="gcal-event-time">
                              {formatTotalMinutesAs12Hour(holidayBlockedStart)}
                            </span>
                          </div>
                          <div>{holiday.name}</div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {playDates.shiftedByHoliday ? (
        <p className="weekly-meta" style={{ marginBottom: 0, marginTop: "0.75rem" }}>
          This week is shifted to Tuesday/Wednesday because {playDates.holidayName} falls on Monday.
        </p>
      ) : null}
    </div>
  );
}

export function BookingPage({
  seasonId,
  seasonStartMondayISO = "",
  boxLeaguePlayers,
  onLog,
}: {
  seasonId: string;
  /** First Monday for the selected DB season (from calendar_segment + club_year). */
  seasonStartMondayISO?: string;
  /** Roster from the linked box league (Boxes tab / players endpoint). */
  boxLeaguePlayers?: readonly BoxLeaguePlayerForMatchups[];
  onLog: (s: string) => void;
}) {
  const [showMatchupPlayerNames, setShowMatchupPlayerNames] = useState(false);
  const [seasonStartPlayers, setSeasonStartPlayers] = useState<
    BoxLeaguePlayerForMatchups[]
  >([]);
  const [startMondayForSeason, setStartMondayForSeason] = useState("");
  const [weeksToBook, setWeeksToBook] = useState<number>(8);
  const [seasonBulkRunModalOpen, setSeasonBulkRunModalOpen] = useState(false);
  const [seasonBulkRunDraftWeeks, setSeasonBulkRunDraftWeeks] = useState(8);
  const [seasonBlockBooked, setSeasonBlockBooked] = useState(false);
  const [activeSeasonHold, setActiveSeasonHold] = useState<{
    id: string;
    seasonWeeks: number;
    status: string;
    convertedWeeks: number[];
    locallyConvertedSlotKeys: Set<string>;
  } | null>(null);
  const hasActiveSeasonHoldForConvert =
    activeSeasonHold?.status === "active" && Boolean(activeSeasonHold.id);
  const hasSeasonHoldRegistered = Boolean(activeSeasonHold?.id);
  const activeSeasonHoldId = activeSeasonHold?.id ?? null;
  const [seasonBulkFeedback, setSeasonBulkFeedback] = useState<{
    kind: "idempotent" | "success" | "cleared" | "error";
    message: string;
    /** From API when Club Locker still has reservations in those slots. */
    slotConflict?: boolean;
  } | null>(null);
  const [seasonBulkSubmitting, setSeasonBulkSubmitting] = useState(false);
  const [lastSeasonBulkApiResponse, setLastSeasonBulkApiResponse] = useState<
    SeasonBulkResult | { error: string } | null
  >(null);
  const [copySeasonBulkResponseStatus, setCopySeasonBulkResponseStatus] = useState<
    string | null
  >(null);
  const [seasonPreview, setSeasonPreview] =
    useState<SeasonBulkPreviewResponse | null>(null);
  const [seasonPreviewLoading, setSeasonPreviewLoading] = useState(false);
  const [seasonPreviewError, setSeasonPreviewError] = useState<string | null>(
    null,
  );
  const [seasonCalendarWeekIndex, setSeasonCalendarWeekIndex] = useState(0);
  const calendarWeekNumber = seasonCalendarWeekIndex + 1;
  const [apiHolidayRegistry, setApiHolidayRegistry] = useState<
    StatHoliday[] | undefined
  >(undefined);
  const [rosterImpact, setRosterImpact] = useState<RosterImpactPayload | null>(
    null,
  );
  const [rosterImpactLoading, setRosterImpactLoading] = useState(false);
  const [rosterImpactApplyModalOpen, setRosterImpactApplyModalOpen] =
    useState(false);
  const [rosterImpactApplyBusy, setRosterImpactApplyBusy] = useState(false);
  const [rosterImpactApplyProgress, setRosterImpactApplyProgress] = useState<{
    current: number;
    total: number;
    label: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        type HRow = {
          id: string;
          name: string;
          date: string;
          kind?: "holiday" | "event";
          hours: {
            open: string | null;
            close: string | null;
            closed: boolean;
          };
        };
        const rows = await api<HRow[]>("/api/statutory-holidays");
        if (cancelled) return;
        setApiHolidayRegistry(
          rows.map((r) => ({
            name: r.name,
            date: r.date,
            kind: r.kind === "event" ? "event" : "holiday",
            hours: {
              open: r.hours.open,
              close: r.hours.close,
              closed: r.hours.closed,
            },
          })),
        );
      } catch {
        if (!cancelled) setApiHolidayRegistry(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fallbackHolidayRegistry = useMemo(() => {
    const sm = parseISODateLocal(startMondayForSeason);
    const y0 = sm?.getFullYear() ?? new Date().getFullYear();
    const byDate = new Map<string, StatHoliday>();
    for (const y of [y0 - 1, y0, y0 + 1]) {
      for (const h of statutoryHolidaysForYear(y)) {
        byDate.set(h.date, h);
      }
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [startMondayForSeason]);

  const holidayRegistry = apiHolidayRegistry ?? fallbackHolidayRegistry;
  const bulkWeekConvertedToMatches = Boolean(
    activeSeasonHold?.convertedWeeks?.includes(calendarWeekNumber),
  );

  const convertedWeeksKey = activeSeasonHold?.convertedWeeks?.join(",") ?? "";
  const locallyConvertedSlotsKey = [
    ...Array.from(activeSeasonHold?.locallyConvertedSlotKeys ?? []).sort(),
  ].join("|");

  const refreshRosterImpact = useCallback(async () => {
    if (!seasonId || !activeSeasonHold?.convertedWeeks?.length) {
      setRosterImpact(null);
      return;
    }
    setRosterImpactLoading(true);
    try {
      const payload = await api<RosterImpactPayload>(
        `/api/seasons/${seasonId}/house-league/roster-impact?weekFilter=current_and_future`,
      );
      setRosterImpact(payload);
    } catch (err) {
      console.error(err);
      setRosterImpact(null);
    } finally {
      setRosterImpactLoading(false);
    }
  }, [seasonId, convertedWeeksKey, locallyConvertedSlotsKey]);

  useEffect(() => {
    refreshRosterImpact().catch(() => {});
  }, [refreshRosterImpact, boxLeaguePlayers]);

  const courtSlotsToApply = useMemo((): CourtImpactRow[] => {
    const rows =
      rosterImpact?.courtRows.filter((r) => r.status !== "ok" && r.managed) ??
      [];
    return [...rows].sort((a, b) => {
      if (a.weekNumber !== b.weekNumber) return a.weekNumber - b.weekNumber;
      if (a.playDate !== b.playDate) return a.playDate.localeCompare(b.playDate);
      if (a.slot !== b.slot) return a.slot.localeCompare(b.slot);
      return a.courtId - b.courtId;
    });
  }, [rosterImpact]);

  const rosterImpactHighlight = useMemo((): RosterImpactCalendarHighlight | undefined => {
    if (!rosterImpact || !bulkWeekConvertedToMatches) return undefined;
    const chipKeys = new Set<string>();
    const stadiumChipKeys = new Set<string>();
    const centerChipKeys = new Set<string>();
    const afterLabelByChipCourt = new Map<string, string>();
    const court1 = rosterImpact.court1Id;
    const court2 = rosterImpact.court2Id;

    for (const row of rosterImpact.courtRows) {
      if (row.status === "ok" || row.weekNumber !== calendarWeekNumber) continue;
      const win = parseReservationSlotWindow(row.slot);
      if (!win) continue;
      const chipKey = rosterImpactCalendarChipKey(
        row.weekNumber,
        row.playDate,
        win.begin,
        win.end,
        row.boxNumber,
      );
      chipKeys.add(chipKey);
      const courtSide =
        row.courtId === court1
          ? "stadium"
          : row.courtId === court2
            ? "center"
            : null;
      if (courtSide === "stadium") stadiumChipKeys.add(chipKey);
      else if (courtSide === "center") centerChipKeys.add(chipKey);
      if (courtSide) {
        if (row.after) {
          afterLabelByChipCourt.set(
            `${chipKey}|${courtSide}`,
            `${row.after.playerNames[0]} vs ${row.after.playerNames[1]}`,
          );
        } else if (row.status === "extra_booking") {
          afterLabelByChipCourt.set(`${chipKey}|${courtSide}`, "Cancel booking");
        }
      }
    }

    if (chipKeys.size === 0) return undefined;
    return {
      chipKeys,
      stadiumChipKeys,
      centerChipKeys,
      afterLabelByChipCourt,
    };
  }, [rosterImpact, bulkWeekConvertedToMatches, calendarWeekNumber]);

  const visibleWeekCourtSlotsNeedingUpdate = useMemo(
    () =>
      rosterImpact?.courtRows.filter(
        (r) =>
          r.status !== "ok" &&
          r.managed &&
          r.weekNumber === calendarWeekNumber,
      ).length ?? 0,
    [rosterImpact, calendarWeekNumber],
  );

  /** Weeks still covered by an active bulk hold (not converted) cannot be unchecked in a new run. */
  const minBulkRunDraftWeeks = useMemo(() => {
    if (!activeSeasonHold || activeSeasonHold.status !== "active") return 0;
    let max = 0;
    for (let w = 1; w <= SEASON_BLOCK_CALENDAR_STEPS; w++) {
      if (
        w <= activeSeasonHold.seasonWeeks &&
        !activeSeasonHold.convertedWeeks.includes(w)
      ) {
        max = w;
      }
    }
    return max;
  }, [activeSeasonHold]);

  const isBulkWeekStillHeld = useCallback(
    (weekNum: number) => {
      if (!activeSeasonHold || activeSeasonHold.status !== "active") return false;
      if (weekNum > activeSeasonHold.seasonWeeks) return false;
      return !activeSeasonHold.convertedWeeks.includes(weekNum);
    },
    [activeSeasonHold],
  );

  /** Week not yet marked converted in this app's DB (for local sync without Club Locker). */
  const isWeekPendingLocalConvert = useCallback(
    (weekNum: number) => {
      if (!activeSeasonHold) return false;
      if (weekNum > activeSeasonHold.seasonWeeks) return false;
      return !activeSeasonHold.convertedWeeks.includes(weekNum);
    },
    [activeSeasonHold],
  );

  const visibleWeekCanConvert = Boolean(
    hasActiveSeasonHoldForConvert &&
      activeSeasonHold &&
      calendarWeekNumber <= activeSeasonHold.seasonWeeks &&
      isBulkWeekStillHeld(calendarWeekNumber),
  );

  const [viewedWeekPreview, setViewedWeekPreview] = useState<PreviewResult | null>(
    null,
  );
  const [viewedWeekPreviewLoading, setViewedWeekPreviewLoading] = useState(false);
  const [convertWeekLoading, setConvertWeekLoading] = useState(false);
  const [stadiumIdMapTestLoading, setStadiumIdMapTestLoading] = useState(false);
  const [bookSlotBothCourtsLoading, setBookSlotBothCourtsLoading] = useState(false);
  const [convertFeedback, setConvertFeedback] = useState<{
    kind: "ok" | "error";
    message: string;
  } | null>(null);
  const [convertWeeksModalOpen, setConvertWeeksModalOpen] = useState(false);
  const [convertWeeksModalSelected, setConvertWeeksModalSelected] = useState<
    Set<number>
  >(() => new Set());

  const slotContextMenuRef = useRef<HTMLDivElement | null>(null);
  const cancelBookingsSelectAllRef = useRef<HTMLInputElement | null>(null);
  const seasonBulkRunInFlightRef = useRef(false);
  const cancelBookingsSubmitInFlightRef = useRef(false);
  const [slotContextMenu, setSlotContextMenu] = useState<SlotContextMenuState | null>(
    null,
  );
  const [singleBookDraft, setSingleBookDraft] = useState<BulkSlotBookingRef | null>(
    null,
  );
  const [singleBookCourt, setSingleBookCourt] = useState<"stadium" | "center">(
    "stadium",
  );
  const [singleBookP1, setSingleBookP1] = useState<number | null>(null);
  const [singleBookP2, setSingleBookP2] = useState<number | null>(null);
  const [singleBookSubmitting, setSingleBookSubmitting] = useState(false);
  const [singleBookFeedback, setSingleBookFeedback] = useState<string | null>(null);
  /** When true, confirming first cancels this slot’s bulk hold on the chosen court only (no member notify), then creates the match. */
  const [singleBookReplacesBulkHold, setSingleBookReplacesBulkHold] = useState(false);
  const [bookingMembers, setBookingMembers] = useState<ClubMember[]>([]);
  const [bookingMembersLoading, setBookingMembersLoading] = useState(false);

  const [cancelBookingsOpen, setCancelBookingsOpen] = useState(false);
  const [cancelBookingsRows, setCancelBookingsRows] = useState<CancellableCalendarRow[]>(
    [],
  );
  const [cancelBookingsSelected, setCancelBookingsSelected] = useState<Set<string>>(
    () => new Set(),
  );
  const [cancelBookingsLoading, setCancelBookingsLoading] = useState(false);
  const [cancelBookingsSubmitting, setCancelBookingsSubmitting] = useState(false);
  const [cancelBookingsFetchError, setCancelBookingsFetchError] = useState<string | null>(
    null,
  );
  const [cancelBookingsFeedback, setCancelBookingsFeedback] = useState<string | null>(
    null,
  );

  const openBulkSlotContextMenu = useCallback((e: ReactMouseEvent, slot: BulkSlotBookingRef) => {
    setSlotContextMenu({
      x: e.clientX,
      y: e.clientY,
      date: slot.date,
      begin: slot.begin,
      end: slot.end,
      mode: "book",
    });
  }, []);

  const openReservedSlotContextMenu = useCallback(
    (e: ReactMouseEvent, slot: BulkSlotBookingRef, kind: "bulk" | "match") => {
      setSlotContextMenu({
        x: e.clientX,
        y: e.clientY,
        date: slot.date,
        begin: slot.begin,
        end: slot.end,
        mode: kind,
      });
    },
    [],
  );

  const excludedSsmIdsForBookingP1 = useMemo(
    () =>
      singleBookP2 != null ? new Set<number>([singleBookP2]) : new Set<number>(),
    [singleBookP2],
  );
  const excludedSsmIdsForBookingP2 = useMemo(
    () =>
      singleBookP1 != null ? new Set<number>([singleBookP1]) : new Set<number>(),
    [singleBookP1],
  );

  useEffect(() => {
    let cancelled = false;
    setBookingMembersLoading(true);
    void (async () => {
      try {
        const data = await api<ClubMember[]>("/api/club-members");
        if (!cancelled) setBookingMembers(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setBookingMembers([]);
      } finally {
        if (!cancelled) setBookingMembersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!slotContextMenu) return;
    const onDocMouseDown = (ev: MouseEvent) => {
      const el = slotContextMenuRef.current;
      if (el && ev.target instanceof Node && el.contains(ev.target)) return;
      setSlotContextMenu(null);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [slotContextMenu]);

  useEffect(() => {
    if (!cancelBookingsOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setCancelBookingsOpen(false);
        setCancelBookingsFeedback(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelBookingsOpen]);

  useEffect(() => {
    if (!seasonBulkRunModalOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !seasonBulkSubmitting) {
        setSeasonBulkRunModalOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seasonBulkRunModalOpen, seasonBulkSubmitting]);

  useEffect(() => {
    if (!convertWeeksModalOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !convertWeekLoading) {
        setConvertWeeksModalOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [convertWeeksModalOpen, convertWeekLoading]);

  useEffect(() => {
    if (convertWeeksModalOpen && !hasSeasonHoldRegistered) {
      setConvertWeeksModalOpen(false);
    }
  }, [convertWeeksModalOpen, hasSeasonHoldRegistered]);

  useEffect(() => {
    if (!singleBookDraft) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setSingleBookDraft(null);
        setSingleBookFeedback(null);
        setSingleBookReplacesBulkHold(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [singleBookDraft]);

  const slotPlayerLabelsForCalendar = useMemo(() => {
    if (!viewedWeekPreview || !("items" in viewedWeekPreview)) return undefined;
    return buildSlotPlayerLabelsFromPreview(
      viewedWeekPreview,
      rosterImpact?.court1Id,
      rosterImpact?.court2Id,
    );
  }, [viewedWeekPreview, rosterImpact?.court1Id, rosterImpact?.court2Id]);

  const seasonBulkIssueLines = useMemo(
    () =>
      lastSeasonBulkApiResponse
        ? extractSeasonBulkIssueLines(lastSeasonBulkApiResponse)
        : [],
    [lastSeasonBulkApiResponse],
  );

  useEffect(() => {
    if (seasonStartMondayISO) setStartMondayForSeason(seasonStartMondayISO);
  }, [seasonId, seasonStartMondayISO]);

  useEffect(() => {
    if (!seasonId) {
      setSeasonStartPlayers([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ players: unknown[] }>(
          `/api/seasons/${seasonId}/season-start-roster`,
        );
        if (cancelled) return;
        const parsed: BoxLeaguePlayerForMatchups[] = [];
        for (const raw of res.players ?? []) {
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
          parsed.push({
            id,
            level,
            playerCurrentRank,
            firstName: typeof r.firstName === "string" ? r.firstName : "",
            lastName: typeof r.lastName === "string" ? r.lastName : "",
          });
        }
        setSeasonStartPlayers(parsed);
      } catch {
        if (!cancelled) setSeasonStartPlayers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seasonId]);

  /** Load week plan preview for the calendar week so chips can show player names. */
  useEffect(() => {
    if (!seasonId || !startMondayForSeason) {
      setViewedWeekPreview(null);
      setViewedWeekPreviewLoading(false);
      return;
    }
    const weekNumber = seasonCalendarWeekIndex + 1;
    const dates = seasonWeekPlayDatesWithRegistry(
      startMondayForSeason,
      weekNumber,
      holidayRegistry,
    );
    const q = new URLSearchParams({
      mondayDate: dates.firstPlayDate,
      tuesdayDate: dates.secondPlayDate,
    });
    let cancelled = false;
    setViewedWeekPreviewLoading(true);
    void (async () => {
      try {
        const res = await api<PreviewResult | { error: string }>(
          `/api/seasons/${seasonId}/booking/weeks/${weekNumber}/preview?${q.toString()}`,
        );
        if (!cancelled) {
          setViewedWeekPreview(res);
        }
      } catch (e) {
        if (!cancelled) {
          setViewedWeekPreview({ error: String(e) });
        }
      } finally {
        if (!cancelled) {
          setViewedWeekPreviewLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    seasonId,
    startMondayForSeason,
    seasonCalendarWeekIndex,
    holidayRegistry,
    seasonStartPlayers.length,
  ]);

  const refreshLocalSeasonHolds = useCallback(async () => {
    if (!seasonId || !startMondayForSeason) {
      setSeasonBlockBooked(false);
      setActiveSeasonHold(null);
      return;
    }
    try {
      const holds = await api<SeasonHoldListRow[]>(
        `/api/seasons/${seasonId}/booking/season-holds`,
      );
      const match = holds.find(
        (h) =>
          h.startMondayDate === startMondayForSeason &&
          (h.status === "active" || h.status === "fully_converted"),
      );
      setSeasonBlockBooked(!!match && match.status === "active");
      setActiveSeasonHold(
        match
          ? {
              id: match.id,
              seasonWeeks: match.seasonWeeks,
              status: match.status,
              convertedWeeks: (() => {
                try {
                  return JSON.parse(match.convertedWeeksJson ?? "[]") as number[];
                } catch {
                  return [];
                }
              })(),
              locallyConvertedSlotKeys: (() => {
                try {
                  const raw = JSON.parse(
                    match.locallyConvertedSlotsJson ?? "[]",
                  ) as unknown;
                  return new Set(
                    Array.isArray(raw)
                      ? raw.filter((k): k is string => typeof k === "string")
                      : [],
                  );
                } catch {
                  return new Set<string>();
                }
              })(),
            }
          : null,
      );
    } catch (err) {
      console.error(err);
    }
  }, [seasonId, startMondayForSeason]);

  const markSlotDisplayLocal = useCallback(
    async (
      slot: BulkSlotBookingRef,
      display: "bulk_held" | "converted",
    ) => {
      if (!seasonId || !startMondayForSeason) {
        window.alert("Set a season and start Monday first.");
        return;
      }
      const label =
        display === "converted"
          ? "converted (purple)"
          : "bulk-held (green)";
      if (
        !window.confirm(
          `Mark ${formatISODateLongEn(slot.date)} ${slot.begin}–${slot.end} as ${label} in this app only?\n\nClub Locker will not be changed.`,
        )
      ) {
        return;
      }
      try {
        const res = await api<
          { ok: true; message: string } | { ok: false; error: string }
        >(`/api/seasons/${seasonId}/booking/mark-slot-local`, {
          method: "POST",
          body: JSON.stringify({
            startMondayDate: startMondayForSeason,
            week: calendarWeekNumber,
            date: slot.date,
            begin: slot.begin,
            end: slot.end,
            display,
          }),
        });
        if (!res.ok) {
          window.alert(res.error);
          onLog(res.error);
          return;
        }
        onLog(res.message);
        await refreshLocalSeasonHolds();
        setSeasonBulkFeedback({ kind: "success", message: res.message });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        onLog(msg);
        window.alert(msg);
      }
    },
    [
      seasonId,
      startMondayForSeason,
      calendarWeekNumber,
      onLog,
      refreshLocalSeasonHolds,
    ],
  );

  const markVisibleWeekDisplayLocal = useCallback(
    async (display: "bulk_held" | "converted") => {
      if (!seasonId || !startMondayForSeason) {
        window.alert("Set a season and start Monday first.");
        return;
      }
      const label =
        display === "bulk_held"
          ? "bulk-held (green)"
          : "converted to individual matches (purple)";
      if (
        !window.confirm(
          `Mark season week ${calendarWeekNumber} as ${label} in this app only?\n\nClub Locker will not be changed.`,
        )
      ) {
        return;
      }
      try {
        const res = await api<
          { ok: true; message: string } | { ok: false; error: string }
        >(`/api/seasons/${seasonId}/booking/mark-week-local`, {
          method: "POST",
          body: JSON.stringify({
            startMondayDate: startMondayForSeason,
            week: calendarWeekNumber,
            display,
          }),
        });
        if (!res.ok) {
          window.alert(res.error);
          onLog(res.error);
          return;
        }
        onLog(res.message);
        await refreshLocalSeasonHolds();
        setSeasonBulkFeedback({ kind: "success", message: res.message });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        onLog(msg);
        window.alert(msg);
      }
    },
    [
      seasonId,
      startMondayForSeason,
      calendarWeekNumber,
      onLog,
      refreshLocalSeasonHolds,
    ],
  );

  const applyAllRosterCourtUpdates = useCallback(async () => {
    if (courtSlotsToApply.length === 0) return;
    setRosterImpactApplyBusy(true);
    setRosterImpactApplyProgress({
      current: 0,
      total: courtSlotsToApply.length,
      label: "Starting…",
    });
    let failed = 0;
    try {
      for (let i = 0; i < courtSlotsToApply.length; i++) {
        if (i > 0) await sleepMs(humanBookingPaceDelayMs());
        const row = courtSlotsToApply[i]!;
        setRosterImpactApplyProgress({
          current: i + 1,
          total: courtSlotsToApply.length,
          label: `Week ${row.weekNumber} · Box ${row.boxNumber} · ${row.playDate} ${row.slotLabel}`,
        });
        const out = await api<{ ok: boolean; message: string; skipped?: boolean }>(
          `/api/seasons/${seasonId}/house-league/roster-impact/apply-court-slot`,
          {
            method: "POST",
            body: JSON.stringify({
              weekNumber: row.weekNumber,
              playDate: row.playDate,
              slot: row.slot,
              courtId: row.courtId,
              boxNumber: row.boxNumber,
              confirm: true,
            }),
          },
        );
        if (!out.ok) {
          failed += 1;
          onLog(`Court update failed: ${out.message}`);
        }
      }
      await refreshRosterImpact();
      await refreshLocalSeasonHolds();
      const msg =
        failed === 0
          ? `Updated ${courtSlotsToApply.length} court booking${courtSlotsToApply.length === 1 ? "" : "s"} to match the live roster.`
          : `${failed} of ${courtSlotsToApply.length} updates failed — see log.`;
      onLog(msg);
      window.alert(msg);
      setRosterImpactApplyModalOpen(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog(msg);
      window.alert(msg);
    } finally {
      setRosterImpactApplyBusy(false);
      setRosterImpactApplyProgress(null);
    }
  }, [
    courtSlotsToApply,
    seasonId,
    onLog,
    refreshRosterImpact,
    refreshLocalSeasonHolds,
  ]);

  const fetchSeasonBlockPreview = useCallback(
    async (opts?: { logToPanel?: boolean }) => {
      if (!seasonId || !startMondayForSeason) {
        setSeasonPreview(null);
        setSeasonPreviewError(null);
        setSeasonPreviewLoading(false);
        return;
      }
      setSeasonPreviewLoading(true);
      setSeasonPreviewError(null);
      const q = new URLSearchParams({
        startMondayDate: startMondayForSeason,
        seasonWeeks: String(weeksToBook),
      });
      try {
        const res = await api<SeasonBulkPreviewResponse>(
          `/api/seasons/${seasonId}/booking/season-bulk/preview?${q.toString()}`,
        );
        setSeasonPreview(res);
        if (opts?.logToPanel) {
          onLog(JSON.stringify(res, null, 2));
        }
      } catch (e) {
        const msg = String(e);
        setSeasonPreview(null);
        setSeasonPreviewError(msg);
        onLog(msg);
      } finally {
        setSeasonPreviewLoading(false);
      }
      await refreshLocalSeasonHolds();
    },
    [
      seasonId,
      startMondayForSeason,
      weeksToBook,
      onLog,
      refreshLocalSeasonHolds,
    ],
  );

  useEffect(() => {
    fetchSeasonBlockPreview().catch(() => {});
  }, [fetchSeasonBlockPreview]);

  const toggleBulkRunDraftWeek = useCallback(
    (w: number) => {
      if (isBulkWeekStillHeld(w)) return;
      const min = minBulkRunDraftWeeks;
      setSeasonBulkRunDraftWeeks((draft) => {
        if (w < draft) return Math.max(w - 1, min);
        if (w === draft && draft > min) return w - 1;
        if (w > draft) return w;
        return draft;
      });
    },
    [isBulkWeekStillHeld, minBulkRunDraftWeeks],
  );

  const openConvertWeeksModal = useCallback(() => {
    if (!activeSeasonHold) return;
    const initial = new Set<number>();
    for (let w = 1; w <= activeSeasonHold.seasonWeeks; w++) {
      if (isWeekPendingLocalConvert(w)) initial.add(w);
    }
    setConvertWeeksModalSelected(initial);
    setConvertFeedback(null);
    setConvertWeeksModalOpen(true);
  }, [activeSeasonHold, isWeekPendingLocalConvert]);

  const toggleConvertWeeksModalWeek = useCallback(
    (w: number) => {
      if (!isWeekPendingLocalConvert(w)) return;
      setConvertWeeksModalSelected((prev) => {
        const next = new Set(prev);
        if (next.has(w)) next.delete(w);
        else next.add(w);
        return next;
      });
    },
    [isWeekPendingLocalConvert],
  );

  const runSeasonWeekConversions = useCallback(
    async (weeksToRun: number[]) => {
      if (!seasonId || !activeSeasonHoldId || !startMondayForSeason || !activeSeasonHold) {
        return { ok: false as const, message: "Missing season or active hold." };
      }
      const seasonWeeks = activeSeasonHold.seasonWeeks;
      const sorted = [...weeksToRun]
        .filter((w) => w >= 1 && w <= seasonWeeks && isBulkWeekStillHeld(w))
        .sort((a, b) => a - b);
      if (sorted.length === 0) {
        return {
          ok: false as const,
          message: "No selected weeks still have a bulk hold.",
        };
      }
      setConvertFeedback(null);
      setConvertWeekLoading(true);
      let stopMessage: string | null = null;
      try {
        for (const w of sorted) {
          const res = await api<ConvertResult>(
            `/api/seasons/${seasonId}/booking/convert`,
            {
              method: "POST",
              body: JSON.stringify({
                week: w,
                holdId: activeSeasonHoldId,
                confirm: true,
                notifyOnDelete: true,
              }),
            },
          );
          onLog(JSON.stringify(res, null, 2));
          if (res.status !== "ok" && res.status !== "partial") {
            stopMessage = res.message;
            break;
          }
        }
        await refreshLocalSeasonHolds();
        const viewedWeek = seasonCalendarWeekIndex + 1;
        if (sorted.includes(viewedWeek)) {
          const dates = seasonWeekPlayDatesWithRegistry(
            startMondayForSeason,
            viewedWeek,
            holidayRegistry,
          );
          const q = new URLSearchParams({
            mondayDate: dates.firstPlayDate,
            tuesdayDate: dates.secondPlayDate,
          });
          const prev = await api<PreviewResult | { error: string }>(
            `/api/seasons/${seasonId}/booking/weeks/${viewedWeek}/preview?${q.toString()}`,
          );
          setViewedWeekPreview(prev);
        }
        if (stopMessage) {
          setConvertFeedback({ kind: "error", message: stopMessage });
          return { ok: false as const, message: stopMessage };
        }
        const message =
          sorted.length === 1
            ? `Conversion complete for ${seasonBulkModalWeekLabel(sorted[0]!)}.`
            : `Successfully converted ${sorted.length} weeks to match bookings.`;
        setConvertFeedback({ kind: "ok", message });
        return { ok: true as const, message };
      } catch (e) {
        const msg = String(e);
        onLog(msg);
        setConvertFeedback({ kind: "error", message: msg });
        await refreshLocalSeasonHolds();
        return { ok: false as const, message: msg };
      } finally {
        setConvertWeekLoading(false);
      }
    },
    [
      seasonId,
      activeSeasonHoldId,
      startMondayForSeason,
      activeSeasonHold,
      isBulkWeekStillHeld,
      seasonCalendarWeekIndex,
      holidayRegistry,
      onLog,
      refreshLocalSeasonHolds,
    ],
  );

  const submitConvertWeeksModal = useCallback(async () => {
    if (!activeSeasonHold) return;
    const weeksToRun = [...convertWeeksModalSelected]
      .filter((w) => w >= 1 && w <= activeSeasonHold.seasonWeeks && isBulkWeekStillHeld(w))
      .sort((a, b) => a - b);
    if (weeksToRun.length === 0) {
      setConvertFeedback({
        kind: "error",
        message: "Select at least one week that still has a bulk hold.",
      });
      return;
    }
    const result = await runSeasonWeekConversions(weeksToRun);
    if (result.ok) {
      setConvertWeeksModalOpen(false);
    }
  }, [
    activeSeasonHold,
    convertWeeksModalSelected,
    isBulkWeekStillHeld,
    runSeasonWeekConversions,
  ]);

  const submitMarkWeeksLocalModal = useCallback(async () => {
    if (!seasonId || !startMondayForSeason || !activeSeasonHold) return;
    const weeksToRun = [...convertWeeksModalSelected]
      .filter(
        (w) =>
          w >= 1 &&
          w <= activeSeasonHold.seasonWeeks &&
          isWeekPendingLocalConvert(w),
      )
      .sort((a, b) => a - b);
    if (weeksToRun.length === 0) {
      setConvertFeedback({
        kind: "error",
        message: "Select at least one week that is not already marked converted.",
      });
      return;
    }
    if (
      !window.confirm(
        `Mark ${weeksToRun.length} week(s) as converted in this app only?\n\n` +
          "Club Locker will not be changed. Booked occurrences will be seeded from the live roster plan so weekly emails can run.",
      )
    ) {
      return;
    }
    setConvertFeedback(null);
    setConvertWeekLoading(true);
    try {
      const res = await api<
        | { ok: true; message: string }
        | { ok: false; error: string }
      >(`/api/seasons/${seasonId}/booking/mark-weeks-local`, {
        method: "POST",
        body: JSON.stringify({
          startMondayDate: startMondayForSeason,
          weeks: weeksToRun,
          display: "converted",
        }),
      });
      if (!res.ok) {
        setConvertFeedback({ kind: "error", message: res.error });
        onLog(res.error);
        return;
      }
      onLog(res.message);
      await refreshLocalSeasonHolds();
      setConvertFeedback({ kind: "ok", message: res.message });
      setConvertWeeksModalOpen(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog(msg);
      setConvertFeedback({ kind: "error", message: msg });
    } finally {
      setConvertWeekLoading(false);
    }
  }, [
    seasonId,
    startMondayForSeason,
    activeSeasonHold,
    convertWeeksModalSelected,
    isWeekPendingLocalConvert,
    onLog,
    refreshLocalSeasonHolds,
  ]);

  const registerSeasonHoldLocally = useCallback(async () => {
    if (!seasonId || !startMondayForSeason) {
      window.alert("Set a season and start Monday first.");
      return;
    }
    if (
      !window.confirm(
        "Register a season hold in this app only?\n\nClub Locker will not be changed. Use this when bulk booking and conversion were already done from local (or manually in Club Locker) but production's database was never updated.",
      )
    ) {
      return;
    }
    setSeasonBulkFeedback(null);
    setConvertWeekLoading(true);
    try {
      const res = await api<
        | { ok: true; message: string; holdId: string; alreadyRegistered?: boolean }
        | { ok: false; error: string }
      >(`/api/seasons/${seasonId}/booking/register-season-hold-local`, {
        method: "POST",
        body: JSON.stringify({
          startMondayDate: startMondayForSeason,
          seasonWeeks: weeksToBook,
        }),
      });
      if (!res.ok) {
        setSeasonBulkFeedback({ kind: "error", message: res.error });
        onLog(res.error);
        return;
      }
      onLog(res.message);
      await refreshLocalSeasonHolds();
      setSeasonBulkFeedback({
        kind: res.alreadyRegistered ? "idempotent" : "success",
        message: res.message,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog(msg);
      setSeasonBulkFeedback({ kind: "error", message: msg });
    } finally {
      setConvertWeekLoading(false);
    }
  }, [
    seasonId,
    startMondayForSeason,
    weeksToBook,
    onLog,
    refreshLocalSeasonHolds,
  ]);

  const convertVisibleWeekToMatches = useCallback(async () => {
    if (!activeSeasonHold || !activeSeasonHoldId) return;
    const week = calendarWeekNumber;
    if (week > activeSeasonHold.seasonWeeks) {
      setConvertFeedback({
        kind: "error",
        message: `${seasonBulkModalWeekLabel(week)} is outside this season hold (${activeSeasonHold.seasonWeeks} weeks).`,
      });
      return;
    }
    if (!isBulkWeekStillHeld(week)) {
      setConvertFeedback({
        kind: "error",
        message: bulkWeekConvertedToMatches
          ? `${seasonBulkModalWeekLabel(week)} was already converted to match bookings.`
          : `${seasonBulkModalWeekLabel(week)} has no bulk hold to convert.`,
      });
      return;
    }
    const weekLabel = seasonBulkModalWeekLabel(week);
    if (
      !window.confirm(
        `Convert ${weekLabel} (the week shown in the calendar)?\n\n` +
          "This deletes that week's bulk clinic holds in Club Locker and creates individual match reservations from the live US Squash box league roster (same matchups as the calendar with Player names checked).\n\n" +
          "Club Locker will email every player on those new match bookings, and will send cancellation emails for the bulk clinics.\n\n" +
          "Use this for a small test before converting all weeks at once.",
      )
    ) {
      return;
    }
    await runSeasonWeekConversions([week]);
  }, [
    activeSeasonHold,
    activeSeasonHoldId,
    calendarWeekNumber,
    bulkWeekConvertedToMatches,
    isBulkWeekStillHeld,
    runSeasonWeekConversions,
  ]);

  const rebookTuesdayForVisibleWeek = useCallback(async () => {
    if (!seasonId || !activeSeasonHoldId || !startMondayForSeason) return;
    if (!bulkWeekConvertedToMatches) {
      setConvertFeedback({
        kind: "error",
        message: "This week is not marked converted — use Convert visible week first.",
      });
      return;
    }
    const week = calendarWeekNumber;
    const playDates = seasonWeekPlayDatesWithRegistry(
      startMondayForSeason,
      week,
      holidayRegistry,
    );
    const tuesdayDate = playDates.secondPlayDate;
    const weekLabel = seasonBulkModalWeekLabel(week);
    if (
      !window.confirm(
        `Re-book all Tuesday match reservations for ${weekLabel} (${formatISODateLongEn(tuesdayDate)})?\n\n` +
          "Creates 16 individual match bookings (8 slots × Stadium + Center) from the live US Squash roster — same as the calendar with Player names checked.\n\n" +
          "Does not touch Monday bookings or bulk holds. Club Locker will email players on each new match booking.\n\n" +
          "Bookings are paced ~3–4 seconds apart.",
      )
    ) {
      return;
    }
    setConvertFeedback(null);
    setConvertWeekLoading(true);
    try {
      const res = await api<RebookPlayDayResult>(
        `/api/seasons/${seasonId}/booking/rebook-play-day`,
        {
          method: "POST",
          body: JSON.stringify({
            week,
            playDay: "tue",
            holdId: activeSeasonHoldId,
            startMondayDate: startMondayForSeason,
            confirm: true,
          }),
        },
      );
      onLog(JSON.stringify(res, null, 2));
      if (res.status === "ok" || res.status === "partial") {
        setConvertFeedback({
          kind: res.status === "ok" ? "ok" : "error",
          message: res.message,
        });
        const q = new URLSearchParams({
          mondayDate: playDates.firstPlayDate,
          tuesdayDate: playDates.secondPlayDate,
        });
        const prev = await api<PreviewResult | { error: string }>(
          `/api/seasons/${seasonId}/booking/weeks/${week}/preview?${q.toString()}`,
        );
        setViewedWeekPreview(prev);
      } else {
        setConvertFeedback({ kind: "error", message: res.message });
      }
    } catch (e) {
      const msg = String(e);
      onLog(msg);
      setConvertFeedback({ kind: "error", message: msg });
    } finally {
      setConvertWeekLoading(false);
    }
  }, [
    seasonId,
    activeSeasonHoldId,
    startMondayForSeason,
    bulkWeekConvertedToMatches,
    calendarWeekNumber,
    holidayRegistry,
    onLog,
  ]);

  const runSeasonBulkSubmit = useCallback(
    async (selectedSeasonWeeks: number) => {
      if (seasonBulkRunInFlightRef.current) return;
      seasonBulkRunInFlightRef.current = true;
      setSeasonBulkSubmitting(true);
      setSeasonBulkFeedback(null);
      setLastSeasonBulkApiResponse(null);
      setCopySeasonBulkResponseStatus(null);
      setWeeksToBook(selectedSeasonWeeks);
      try {
        const res = await api<SeasonBulkResult>(
          `/api/seasons/${seasonId}/booking/season-bulk`,
          {
            method: "POST",
            body: JSON.stringify({
              startMondayDate: startMondayForSeason,
              seasonWeeks: selectedSeasonWeeks,
              confirm: true,
            }),
          },
        );
        onLog(JSON.stringify(res, null, 2));
        setLastSeasonBulkApiResponse(res);
        const holdPersisted =
          Boolean(res.seasonHoldId) &&
          (res.idempotent || res.status === "ok" || res.status === "partial");
        if (holdPersisted && res.seasonHoldId) {
          setSeasonBlockBooked(true);
          setActiveSeasonHold({
            id: res.seasonHoldId,
            seasonWeeks: selectedSeasonWeeks,
            status: "active",
            convertedWeeks: [],
            locallyConvertedSlotKeys: new Set(),
          });
        }
        await refreshLocalSeasonHolds();
        if (res.idempotent) {
          setSeasonBulkFeedback({
            kind: "idempotent",
            message: res.message,
          });
          return;
        }
        if (!res.idempotent && res.status === "ok") {
          setSeasonBulkFeedback({
            kind: "success",
            message:
              "Season block run finished with status ok. Local reservation ids are stored for weekly conversion.",
          });
        } else if (res.status === "error" || res.status === "partial") {
          setSeasonBulkFeedback({
            kind: "error",
            message: res.message,
            slotConflict: Boolean(res.conflict),
          });
        }
      } catch (e) {
        const msg = String(e);
        onLog(msg);
        setLastSeasonBulkApiResponse({ error: msg });
        setCopySeasonBulkResponseStatus(null);
        setSeasonBulkFeedback({
          kind: "error",
          message: msg,
        });
      } finally {
        seasonBulkRunInFlightRef.current = false;
        setSeasonBulkSubmitting(false);
      }
    },
    [
      seasonId,
      startMondayForSeason,
      onLog,
      refreshLocalSeasonHolds,
    ],
  );

  const openCancelBookingsModal = useCallback(async () => {
    if (!seasonId || !startMondayForSeason) return;
    setCancelBookingsOpen(true);
    setCancelBookingsLoading(true);
    setCancelBookingsFetchError(null);
    setCancelBookingsFeedback(null);
    setCancelBookingsSelected(new Set());
    try {
      const q = new URLSearchParams({ startMondayDate: startMondayForSeason });
      const rows = await api<CancellableCalendarRow[]>(
        `/api/seasons/${seasonId}/booking/cancellable?${q.toString()}`,
      );
      setCancelBookingsRows(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setCancelBookingsFetchError(String(e));
      setCancelBookingsRows([]);
    } finally {
      setCancelBookingsLoading(false);
    }
  }, [seasonId, startMondayForSeason]);

  const submitCancelBookingsModal = useCallback(async () => {
    if (!seasonId || !startMondayForSeason) return;
    if (cancelBookingsSubmitInFlightRef.current) return;
    const picked = cancelBookingsRows.filter((r) => cancelBookingsSelected.has(r.rowId));
    const blocked = picked.filter((r) => !r.complete);
    if (blocked.length > 0) {
      setCancelBookingsFeedback(
        "Uncheck incomplete rows (missing reservation ids) or fix data in Club Locker.",
      );
      return;
    }
    if (picked.length === 0) {
      setCancelBookingsFeedback("Select at least one booking to cancel.");
      return;
    }
    if (
      !window.confirm(
        `Cancel ${picked.length} booking group(s) in Club Locker? Members may be notified depending on Club Locker settings.`,
      )
    ) {
      return;
    }
    cancelBookingsSubmitInFlightRef.current = true;
    setCancelBookingsSubmitting(true);
    setCancelBookingsFeedback(null);
    try {
      const res = await api<
        | { ok: true; message: string; deleted: { id: string; ok: boolean }[] }
        | { ok: false; error: string }
      >(`/api/seasons/${seasonId}/booking/cancel-calendar`, {
        method: "POST",
        body: JSON.stringify({
          startMondayDate: startMondayForSeason,
          notifyUsers: true,
          items: picked.map((r) => ({
            kind: r.kind,
            week: r.week,
            date: r.date,
            begin: r.begin,
            end: r.end,
          })),
        }),
      });
      if (!res.ok) {
        setCancelBookingsFeedback(res.error);
        return;
      }
      onLog(res.message);
      setCancelBookingsFeedback(res.message);
      void refreshLocalSeasonHolds();
      void openCancelBookingsModal();
    } catch (e) {
      setCancelBookingsFeedback(String(e));
    } finally {
      cancelBookingsSubmitInFlightRef.current = false;
      setCancelBookingsSubmitting(false);
    }
  }, [
    seasonId,
    startMondayForSeason,
    cancelBookingsRows,
    cancelBookingsSelected,
    onLog,
    refreshLocalSeasonHolds,
    openCancelBookingsModal,
  ]);

  const runSingleCalendarCancel = useCallback(
    async (spec: {
      kind: "bulk" | "match";
      date: string;
      begin: string;
      end: string;
    }) => {
      if (!seasonId || !startMondayForSeason) return;
      try {
        const res = await api<
          | { ok: true; message: string }
          | { ok: false; error: string }
        >(`/api/seasons/${seasonId}/booking/cancel-calendar`, {
          method: "POST",
          body: JSON.stringify({
            startMondayDate: startMondayForSeason,
            notifyUsers: true,
            items: [
              {
                kind: spec.kind,
                week: calendarWeekNumber,
                date: spec.date,
                begin: spec.begin,
                end: spec.end,
              },
            ],
          }),
        });
        if (!res.ok) {
          onLog(`Cancel failed: ${res.error}`);
          window.alert(res.error);
          return;
        }
        onLog(res.message);
        void refreshLocalSeasonHolds();
      } catch (e) {
        const msg = String(e);
        onLog(msg);
        window.alert(msg);
      }
    },
    [seasonId, startMondayForSeason, calendarWeekNumber, onLog, refreshLocalSeasonHolds],
  );

  const runStadiumIdMapTest = useCallback(
    async (spec: { date: string; begin: string; end: string }) => {
      if (!seasonId || !startMondayForSeason) return;
      const playDates = seasonWeekPlayDatesWithRegistry(
        startMondayForSeason,
        calendarWeekNumber,
        holidayRegistry,
      );
      const slotKey = `${spec.date}|${spec.begin}-${spec.end}`;
      const stadiumLabel = slotPlayerLabelsForCalendar?.get(slotKey)?.stadium;
      const testTimeLabel = `${formatHHMMAs12Hour("15:10")}–${formatHHMMAs12Hour("15:50")}`;
      const confirmLines = [
        `Book Stadium players at ${testTimeLabel} on ${formatISODateLongEn(spec.date)}?`,
        stadiumLabel
          ? `Players (from this slot): ${stadiumLabel.replace(/\s+v\s+/i, " vs ")}`
          : "Players will be resolved from the live US Squash roster (same as Convert Visible Week).",
        "",
        "This creates one real Club Locker match on Stadium court. Members may receive booking emails.",
      ];
      if (
        !window.confirm(
          confirmLines.join("\n"),
        )
      ) {
        return;
      }
      setStadiumIdMapTestLoading(true);
      try {
        const resp = await fetch(
          `/api/seasons/${seasonId}/booking/test-stadium-id-map`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              week: calendarWeekNumber,
              mondayDate: playDates.firstPlayDate,
              tuesdayDate: playDates.secondPlayDate,
              date: spec.date,
              sourceBegin: spec.begin,
              sourceEnd: spec.end,
            }),
          },
        );
        const rawText = await resp.text();
        let res: {
          ok?: boolean;
          message?: string;
          sourceMatch?: {
            boxNumber: number;
            player1SsmId: number;
            player2SsmId: number;
            player1Name: string;
            player2Name: string;
          };
        };
        try {
          res = JSON.parse(rawText) as typeof res;
        } catch {
          window.alert(`Stadium ID-map test failed (${resp.status}): Non-JSON response.`);
          onLog(rawText);
          return;
        }
        onLog(rawText);
        const detail = res.sourceMatch
          ? ` Box ${res.sourceMatch.boxNumber}: ${res.sourceMatch.player1Name} (id ${res.sourceMatch.player1SsmId}) vs ${res.sourceMatch.player2Name} (id ${res.sourceMatch.player2SsmId}).`
          : "";
        const msg = `${res.message ?? "Request failed."}${detail}`;
        if (res.ok && resp.status < 400) {
          window.alert(`Stadium ID-map test booked.\n\n${msg}`);
        } else {
          window.alert(`Stadium ID-map test failed (${resp.status}).\n\n${msg}`);
        }
      } catch (e) {
        const msg = String(e);
        onLog(msg);
        window.alert(msg);
      } finally {
        setStadiumIdMapTestLoading(false);
      }
    },
    [
      seasonId,
      startMondayForSeason,
      calendarWeekNumber,
      holidayRegistry,
      slotPlayerLabelsForCalendar,
      onLog,
    ],
  );

  const runBookSlotBothCourtsNoBulkCancel = useCallback(
    async (spec: { date: string; begin: string; end: string }) => {
      if (!seasonId || !startMondayForSeason) return;
      const playDates = seasonWeekPlayDatesWithRegistry(
        startMondayForSeason,
        calendarWeekNumber,
        holidayRegistry,
      );
      const slotKey = `${spec.date}|${spec.begin}-${spec.end}`;
      const labels = slotPlayerLabelsForCalendar?.get(slotKey);
      const formatCourtLine = (
        court: "Stadium" | "Center",
        label: string | undefined,
      ): string => {
        if (!label || isVacantCourtChipLabel(label)) {
          return `${court}: (no match from roster)`;
        }
        return `${court}: ${label.replace(/\s+v\s+/i, " vs ")}`;
      };
      const timeLabel = `${formatHHMMAs12Hour(spec.begin)}–${formatHHMMAs12Hour(spec.end)}`;
      const confirmLines = [
        `Confirm booking for ${formatISODateLongEn(spec.date)} · ${timeLabel}`,
        "",
        formatCourtLine("Stadium", labels?.stadium),
        formatCourtLine("Center", labels?.center),
        "",
        "Creates real Club Locker match reservations on both courts when the roster has players for each. The green bulk hold is not cancelled. Members may receive booking emails.",
      ];
      if (!window.confirm(confirmLines.join("\n"))) {
        return;
      }
      setBookSlotBothCourtsLoading(true);
      try {
        const resp = await fetch(
          `/api/seasons/${seasonId}/booking/book-slot-both-courts`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              week: calendarWeekNumber,
              mondayDate: playDates.firstPlayDate,
              tuesdayDate: playDates.secondPlayDate,
              date: spec.date,
              begin: spec.begin,
              end: spec.end,
            }),
          },
        );
        const rawText = await resp.text();
        let res: { ok?: boolean; message?: string; courts?: unknown[] };
        try {
          res = JSON.parse(rawText) as typeof res;
        } catch {
          window.alert(`Booking failed (${resp.status}): Non-JSON response.`);
          onLog(rawText);
          return;
        }
        onLog(rawText);
        const msg = res.message ?? "Request failed.";
        if (res.ok && resp.status < 400) {
          window.alert(`Booked.\n\n${msg}`);
        } else {
          window.alert(`Booking failed (${resp.status}).\n\n${msg}`);
        }
      } catch (e) {
        const msg = String(e);
        onLog(msg);
        window.alert(msg);
      } finally {
        setBookSlotBothCourtsLoading(false);
      }
    },
    [
      seasonId,
      startMondayForSeason,
      calendarWeekNumber,
      holidayRegistry,
      slotPlayerLabelsForCalendar,
      onLog,
    ],
  );

  const cancelBookingsSelectableIds = useMemo(
    () => cancelBookingsRows.filter((r) => r.complete).map((r) => r.rowId),
    [cancelBookingsRows],
  );

  const cancelBookingsAllSelectableSelected = useMemo(() => {
    if (cancelBookingsSelectableIds.length === 0) return false;
    return cancelBookingsSelectableIds.every((id) => cancelBookingsSelected.has(id));
  }, [cancelBookingsSelectableIds, cancelBookingsSelected]);

  const cancelBookingsSelectablePartial = useMemo(() => {
    if (cancelBookingsSelectableIds.length === 0) return false;
    const n = cancelBookingsSelectableIds.filter((id) =>
      cancelBookingsSelected.has(id),
    ).length;
    return n > 0 && n < cancelBookingsSelectableIds.length;
  }, [cancelBookingsSelectableIds, cancelBookingsSelected]);

  useEffect(() => {
    const el = cancelBookingsSelectAllRef.current;
    if (!el) return;
    el.indeterminate = cancelBookingsSelectablePartial;
  }, [cancelBookingsSelectablePartial, cancelBookingsOpen, cancelBookingsRows]);

  useEffect(() => {
    refreshLocalSeasonHolds().catch(() => {});
  }, [refreshLocalSeasonHolds]);

  useEffect(() => {
    if (!seasonPreview) return;
    setSeasonCalendarWeekIndex((i) =>
      Math.max(0, Math.min(i, SEASON_BLOCK_CALENDAR_STEPS - 1)),
    );
  }, [seasonPreview]);

  return (
    <div className="booking-page">
      <div className="card booking-tabs-wrap">
        <section
          style={{
            borderLeft: "4px solid #0f172a",
            paddingLeft: "0.75rem",
            margin: 0,
          }}
          aria-label="Court booking: season block and weekly conversion"
        >
            <div
              className="row"
              style={{
                flexWrap: "wrap",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "0.5rem 1rem",
                width: "100%",
              }}
            >
              <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
                <label>
                  First Monday of season{" "}
                  <input
                    value={startMondayForSeason}
                    onChange={(e) => setStartMondayForSeason(e.target.value)}
                    size={12}
                  />
                </label>
              </div>
              <div className="row" style={{ flexShrink: 0 }}>
                <button
                  type="button"
                  className="secondary"
                  disabled={!seasonId || seasonPreviewLoading}
                  onClick={() => {
                    fetchSeasonBlockPreview({ logToPanel: true }).catch(() => {});
                  }}
                >
                  {seasonPreviewLoading ? "Loading preview…" : "Refresh preview"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!seasonId || !startMondayForSeason}
                  onClick={() => {
                    openCancelBookingsModal().catch(() => {});
                  }}
                >
                  Cancel bookings…
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!seasonPreview}
                  onClick={() => {
                    if (seasonPreview) {
                      onLog(JSON.stringify(seasonPreview, null, 2));
                    }
                  }}
                >
                  Copy full JSON to log
                </button>
                <label
                  className="booking-matchup-names-toggle"
                  title={
                    boxLeaguePlayers?.length
                      ? seasonStartPlayers.length > 0
                        ? "Matchup names use season-start seat mapping (live Club Locker roster for player ids)"
                        : "Matchup names from live Club Locker box order — save Season start roster for seat mapping"
                      : "Load a box league roster on the Boxes tab first"
                  }
                >
                  <input
                    type="checkbox"
                    checked={showMatchupPlayerNames}
                    disabled={!boxLeaguePlayers?.length}
                    onChange={(e) => setShowMatchupPlayerNames(e.target.checked)}
                  />
                  Player names
                </label>
              </div>
            </div>
            {seasonPreviewError ? (
              <p className="weekly-empty" style={{ marginTop: "0.75rem" }}>
                Preview failed: {seasonPreviewError}
              </p>
            ) : null}
            {rosterImpactLoading ? (
              <p className="weekly-meta" style={{ marginTop: "0.5rem" }}>
                Checking converted match bookings against live roster…
              </p>
            ) : null}
            {!rosterImpactLoading &&
            courtSlotsToApply.length > 0 &&
            (activeSeasonHold?.convertedWeeks?.length ?? 0) > 0 ? (
              <div
                className="houseleague-banner roster-impact-banner booking-roster-impact-banner"
                role="status"
                style={{ marginTop: "0.75rem" }}
              >
                <strong>
                  {courtSlotsToApply.length} managed court booking
                  {courtSlotsToApply.length === 1 ? "" : "s"}
                </strong>{" "}
                (boxes 1–16) differ from the live US Squash roster across converted
                weeks.
                {bulkWeekConvertedToMatches && visibleWeekCourtSlotsNeedingUpdate > 0 ? (
                  <>
                    {" "}
                    This week:{" "}
                    <strong>{visibleWeekCourtSlotsNeedingUpdate}</strong> highlighted on
                    the calendar.
                  </>
                ) : null}
              </div>
            ) : null}
            {seasonPreview ? (
              <div
                className="card"
                style={{
                  marginTop: "0.75rem",
                  background: "var(--surface-2, #f8fafc)",
                  border: "1px solid var(--border, #e2e8f0)",
                }}
              >
                <SeasonBlockWeekCalendar
                  preview={seasonPreview}
                  weekIndex={seasonCalendarWeekIndex}
                  onWeekIndexChange={setSeasonCalendarWeekIndex}
                  booked={seasonBlockBooked}
                  bulkWeekConvertedToMatches={bulkWeekConvertedToMatches}
                  locallyConvertedSlotKeys={
                    activeSeasonHold?.locallyConvertedSlotKeys
                  }
                  slotPlayerLabels={slotPlayerLabelsForCalendar}
                  showMatchupPlayerNames={showMatchupPlayerNames}
                  boxLeaguePlayers={boxLeaguePlayers}
                  seasonStartPlayers={
                    seasonStartPlayers.length > 0 ? seasonStartPlayers : undefined
                  }
                  onBulkSlotContextMenu={openBulkSlotContextMenu}
                  onReservedSlotContextMenu={openReservedSlotContextMenu}
                  statHolidayRegistry={holidayRegistry}
                  rosterImpactHighlight={rosterImpactHighlight}
                />
                <p className="weekly-meta" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
                  Tip: <strong>Right-click</strong> empty areas or blue preview blocks to{" "}
                  <strong>book</strong> a single-court match in Club Locker, or{" "}
                  <strong>mark the visible week</strong> as bulk-held or converted{" "}
                  <strong>locally only</strong> (aligns calendar with Club Locker without API calls).{" "}
                  <strong>Right-click green</strong>: <strong>Show this slot as converted</strong> for
                  one time row (purple, local only), or <strong>Show whole week…</strong> for every
                  slot that week.                   <strong>Book match in Club Locker… (no bulk cancel)</strong> confirms both
                  courts from the live roster. <strong>…(cancel bulk hold first)</strong> books one
                  court after clearing bulk.{" "}
                  <strong>Test: book Stadium players at 3:10 PM…</strong> uses live-roster IDs.{" "}
                  <strong>Right-click green</strong> or <strong>violet</strong> blocks to{" "}
                  <strong>cancel</strong> that time row (both courts). Use{" "}
                  <strong>Cancel bookings…</strong> for multi-select.
                </p>
              </div>
            ) : !seasonPreviewLoading && seasonId ? (
              <p className="weekly-meta" style={{ marginTop: "0.75rem" }}>
                Set a season start Monday to load the preview.
              </p>
            ) : null}
            {viewedWeekPreview && "error" in viewedWeekPreview ? (
              <p className="weekly-empty" style={{ marginTop: "0.5rem" }}>
                Week plan preview: {viewedWeekPreview.error}
              </p>
            ) : null}
            {viewedWeekPreviewLoading ? (
              <p className="weekly-meta" style={{ marginTop: "0.35rem" }}>
                Loading week plan for calendar labels…
              </p>
            ) : null}
            {seasonBulkFeedback ? (
              <div
                className={
                  seasonBulkFeedback.kind === "idempotent" || seasonBulkFeedback.kind === "error"
                    ? "booking-bulk-notice booking-bulk-notice--warn"
                    : "booking-bulk-notice booking-bulk-notice--ok"
                }
                style={{ marginTop: "0.75rem" }}
                role="status"
              >
                {seasonBulkFeedback.kind === "idempotent" ? (
                  <strong>Already registered locally: </strong>
                ) : seasonBulkFeedback.kind === "error" ? (
                  <strong>
                    {seasonBulkFeedback.slotConflict
                      ? "Club Locker slot conflict — "
                      : "Error: "}
                  </strong>
                ) : null}
                {seasonBulkFeedback.message}
              </div>
            ) : null}
            <div className="row" style={{ marginTop: "0.5rem" }}>
              <button
                type="button"
                className={seasonBlockBooked ? "secondary" : "primary"}
                disabled={!seasonId || !startMondayForSeason || seasonBulkSubmitting}
                title={
                  seasonBlockBooked
                    ? "Bulk holds are active for this start Monday. Open to add more weeks or re-run after a partial failure."
                    : "Create bulk clinic holds in Club Locker for the selected weeks."
                }
                onClick={() => {
                  setSeasonBulkRunDraftWeeks(
                    Math.max(weeksToBook, minBulkRunDraftWeeks),
                  );
                  setSeasonBulkRunModalOpen(true);
                }}
              >
                {seasonBlockBooked ? "Extend season block…" : "Run season block (bulk)"}
              </button>
              {hasActiveSeasonHoldForConvert && activeSeasonHoldId ? (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      !seasonId ||
                      convertWeekLoading ||
                      !activeSeasonHoldId ||
                      !visibleWeekCanConvert
                    }
                    title={
                      bulkWeekConvertedToMatches
                        ? "This calendar week was already converted to match bookings."
                        : !visibleWeekCanConvert
                          ? "Navigate to a week that still has a bulk hold, or extend the season block first."
                          : "Delete this week's bulk clinics and create individual match bookings from the week plan (sends Club Locker emails for this week only)."
                    }
                    onClick={() => {
                      void convertVisibleWeekToMatches();
                    }}
                  >
                    {convertWeekLoading
                      ? "Converting week…"
                      : `Convert visible week (${seasonBulkModalWeekLabel(calendarWeekNumber)})`}
                  </button>
                  {bulkWeekConvertedToMatches ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={
                        !seasonId ||
                        convertWeekLoading ||
                        !activeSeasonHoldId ||
                        calendarWeekNumber > REGULAR_SEASON_WEEKS_IN_CALENDAR
                      }
                      title="Create Tuesday match bookings only for this converted week (skips bulk delete and Monday)."
                      onClick={() => {
                        void rebookTuesdayForVisibleWeek();
                      }}
                    >
                      {convertWeekLoading
                        ? "Re-booking Tuesday…"
                        : `Re-book Tuesday (${seasonBulkModalWeekLabel(calendarWeekNumber)})`}
                    </button>
                  ) : null}
                </>
              ) : null}
              {hasSeasonHoldRegistered && activeSeasonHoldId ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={!seasonId || convertWeekLoading || !activeSeasonHoldId}
                  title="Sync converted weeks in this app's database only — no Club Locker booking changes."
                  onClick={openConvertWeeksModal}
                >
                  {convertWeekLoading ? "Working…" : "Mark weeks converted locally…"}
                </button>
              ) : seasonId && startMondayForSeason ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={!seasonId || convertWeekLoading || !startMondayForSeason}
                  title="Create the local season hold record without calling Club Locker. Required before you can mark weeks converted locally on this server."
                  onClick={() => {
                    void registerSeasonHoldLocally();
                  }}
                >
                  {convertWeekLoading
                    ? "Registering…"
                    : "Register season hold locally…"}
                </button>
              ) : null}
              {!hasSeasonHoldRegistered && seasonId && startMondayForSeason ? (
                <p className="weekly-meta" style={{ margin: "0.35rem 0 0", width: "100%" }}>
                  No season hold in this server&apos;s database for this start Monday — likely
                  because bulk booking was run from local only. Register locally first, then mark
                  weeks converted (Club Locker unchanged).
                </p>
              ) : null}
              <button
                type="button"
                className="secondary"
                disabled={!seasonId}
                onClick={async () => {
                  const list = await api<unknown[]>(
                    `/api/seasons/${seasonId}/booking/season-holds`,
                  );
                  onLog(JSON.stringify(list, null, 2));
                }}
              >
                List season holds
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!seasonId || !activeSeasonHoldId}
                title={
                  !activeSeasonHoldId
                    ? "No active local hold for this season start Monday"
                    : "Deletes only the row in the service database"
                }
                onClick={async () => {
                  if (!activeSeasonHoldId) return;
                  if (
                    !window.confirm(
                      "Remove the local season hold for this start Monday? This does not delete anything in Club Locker. Use it after you have already removed the clinics there, so a new bulk run is allowed.",
                    )
                  ) {
                    return;
                  }
                  setSeasonBulkFeedback(null);
                  try {
                    const r = await api<{ ok: true } | { ok: false; error: string }>(
                      `/api/seasons/${seasonId}/booking/season-holds/${activeSeasonHoldId}`,
                      { method: "DELETE" },
                    );
                    onLog(JSON.stringify(r, null, 2));
                    if (r.ok === false) {
                      setSeasonBulkFeedback({
                        kind: "error",
                        message: r.error,
                      });
                      return;
                    }
                    setSeasonBulkFeedback({
                      kind: "cleared",
                      message:
                        "Local season hold record removed. You can run a new season block.",
                    });
                    void refreshLocalSeasonHolds();
                  } catch (e) {
                    const msg = String(e);
                    onLog(msg);
                    setSeasonBulkFeedback({ kind: "error", message: msg });
                  }
                }}
              >
                Remove local season hold
              </button>
            </div>
            {convertFeedback ? (
              <div
                className={
                  convertFeedback.kind === "error"
                    ? "booking-bulk-notice booking-bulk-notice--warn"
                    : "booking-bulk-notice booking-bulk-notice--ok"
                }
                style={{ marginTop: "0.5rem" }}
                role="status"
              >
                {convertFeedback.kind === "error" ? <strong>Error: </strong> : null}
                {convertFeedback.message}
              </div>
            ) : null}
            {lastSeasonBulkApiResponse ? (
              <div
                className="card"
                style={{
                  marginTop: "0.75rem",
                  background: "var(--surface-2, #f8fafc)",
                  border: "1px solid var(--border, #e2e8f0)",
                }}
              >
                <h3 style={{ marginTop: 0, fontSize: "1rem" }}>
                  Last season block API response
                </h3>
                {seasonBulkIssueLines.length > 0 ? (
                  <div
                    className="booking-bulk-notice booking-bulk-notice--warn"
                    style={{ marginTop: 0, marginBottom: "0.75rem" }}
                  >
                    <strong>
                      {seasonBulkIssueLines.length} conflict
                      {seasonBulkIssueLines.length === 1 ? "" : "s"} found
                    </strong>
                    <div className="season-bulk-conflict-cards" role="list" aria-label="Conflicts">
                      {seasonBulkIssueLines.map((line, idx) => {
                        const parts = formatSeasonConflictForCard(line);
                        const { beforeCourt, courtName } = parseCourtFromConflictContext(
                          parts.context,
                        );
                        return (
                          <article
                            key={`${line}-${idx}`}
                            className="season-bulk-conflict-card"
                            role="listitem"
                          >
                            <p className="season-bulk-conflict-context">
                              <span>{beforeCourt}</span>
                              {courtName ? (
                                <>
                                  {" "}
                                  <span
                                    className="season-bulk-court-badge"
                                    title={`Court: ${courtName}`}
                                  >
                                    <span className="season-bulk-court-badge-name">{courtName}</span>
                                    <span className="season-bulk-court-badge-ct" aria-hidden="true">
                                      ct
                                    </span>
                                  </span>
                                </>
                              ) : null}
                            </p>
                            <p className="season-bulk-conflict-detail">{parts.detail}</p>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                <div className="row" style={{ marginBottom: "0.5rem" }}>
                  <button
                    type="button"
                    className="secondary"
                    onClick={async () => {
                      const text = JSON.stringify(lastSeasonBulkApiResponse, null, 2);
                      try {
                        await navigator.clipboard.writeText(text);
                        setCopySeasonBulkResponseStatus("Copied response JSON.");
                      } catch {
                        setCopySeasonBulkResponseStatus(
                          "Clipboard copy failed. Use the JSON block below.",
                        );
                      }
                    }}
                  >
                    Copy full JSON response
                  </button>
                  {copySeasonBulkResponseStatus ? (
                    <span className="weekly-meta">{copySeasonBulkResponseStatus}</span>
                  ) : null}
                </div>
                <pre style={{ marginBottom: 0 }}>
                  {JSON.stringify(lastSeasonBulkApiResponse, null, 2)}
                </pre>
              </div>
            ) : null}
          </section>
      </div>

      {slotContextMenu ? (
        <div
          ref={slotContextMenuRef}
          className="booking-slot-context-menu"
          style={{ left: slotContextMenu.x, top: slotContextMenu.y }}
          role="menu"
        >
          {slotContextMenu.mode === "book" ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setSingleBookCourt("stadium");
                setSingleBookP1(null);
                setSingleBookP2(null);
                setSingleBookFeedback(null);
                setSingleBookReplacesBulkHold(false);
                setSingleBookDraft({
                  date: slotContextMenu.date,
                  begin: slotContextMenu.begin,
                  end: slotContextMenu.end,
                });
                setSlotContextMenu(null);
              }}
            >
              Book…
            </button>
          ) : null}
          {slotContextMenu.mode === "book" ? (
            <button
              type="button"
              role="menuitem"
              disabled={!seasonId || !startMondayForSeason}
              onClick={() => {
                setSlotContextMenu(null);
                void markVisibleWeekDisplayLocal("bulk_held");
              }}
            >
              Show week as bulk-held (green, local only)
            </button>
          ) : null}
          {slotContextMenu.mode === "book" ? (
            <button
              type="button"
              role="menuitem"
              disabled={!seasonId || !startMondayForSeason}
              onClick={() => {
                const s = slotContextMenu;
                setSlotContextMenu(null);
                void markSlotDisplayLocal(
                  { date: s.date, begin: s.begin, end: s.end },
                  "converted",
                );
              }}
            >
              Show this slot as converted (purple, local only)
            </button>
          ) : null}
          {slotContextMenu.mode === "book" ? (
            <button
              type="button"
              role="menuitem"
              disabled={!seasonId || !startMondayForSeason}
              onClick={() => {
                setSlotContextMenu(null);
                void markVisibleWeekDisplayLocal("converted");
              }}
            >
              Show whole week as converted (purple, local only)
            </button>
          ) : null}
          {slotContextMenu.mode === "bulk" ? (
            <button
              type="button"
              role="menuitem"
              disabled={!seasonId || !startMondayForSeason}
              onClick={() => {
                const s = slotContextMenu;
                setSlotContextMenu(null);
                void markSlotDisplayLocal(
                  { date: s.date, begin: s.begin, end: s.end },
                  "converted",
                );
              }}
            >
              Show this slot as converted (purple, local only)
            </button>
          ) : null}
          {slotContextMenu.mode === "bulk" ? (
            <button
              type="button"
              role="menuitem"
              disabled={!seasonId || !startMondayForSeason}
              onClick={() => {
                setSlotContextMenu(null);
                void markVisibleWeekDisplayLocal("converted");
              }}
            >
              Show whole week as converted (purple, local only)
            </button>
          ) : null}
          {slotContextMenu.mode === "bulk" ? (
            <button
              type="button"
              role="menuitem"
              disabled={!seasonId || !startMondayForSeason}
              onClick={() => {
                setSlotContextMenu(null);
                void markVisibleWeekDisplayLocal("bulk_held");
              }}
            >
              Show whole week as bulk-held (green, local only)
            </button>
          ) : null}
          {slotContextMenu.mode === "bulk" ? (
            <button
              type="button"
              role="menuitem"
              disabled={
                bookSlotBothCourtsLoading || !seasonId || !startMondayForSeason
              }
              onClick={() => {
                const s = slotContextMenu;
                setSlotContextMenu(null);
                void runBookSlotBothCourtsNoBulkCancel({
                  date: s.date,
                  begin: s.begin,
                  end: s.end,
                });
              }}
            >
              {bookSlotBothCourtsLoading
                ? "Booking both courts…"
                : "Book match in Club Locker… (no bulk cancel)"}
            </button>
          ) : null}
          {slotContextMenu.mode === "bulk" ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setSingleBookCourt("stadium");
                setSingleBookP1(null);
                setSingleBookP2(null);
                setSingleBookFeedback(null);
                setSingleBookReplacesBulkHold(true);
                setSingleBookDraft({
                  date: slotContextMenu.date,
                  begin: slotContextMenu.begin,
                  end: slotContextMenu.end,
                });
                setSlotContextMenu(null);
              }}
            >
              Book match in Club Locker… (cancel bulk hold first)
            </button>
          ) : null}
          {slotContextMenu.mode === "bulk" ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const s = slotContextMenu;
                setSlotContextMenu(null);
                if (
                  !window.confirm(
                    `Cancel the full bulk hold for ${formatISODateLongEn(s.date)} (all time slots that day, both courts) for season week ${calendarWeekNumber}?`,
                  )
                ) {
                  return;
                }
                void runSingleCalendarCancel({
                  kind: "bulk",
                  date: s.date,
                  begin: s.begin,
                  end: s.end,
                });
              }}
            >
              Cancel bulk slot (both courts)…
            </button>
          ) : null}
          {slotContextMenu.mode === "bulk" ? (
            <button
              type="button"
              role="menuitem"
              disabled={stadiumIdMapTestLoading || !seasonId || !startMondayForSeason}
              onClick={() => {
                const s = slotContextMenu;
                setSlotContextMenu(null);
                void runStadiumIdMapTest({
                  date: s.date,
                  begin: s.begin,
                  end: s.end,
                });
              }}
            >
              {stadiumIdMapTestLoading
                ? "Booking Stadium test at 3:10 PM…"
                : "Test: book Stadium players at 3:10 PM…"}
            </button>
          ) : null}
          {slotContextMenu.mode === "match" ? (
            <button
              type="button"
              role="menuitem"
              disabled={!seasonId || !startMondayForSeason}
              onClick={() => {
                const s = slotContextMenu;
                setSlotContextMenu(null);
                void markSlotDisplayLocal(
                  { date: s.date, begin: s.begin, end: s.end },
                  "bulk_held",
                );
              }}
            >
              Show this slot as bulk-held (green, local only)
            </button>
          ) : null}
          {slotContextMenu.mode === "match" ? (
            <button
              type="button"
              role="menuitem"
              disabled={!seasonId || !startMondayForSeason}
              onClick={() => {
                setSlotContextMenu(null);
                void markVisibleWeekDisplayLocal("bulk_held");
              }}
            >
              Show whole week as bulk-held (green, local only)
            </button>
          ) : null}
          {slotContextMenu.mode === "match" &&
          bulkWeekConvertedToMatches ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const s = slotContextMenu;
                setSlotContextMenu(null);
                if (
                  !window.confirm(
                    `Cancel converted match reservations for ${formatISODateLongEn(s.date)} ${s.begin}–${s.end} (both courts)?`,
                  )
                ) {
                  return;
                }
                void runSingleCalendarCancel({
                  kind: "match",
                  date: s.date,
                  begin: s.begin,
                  end: s.end,
                });
              }}
            >
              Cancel match bookings in Club Locker (both courts)…
            </button>
          ) : null}
        </div>
      ) : null}

      {seasonBulkRunModalOpen ? (
        <div
          className="booking-single-match-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget && !seasonBulkSubmitting) {
              setSeasonBulkRunModalOpen(false);
            }
          }}
        >
          <div
            className="booking-single-match-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="booking-season-bulk-run-title"
            style={{ maxWidth: "28rem" }}
          >
            <h3 id="booking-season-bulk-run-title" style={{ marginTop: 0 }}>
              {seasonBlockBooked ? "Extend season block" : "Run season block (bulk)"}
            </h3>
            <p className="weekly-meta" style={{ marginTop: 0 }}>
              {seasonBlockBooked
                ? "Bulk holds are already active for this start Monday. Add more weeks or re-run after a partial failure."
                : "This creates one clinic per court for each play day in the weeks you include."}{" "}
              Selection is consecutive from week 1 through the last week you check. Weeks that still
              have an active bulk hold are selected and cannot be changed.
            </p>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: "0.5rem 0",
                border: "1px solid var(--border, #e2e8f0)",
                borderRadius: 8,
              }}
            >
              {Array.from(
                { length: SEASON_BLOCK_CALENDAR_STEPS },
                (_, i) => i + 1,
              ).map((w) => {
                const held = isBulkWeekStillHeld(w);
                const checked = held || w <= seasonBulkRunDraftWeeks;
                return (
                  <li
                    key={w}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.45rem",
                      padding: "0.2rem 0.5rem",
                      borderBottom: "1px solid var(--border, #e2e8f0)",
                      background: held ? "rgba(148,163,184,0.1)" : undefined,
                    }}
                  >
                    <input
                      id={`bulk-run-week-${w}`}
                      type="checkbox"
                      checked={checked}
                      disabled={held || seasonBulkSubmitting}
                      onChange={() => toggleBulkRunDraftWeek(w)}
                    />
                    <label
                      htmlFor={`bulk-run-week-${w}`}
                      style={{
                        margin: 0,
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "0.5rem",
                        cursor:
                          held || seasonBulkSubmitting ? "not-allowed" : "pointer",
                        fontSize: "0.9rem",
                      }}
                    >
                      <span
                        style={{
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {seasonBulkModalWeekLabel(w)}
                      </span>
                      {held ? (
                        <span
                          className="weekly-meta"
                          style={{ flexShrink: 0, whiteSpace: "nowrap", fontSize: "0.8rem" }}
                        >
                          Already blocked (bulk hold).
                        </span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="booking-single-match-actions">
              <button
                type="button"
                className="secondary"
                disabled={seasonBulkSubmitting}
                onClick={() => setSeasonBulkRunModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  seasonBulkSubmitting ||
                  seasonBulkRunDraftWeeks < Math.max(1, minBulkRunDraftWeeks)
                }
                aria-busy={seasonBulkSubmitting}
                onClick={async () => {
                  await runSeasonBulkSubmit(seasonBulkRunDraftWeeks);
                  setSeasonBulkRunModalOpen(false);
                }}
              >
                {seasonBulkSubmitting ? (
                  <span className="booking-async-btn-inner">
                    <Loader2 className="booking-async-spinner" size={13} aria-hidden strokeWidth={2} />
                    Running…
                  </span>
                ) : (
                  "Confirm"
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {convertWeeksModalOpen && activeSeasonHold && activeSeasonHoldId ? (
        <div
          className="booking-single-match-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget && !convertWeekLoading) {
              setConvertWeeksModalOpen(false);
            }
          }}
        >
          <div
            className="booking-single-match-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="booking-convert-weeks-title"
            style={{ maxWidth: "28rem" }}
          >
            <h3 id="booking-convert-weeks-title" style={{ marginTop: 0 }}>
              Mark weeks converted locally
            </h3>
            <p className="weekly-meta" style={{ marginTop: 0 }}>
              <strong>Mark selected locally</strong> updates this app&apos;s database only and
              seeds booked occurrences for weekly emails. Club Locker is not changed.{" "}
              {hasActiveSeasonHoldForConvert ? (
                <>
                  <strong>Convert selected</strong> (only when weeks still have bulk holds here)
                  deletes bulk clinics in Club Locker and creates match reservations — do not use
                  that if you already converted from local.
                </>
              ) : null}
            </p>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: "0.5rem 0",
                border: "1px solid var(--border, #e2e8f0)",
                borderRadius: 8,
              }}
            >
              {Array.from({ length: activeSeasonHold.seasonWeeks }, (_, i) => i + 1).map((w) => {
                const converted = activeSeasonHold.convertedWeeks.includes(w);
                const pendingLocal = isWeekPendingLocalConvert(w);
                const stillHeld = isBulkWeekStillHeld(w);
                const checked = pendingLocal && convertWeeksModalSelected.has(w);
                return (
                  <li
                    key={w}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.45rem",
                      padding: "0.2rem 0.5rem",
                      borderBottom: "1px solid var(--border, #e2e8f0)",
                      background: converted ? "rgba(148,163,184,0.1)" : undefined,
                    }}
                  >
                    <input
                      id={`convert-week-${w}`}
                      type="checkbox"
                      checked={checked}
                      disabled={converted || !pendingLocal || convertWeekLoading}
                      onChange={() => toggleConvertWeeksModalWeek(w)}
                    />
                    <label
                      htmlFor={`convert-week-${w}`}
                      style={{
                        margin: 0,
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "0.5rem",
                        cursor:
                          converted || !pendingLocal || convertWeekLoading
                            ? "not-allowed"
                            : "pointer",
                        fontSize: "0.9rem",
                      }}
                    >
                      <span
                        style={{
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {seasonBulkModalWeekLabel(w)}
                      </span>
                      {converted ? (
                        <span
                          className="weekly-meta"
                          style={{ flexShrink: 0, whiteSpace: "nowrap", fontSize: "0.8rem" }}
                        >
                          Already converted
                        </span>
                      ) : stillHeld ? (
                        <span
                          className="weekly-meta"
                          style={{ flexShrink: 0, whiteSpace: "nowrap", fontSize: "0.8rem" }}
                        >
                          Bulk hold (local)
                        </span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="booking-single-match-actions">
              <button
                type="button"
                className="secondary"
                disabled={convertWeekLoading}
                onClick={() => setConvertWeeksModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="secondary"
                disabled={
                  convertWeekLoading ||
                  ![...convertWeeksModalSelected].some((w) => isWeekPendingLocalConvert(w))
                }
                title="Mark weeks converted in this app only — no Club Locker changes. Seeds booked occurrences for weekly emails."
                onClick={() => {
                  void submitMarkWeeksLocalModal();
                }}
              >
                {convertWeekLoading ? "Working…" : "Mark selected locally"}
              </button>
              {hasActiveSeasonHoldForConvert ? (
                <button
                  type="button"
                  className="primary"
                  disabled={
                    convertWeekLoading ||
                    ![...convertWeeksModalSelected].some((w) => isBulkWeekStillHeld(w))
                  }
                  aria-busy={convertWeekLoading}
                  onClick={() => {
                    void submitConvertWeeksModal();
                  }}
                >
                  {convertWeekLoading ? (
                    <span className="booking-async-btn-inner">
                      <Loader2 className="booking-async-spinner" size={13} aria-hidden strokeWidth={2} />
                      Converting…
                    </span>
                  ) : (
                    "Convert selected"
                  )}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {cancelBookingsOpen ? (
        <div
          className="booking-single-match-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget) {
              setCancelBookingsOpen(false);
              setCancelBookingsFeedback(null);
            }
          }}
        >
          <div
            className="booking-single-match-modal booking-cancel-bookings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="booking-cancel-bookings-title"
            style={{ maxWidth: "36rem" }}
          >
            <h3 id="booking-cancel-bookings-title" style={{ marginTop: 0 }}>
              Cancel bookings
            </h3>
            <p className="weekly-meta" style={{ marginTop: 0 }}>
              Lists <strong>all weeks</strong> on this season hold: about <strong>two rows per week</strong>{" "}
              (Monday + Tuesday play days) for bulk blocks, each removing that{" "}
              <strong>entire play day</strong> in Club Locker when ids are stored in the usual compact
              form. Converted weeks list individual match time slots instead.
            </p>
            {cancelBookingsLoading ? (
              <p className="weekly-meta">Loading bookings for this week…</p>
            ) : null}
            {cancelBookingsFetchError ? (
              <p className="booking-bulk-notice booking-bulk-notice--warn">{cancelBookingsFetchError}</p>
            ) : null}
            {!cancelBookingsLoading && !cancelBookingsFetchError && cancelBookingsRows.length === 0 ? (
              <p className="weekly-meta">
                No cancellable rows — check season start Monday matches the bulk hold, or season hold
                status in the database.
              </p>
            ) : null}
            {cancelBookingsRows.length > 0 ? (
              <>
              <div
                className="booking-cancel-bookings-select-all"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                  marginBottom: "0.35rem",
                }}
              >
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    margin: 0,
                    cursor:
                      cancelBookingsSelectableIds.length === 0 ? "not-allowed" : "pointer",
                    fontSize: "0.9rem",
                  }}
                >
                  <input
                    ref={cancelBookingsSelectAllRef}
                    type="checkbox"
                    checked={cancelBookingsAllSelectableSelected}
                    disabled={cancelBookingsSelectableIds.length === 0}
                    aria-checked={
                      cancelBookingsSelectableIds.length === 0
                        ? false
                        : cancelBookingsAllSelectableSelected
                          ? true
                          : cancelBookingsSelectablePartial
                            ? "mixed"
                            : false
                    }
                    onChange={() => {
                      if (cancelBookingsAllSelectableSelected) {
                        setCancelBookingsSelected(new Set());
                      } else {
                        setCancelBookingsSelected(new Set(cancelBookingsSelectableIds));
                      }
                    }}
                  />
                  Select all
                </label>
              </div>
              <ul
                className="booking-cancel-bookings-list"
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "0.75rem 0",
                  maxHeight: "min(50vh, 22rem)",
                  overflowY: "auto",
                  border: "1px solid var(--border, #e2e8f0)",
                  borderRadius: 8,
                }}
              >
                {cancelBookingsRows.map((row) => {
                  const disabled = !row.complete;
                  return (
                    <li
                      key={row.rowId}
                      style={{
                        borderBottom: "1px solid var(--border, #e2e8f0)",
                        padding: "0.45rem 0.65rem",
                        display: "flex",
                        gap: "0.5rem",
                        alignItems: "flex-start",
                        background: disabled ? "rgba(148,163,184,0.12)" : undefined,
                      }}
                    >
                      <input
                        id={`cancel-book-${row.rowId}`}
                        type="checkbox"
                        checked={cancelBookingsSelected.has(row.rowId)}
                        disabled={disabled}
                        title={
                          disabled
                            ? "Reservation ids are missing — run week conversion again or cancel in Club Locker."
                            : undefined
                        }
                        onChange={() => {
                          setCancelBookingsSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(row.rowId)) next.delete(row.rowId);
                            else next.add(row.rowId);
                            return next;
                          });
                        }}
                      />
                      <label
                        htmlFor={`cancel-book-${row.rowId}`}
                        style={{
                          cursor: disabled ? "not-allowed" : "pointer",
                          flex: 1,
                          margin: 0,
                          fontSize: "0.9rem",
                        }}
                      >
                        {row.label}
                        {disabled ? (
                          <span className="weekly-meta" style={{ display: "block" }}>
                            Incomplete — missing stored reservation ids.
                          </span>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
              </>
            ) : null}
            {cancelBookingsFeedback ? (
              <p
                className={
                  cancelBookingsFeedback.startsWith("Cancel") ||
                  cancelBookingsFeedback.includes("succeeded")
                    ? "booking-bulk-notice booking-bulk-notice--ok"
                    : "booking-bulk-notice booking-bulk-notice--warn"
                }
                style={{ marginTop: "0.5rem" }}
                role="status"
              >
                {cancelBookingsFeedback}
              </p>
            ) : null}
            <div className="booking-single-match-actions">
              <button
                type="button"
                className="secondary"
                disabled={cancelBookingsSubmitting}
                onClick={() => {
                  setCancelBookingsOpen(false);
                  setCancelBookingsFeedback(null);
                }}
              >
                Close
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  cancelBookingsSubmitting ||
                  cancelBookingsLoading ||
                  cancelBookingsRows.length === 0
                }
                aria-busy={cancelBookingsSubmitting}
                onClick={() => {
                  void submitCancelBookingsModal();
                }}
              >
                {cancelBookingsSubmitting ? (
                  <span className="booking-async-btn-inner">
                    <Loader2 className="booking-async-spinner" size={13} aria-hidden strokeWidth={2} />
                    Cancelling…
                  </span>
                ) : (
                  "Cancel selected"
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {singleBookDraft ? (
        <div
          className="booking-single-match-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget) {
              setSingleBookDraft(null);
              setSingleBookFeedback(null);
              setSingleBookReplacesBulkHold(false);
            }
          }}
        >
          <div
            className="booking-single-match-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="booking-single-match-title"
          >
            <h3 id="booking-single-match-title">
              {singleBookReplacesBulkHold
                ? "Replace green bulk with a match"
                : "Book one court (test)"}
            </h3>
            <p className="weekly-meta" style={{ marginTop: 0 }}>
              {formatISODateLongEn(singleBookDraft.date)} ·{" "}
              <strong>{singleBookDraft.begin}</strong>–<strong>{singleBookDraft.end}</strong>
            </p>

            <div className="booking-single-match-field">
              <label htmlFor="booking-single-court">Court</label>
              <select
                id="booking-single-court"
                value={singleBookCourt}
                onChange={(ev) =>
                  setSingleBookCourt(ev.target.value as "stadium" | "center")
                }
                disabled={singleBookSubmitting || bookingMembersLoading}
              >
                <option value="stadium">Stadium</option>
                <option value="center">Center</option>
              </select>
            </div>

            {singleBookReplacesBulkHold ? (
              <p className="booking-bulk-notice booking-bulk-notice--warn" style={{ marginTop: 0 }}>
                Confirms by removing the bulk block on{" "}
                <strong>{singleBookCourt === "stadium" ? "Stadium" : "Center"}</strong> for this league{" "}
                <strong>play day</strong> (the date in the row you clicked), in Club Locker{" "}
                <strong>without</strong> notifying members, then creates the match at the time shown above.
                Most season holds store one reservation per court for the whole day (or a multi-week
                recurring series): that entire block is cleared—not only this 40‑minute slice. The other
                court is unchanged. Expanded per-slot storage removes only this time window on the
                selected court. If the match step fails, the bulk reservation is already gone.
              </p>
            ) : null}

            <div className="booking-single-match-field booking-single-match-field--member">
              <MemberSearchSelect
                idPrefix="booking-single-p1"
                label="Player 1"
                members={bookingMembers}
                excludedSsmIds={excludedSsmIdsForBookingP1}
                valueSsmId={singleBookP1}
                onChange={setSingleBookP1}
                disabled={singleBookSubmitting || bookingMembersLoading}
              />
            </div>

            <div className="booking-single-match-field booking-single-match-field--member">
              <MemberSearchSelect
                idPrefix="booking-single-p2"
                label="Player 2"
                members={bookingMembers}
                excludedSsmIds={excludedSsmIdsForBookingP2}
                valueSsmId={singleBookP2}
                onChange={setSingleBookP2}
                disabled={singleBookSubmitting || bookingMembersLoading}
              />
            </div>

            {singleBookFeedback ? (
              <p
                className={
                  singleBookFeedback.startsWith("Error") ||
                  singleBookFeedback.startsWith("Could not clear")
                    ? "booking-bulk-notice booking-bulk-notice--warn"
                    : "booking-bulk-notice booking-bulk-notice--ok"
                }
                style={{ marginTop: "0.5rem" }}
                role="status"
              >
                {singleBookFeedback}
              </p>
            ) : null}

            <div className="booking-single-match-actions">
              <button
                type="button"
                className="secondary"
                disabled={singleBookSubmitting}
                onClick={() => {
                  setSingleBookDraft(null);
                  setSingleBookFeedback(null);
                  setSingleBookReplacesBulkHold(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  singleBookSubmitting ||
                  bookingMembersLoading ||
                  singleBookP1 == null ||
                  singleBookP2 == null ||
                  singleBookP1 === singleBookP2 ||
                  bookingMembers.length === 0 ||
                  (singleBookReplacesBulkHold && (!seasonId || !startMondayForSeason))
                }
                onClick={() => {
                  void (async () => {
                    const id1 = singleBookP1!;
                    const id2 = singleBookP2!;
                    const m1 = bookingMembers.find((x) => x.ssmId === id1);
                    const m2 = bookingMembers.find((x) => x.ssmId === id2);
                    if (!m1 || !m2 || id1 === id2) {
                      setSingleBookFeedback("Choose two different players.");
                      return;
                    }
                    setSingleBookSubmitting(true);
                    setSingleBookFeedback(null);
                    try {
                      if (singleBookReplacesBulkHold) {
                        if (!seasonId || !startMondayForSeason) {
                          setSingleBookFeedback("Select a season and start Monday first.");
                          return;
                        }
                        const cancelRes = await api<
                          | { ok: true; message: string }
                          | { ok: false; error: string }
                        >(`/api/seasons/${seasonId}/booking/cancel-calendar`, {
                          method: "POST",
                          body: JSON.stringify({
                            startMondayDate: startMondayForSeason,
                            notifyUsers: false,
                            items: [
                              {
                                kind: "bulk" as const,
                                week: calendarWeekNumber,
                                date: singleBookDraft.date,
                                begin: singleBookDraft.begin,
                                end: singleBookDraft.end,
                                courtSide: singleBookCourt,
                              },
                            ],
                          }),
                        });
                        if (!cancelRes.ok) {
                          const errText = cancelRes.error;
                          const mayProceed =
                            /missing reservation id/i.test(errText) ||
                            /nothing to cancel/i.test(errText) ||
                            /no season hold/i.test(errText) ||
                            /legacy reservation id layout/i.test(errText);
                          if (
                            !mayProceed ||
                            !window.confirm(
                              `Could not clear bulk hold in Club Locker:\n${errText}\n\nContinue and create the match anyway? (Use this when there is no bulk block in Club Locker for that day.)`,
                            )
                          ) {
                            setSingleBookFeedback(
                              `Could not clear bulk hold: ${errText}`,
                            );
                            return;
                          }
                          onLog(
                            `Skipped bulk cancel (${errText}); booking match in Club Locker only.`,
                          );
                        } else {
                          onLog(cancelRes.message);
                          void refreshLocalSeasonHolds();
                        }
                      }
                      const webPayload = {
                        date: singleBookDraft.date,
                        slotBegin: singleBookDraft.begin,
                        slotEnd: singleBookDraft.end,
                        courtSide: singleBookCourt,
                        player1SsmId: id1,
                        player2SsmId: id2,
                        player1Name: bookingMemberPickLabel(m1),
                        player2Name: bookingMemberPickLabel(m2),
                      };
                      const resp = await fetch("/api/booking/single-court-match", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(webPayload),
                      });
                      const rawText = await resp.text();
                      let parsed: { ok?: boolean; message?: string };
                      try {
                        parsed = JSON.parse(rawText) as { ok?: boolean; message?: string };
                      } catch {
                        setSingleBookFeedback(
                          `Error (${resp.status}): Non-JSON response from booking API.`,
                        );
                        return;
                      }
                      onLog(rawText);

                      const msgOk = parsed.message ?? (parsed.ok ? "Done." : "Request failed.");
                      if (!parsed.ok || resp.status >= 400) {
                        setSingleBookFeedback(`Error (${resp.status}): ${msgOk}`);
                      } else {
                        setSingleBookFeedback(msgOk);
                      }
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : String(err);
                      setSingleBookFeedback(msg);
                      onLog(msg);
                    } finally {
                      setSingleBookSubmitting(false);
                    }
                  })();
                }}
              >
                {singleBookSubmitting
                  ? singleBookReplacesBulkHold
                    ? "Clearing bulk & booking…"
                    : "Creating…"
                  : singleBookReplacesBulkHold
                    ? "Clear bulk & confirm match"
                    : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {courtSlotsToApply.length > 0 ? (
        <div className="booking-roster-update-bar" role="region" aria-label="Roster court updates">
          <p className="booking-roster-update-bar-text">
            <strong>{courtSlotsToApply.length}</strong> match booking
            {courtSlotsToApply.length === 1 ? "" : "s"} need updates to match the live
            roster (boxes 1–16).
            {rosterImpactApplyProgress ? (
              <span className="booking-roster-update-bar-progress">
                {" "}
                Updating {rosterImpactApplyProgress.current} of{" "}
                {rosterImpactApplyProgress.total}: {rosterImpactApplyProgress.label}
              </span>
            ) : null}
          </p>
          <button
            type="button"
            className="primary"
            disabled={rosterImpactApplyBusy}
            onClick={() => setRosterImpactApplyModalOpen(true)}
          >
            {rosterImpactApplyBusy ? "Updating bookings…" : "Make all updates"}
          </button>
        </div>
      ) : null}

      {rosterImpactApplyModalOpen ? (
        <div
          className="booking-single-match-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget && !rosterImpactApplyBusy) {
              setRosterImpactApplyModalOpen(false);
            }
          }}
        >
          <div
            className="booking-single-match-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="booking-roster-updates-title"
            style={{ maxWidth: "32rem" }}
          >
            <h3 id="booking-roster-updates-title" style={{ marginTop: 0 }}>
              Update court bookings?
            </h3>
            <p className="weekly-meta" style={{ marginTop: 0 }}>
              This will update <strong>{courtSlotsToApply.length}</strong> individual
              match reservation
              {courtSlotsToApply.length === 1 ? "" : "s"} in Club Locker (boxes 1–16
              only), one at a time with about five seconds between each. Members may
              receive booking emails when reservations are replaced.
            </p>
            {(rosterImpact?.blockers.length ?? 0) > 0 ? (
              <p className="weekly-meta" role="note">
                Note: some weeks have incomplete rosters (e.g. empty seats). Stale
                bookings will be cancelled; new bookings for those matchups are skipped
                until the roster is filled.
              </p>
            ) : null}
            <div className="booking-single-match-actions">
              <button
                type="button"
                className="secondary"
                disabled={rosterImpactApplyBusy}
                onClick={() => setRosterImpactApplyModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  rosterImpactApplyBusy || courtSlotsToApply.length === 0
                }
                aria-busy={rosterImpactApplyBusy}
                onClick={() => {
                  void applyAllRosterCourtUpdates();
                }}
              >
                {rosterImpactApplyBusy ? (
                  <span className="booking-async-btn-inner">
                    <Loader2
                      className="booking-async-spinner"
                      size={13}
                      aria-hidden
                      strokeWidth={2}
                    />
                    Updating…
                  </span>
                ) : (
                  "Confirm"
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
