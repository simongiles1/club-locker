import {
  bulkHoldSlotsForWeekday,
  getWeekMatchups,
  seasonWeekPlayDates,
  statHolidayForDate,
  statutoryHolidaysForYear,
} from "@squash/shared";
import { ChevronLeft, ChevronRight } from "lucide-react";
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

/** Pick nearest canonical 40 min window by clock minutes (shared with padded grid rails). */
function nearestCanonicalSlotFromMinutes(
  clickMinutes: number,
  slots: readonly { begin: string; end: string }[],
): { begin: string; end: string } | null {
  if (slots.length === 0) return null;

  let best = slots[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of slots) {
    const t0 = parseHHMMToMinutes(s.begin);
    const t1 = parseHHMMToMinutes(s.end);
    const mid = (t0 + t1) / 2;
    let score = Math.abs(clickMinutes - mid);
    if (clickMinutes >= t0 && clickMinutes <= t1) score *= 0.1;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return { begin: best.begin, end: best.end };
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

  const sliceGapWithNearestBook = (t0: number, t1: number): void => {
    let g0 = t0;
    while (g0 < t1) {
      const g1 = Math.min(g0 + SLOT_BOOK_STEP_MIN, t1);
      const mid = (g0 + g1) / 2;
      const book =
        nearestCanonicalSlotFromMinutes(mid, canonical) ?? {
          begin: canonical[0]!.begin,
          end: canonical[0]!.end,
        };
      pushSlice(g0, g1, book);
      g0 = g1;
    }
  };

  let cursor = gridStart;

  for (const iv of intervals) {
    if (iv.b <= gridStart) continue;
    if (iv.a >= gridEnd) break;

    const gapEnd = Math.min(iv.a, gridEnd);
    if (cursor < gapEnd) {
      sliceGapWithNearestBook(cursor, gapEnd);
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
    sliceGapWithNearestBook(cursor, gridEnd);
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
  return nearestCanonicalSlotFromMinutes(clickMinutes, slots);
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

const WEEKS_TO_BOOK_CHOICES = [1, 2, 3, 4, 5, 6, 7] as const;

function labelWeeksToBook(n: number): string {
  if (n === 1) return "First week only";
  if (n === 7) return "All 7 weeks";
  return `First ${n} weeks`;
}

/** Same choices, phrased for a sentence (e.g. after “covering …”). */
function describeWeeksToBookInSentence(n: number): string {
  if (n === 1) return "the first week only";
  if (n === 7) return "all 7 season weeks";
  return `the first ${n} season weeks`;
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

function bookingMemberPickLabel(m: ClubMember): string {
  const n = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim();
  return n || (m.userName?.trim() ?? "") || `Member ${m.ssmId}`;
}

/** Key: `${isoDate}|${HH:MM-HH:MM}` → Stadium / Center labels from week preview. */
function buildSlotPlayerLabelsFromPreview(preview: PreviewResult): Map<
  string,
  { stadium: string; center: string }
> {
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
    const ids = [...byCourt.keys()].sort(
      (a, b) => Number(a) - Number(b) || a.localeCompare(b),
    );
    if (ids.length === 0) continue;
    const stadium = byCourt.get(ids[0]!) ?? "—";
    const center = byCourt.get(ids[1] ?? "") ?? (ids.length > 1 ? "—" : stadium);
    out.set(slotKey, { stadium, center });
  }
  return out;
}

function SeasonBlockWeekCalendar({
  preview,
  weekIndex,
  onWeekIndexChange,
  booked,
  slotPlayerLabels,
  onBulkSlotContextMenu,
}: {
  preview: SeasonBulkPreviewResponse;
  weekIndex: number;
  onWeekIndexChange: (i: number) => void;
  /** True when a season block already exists in Club Locker for this start Monday. */
  booked: boolean;
  /** Optional: player-name matchup lines per date+slot (from week plan preview). */
  slotPlayerLabels?: Map<string, { stadium: string; center: string }>;
  /** Right-click: empty column area (any day) or blue preview bulk blocks; green blocks disabled. */
  onBulkSlotContextMenu?: (e: ReactMouseEvent, slot: BulkSlotBookingRef) => void;
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

  const playDates = seasonWeekPlayDates(preview.startMondayDate, weekIndex + 1);
  const playMonday = parseISODateLocal(playDates.weekMonday) ?? addDaysToDate(startMonday, weekIndex * 7);
  const firstPlayCol = playDates.shiftedByHoliday ? 2 : 1; // Tue when shifted, else Mon
  const secondPlayCol = playDates.shiftedByHoliday ? 3 : 2; // Wed when shifted, else Tue
  const weekStartSunday = addDaysToDate(playMonday, -1);
  const weekEndSaturday = addDaysToDate(playMonday, 5);
  const canPrev = weekIndex > 0;
  const canNext = weekIndex < preview.seasonWeeks - 1;

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
      c1: `${w.matches[0][0]}v${w.matches[0][1]}`,
      c2: `${w.matches[1][0]}v${w.matches[1][1]}`,
    };
  }, [scheduleRowIndex]);

  const fmtRange = (d: Date) =>
    d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });

  const statutoryHoursThisYear = useMemo(
    () =>
      statutoryHolidaysForYear(playMonday.getFullYear()).map((h) => ({
        label: h.name,
        date: h.date,
        hours: h.hours.closed ? "Closed" : `${h.hours.open}–${h.hours.close}`,
      })),
    [playMonday],
  );

  return (
    <div className="season-bulk-cal">
      <div className="season-bulk-cal-toolbar">
        <div className="season-bulk-cal-nav" role="group" aria-label="Play week navigation">
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous week"
            disabled={!canPrev}
            onClick={() => onWeekIndexChange(weekIndex - 1)}
          >
            <ChevronLeft size={18} aria-hidden />
          </button>
          <span style={{ fontWeight: 600, minWidth: "11rem", textAlign: "center" }}>
            Season week {weekIndex + 1} of {preview.seasonWeeks}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Next week"
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
              <span>Season hold recorded</span>
            </li>
            <li>
              <span
                className="season-bulk-legend-swatch season-bulk-legend-swatch--holiday"
                aria-hidden
              />
              <span>Statutory holiday / closed</span>
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
                const holiday = statHolidayForDate(iso);
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
                            const reserveRange = formatHHMMRange12HourCompact(
                              band.bookBegin,
                              band.bookEnd,
                            );
                            const sliceMatchesBook =
                              band.sliceBegin === band.bookBegin &&
                              band.sliceEnd === band.bookEnd;
                            return (
                              <div
                                key={`${iso}-${band.reactKey}`}
                                className="gcal-slot-book-band"
                                aria-label={
                                  sliceMatchesBook
                                    ? `Book ${displayRange}. Right-click.`
                                    : `${displayRange} on the timeline. Right-click reserves ${reserveRange}.`
                                }
                                style={{ top: band.top, height: band.height }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  onBulkSlotContextMenu(e, {
                                    date: iso,
                                    begin: band.bookBegin,
                                    end: band.bookEnd,
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
                          const namedCourts = slotPlayerLabels?.get(slotLookupKey);
                          const stadiumMu = namedCourts?.stadium ?? weekCourtMatchups?.c1;
                          const centerMu = namedCourts?.center ?? weekCourtMatchups?.c2;
                          const titleBits = [
                            `${s.begin}–${s.end}`,
                            box != null ? `box ${box}` : null,
                            stadiumMu && centerMu
                              ? `Stadium: ${stadiumMu} · Center: ${centerMu}`
                              : null,
                          ].filter(Boolean);
                          return (
                            <div
                              key={`${iso}-${s.slotLabel}`}
                              className={
                                booked
                                  ? "gcal-event gcal-event--bulk gcal-event--booked"
                                  : onBulkSlotContextMenu
                                    ? "gcal-event gcal-event--bulk gcal-event--slot-book"
                                    : "gcal-event gcal-event--bulk"
                              }
                              style={{ top, height: h }}
                              title={titleBits.join(" · ")}
                              onContextMenu={
                                booked
                                  ? (e) => {
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
                              {stadiumMu && centerMu ? (
                                <div
                                  className="gcal-event-courts"
                                  aria-label="This week: Stadium and Center matchups"
                                >
                                  <div className="gcal-event-court">
                                    <span className="gcal-event-court-hd">Stadium</span>
                                    <span className="gcal-event-court-mu">
                                      {stadiumMu}
                                    </span>
                                  </div>
                                  <div className="gcal-event-court">
                                    <span className="gcal-event-court-hd">Center</span>
                                    <span className="gcal-event-court-mu">
                                      {centerMu}
                                    </span>
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

      <p className="weekly-meta" style={{ marginBottom: 0, marginTop: "0.75rem" }}>
        {playDates.shiftedByHoliday
          ? `This week is shifted to Tuesday/Wednesday because ${playDates.holidayName} falls on Monday. `
          : ""}
        Run uses <code>{preview.bff.method}</code> <code>{preview.bff.path}</code> with{" "}
        <code>confirm: true</code> and the same start Monday and “weeks to book” as the form
        above.
      </p>
      <p className="weekly-meta" style={{ marginBottom: 0, marginTop: "0.5rem" }}>
        Statutory holiday hours:{" "}
        {statutoryHoursThisYear.map((h) => `${h.label} (${h.date}: ${h.hours})`).join(" · ")}
      </p>
    </div>
  );
}

export function BookingPage({
  seasonId,
  seasonStartMondayISO = "",
  onLog,
}: {
  seasonId: string;
  /** First Monday for the selected DB season (from calendar_segment + club_year). */
  seasonStartMondayISO?: string;
  onLog: (s: string) => void;
}) {
  const [startMondayForSeason, setStartMondayForSeason] = useState("");
  const [weeksToBook, setWeeksToBook] = useState<number>(7);
  const [confirmSeasonBulk, setConfirmSeasonBulk] = useState(false);
  const [seasonBlockBooked, setSeasonBlockBooked] = useState(false);
  const [activeSeasonHold, setActiveSeasonHold] = useState<{
    id: string;
    seasonWeeks: number;
    status: string;
  } | null>(null);
  const hasActiveSevenWeekHold =
    activeSeasonHold?.status === "active" && activeSeasonHold.seasonWeeks === 7;
  const activeSeasonHoldId = activeSeasonHold?.id ?? null;
  const [seasonBulkFeedback, setSeasonBulkFeedback] = useState<{
    kind: "idempotent" | "success" | "cleared" | "error";
    message: string;
    /** From API when Club Locker still has reservations in those slots. */
    slotConflict?: boolean;
  } | null>(null);
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

  const [viewedWeekPreview, setViewedWeekPreview] = useState<PreviewResult | null>(
    null,
  );
  const [viewedWeekPreviewLoading, setViewedWeekPreviewLoading] = useState(false);
  const [convertWeekLoading, setConvertWeekLoading] = useState(false);
  const [convertFeedback, setConvertFeedback] = useState<{
    kind: "ok" | "error";
    message: string;
  } | null>(null);

  const slotContextMenuRef = useRef<HTMLDivElement | null>(null);
  const [slotContextMenu, setSlotContextMenu] = useState<
    ({ x: number; y: number } & BulkSlotBookingRef) | null
  >(null);
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
  const [bookingMembers, setBookingMembers] = useState<ClubMember[]>([]);
  const [bookingMembersLoading, setBookingMembersLoading] = useState(false);

  const openBulkSlotContextMenu = useCallback((e: ReactMouseEvent, slot: BulkSlotBookingRef) => {
    setSlotContextMenu({ x: e.clientX, y: e.clientY, ...slot });
  }, []);

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
    if (!singleBookDraft) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setSingleBookDraft(null);
        setSingleBookFeedback(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [singleBookDraft]);

  const slotPlayerLabelsForCalendar = useMemo(() => {
    if (!viewedWeekPreview || !("items" in viewedWeekPreview)) return undefined;
    return buildSlotPlayerLabelsFromPreview(viewedWeekPreview);
  }, [viewedWeekPreview]);

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

  /** Load week plan preview for the calendar week so chips can show player names. */
  useEffect(() => {
    if (!seasonId || !startMondayForSeason) {
      setViewedWeekPreview(null);
      setViewedWeekPreviewLoading(false);
      return;
    }
    const weekNumber = seasonCalendarWeekIndex + 1;
    const dates = seasonWeekPlayDates(startMondayForSeason, weekNumber);
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
  }, [seasonId, startMondayForSeason, seasonCalendarWeekIndex]);

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
    },
    [seasonId, startMondayForSeason, weeksToBook, onLog],
  );

  useEffect(() => {
    fetchSeasonBlockPreview().catch(() => {});
  }, [fetchSeasonBlockPreview]);

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
      const active = holds.find(
        (h) =>
          h.startMondayDate === startMondayForSeason && h.status === "active",
      );
      setSeasonBlockBooked(!!active);
      setActiveSeasonHold(
        active
          ? { id: active.id, seasonWeeks: active.seasonWeeks, status: active.status }
          : null,
      );
    } catch {
      setSeasonBlockBooked(false);
      setActiveSeasonHold(null);
    }
  }, [seasonId, startMondayForSeason]);

  useEffect(() => {
    refreshLocalSeasonHolds().catch(() => {});
  }, [refreshLocalSeasonHolds]);

  useEffect(() => {
    if (!seasonPreview) return;
    setSeasonCalendarWeekIndex((i) =>
      Math.max(0, Math.min(i, seasonPreview.seasonWeeks - 1)),
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
                  First Monday of season (ISO){" "}
                  <input
                    value={startMondayForSeason}
                    onChange={(e) => setStartMondayForSeason(e.target.value)}
                    size={12}
                  />
                </label>
                <label>
                  Weeks to book{" "}
                  <select
                    value={weeksToBook}
                    onChange={(e) => setWeeksToBook(Number(e.target.value))}
                    aria-label="Number of season weeks to include in this bulk block"
                  >
                    {WEEKS_TO_BOOK_CHOICES.map((n) => (
                      <option key={n} value={n}>
                        {labelWeeksToBook(n)}
                      </option>
                    ))}
                  </select>
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
                  disabled={!seasonPreview}
                  onClick={() => {
                    if (seasonPreview) {
                      onLog(JSON.stringify(seasonPreview, null, 2));
                    }
                  }}
                >
                  Copy full JSON to log
                </button>
              </div>
            </div>
            {seasonPreviewError ? (
              <p className="weekly-empty" style={{ marginTop: "0.75rem" }}>
                Preview failed: {seasonPreviewError}
              </p>
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
                  slotPlayerLabels={slotPlayerLabelsForCalendar}
                  onBulkSlotContextMenu={openBulkSlotContextMenu}
                />
                <p className="weekly-meta" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
                  Tip: <strong>Right-click</strong> any day in the grid (outside red holiday blocks)
                  to book — the time snaps to one of our real <strong>40‑minute</strong> league slots
                  (Mondays roughly 4:30–9:50 pm; Tuesdays 11:50 am–1:50 pm lunch plus 4:30–7:50 pm).
                  When the club opens its booking day (e.g. 6:30 am) is separate from those block
                  times. Or right-click a blue league block for that exact slot. Green blocks are held
                  in Club Locker; booking there is disabled so bulk holds are never removed from this
                  UI.
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
            <label style={{ display: "block", marginTop: "0.75rem" }}>
              <input
                type="checkbox"
                checked={confirmSeasonBulk}
                onChange={(e) => setConfirmSeasonBulk(e.target.checked)}
              />{" "}
              I understand this will create one clinic per court for each play day/week on the
              club, covering {describeWeeksToBookInSentence(weeksToBook)}.
            </label>
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
            <p className="booking-bulk-hint" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
              Green slots mean this app has a stored season hold (SQLite). If you removed the
              clinics in Club Locker, use{" "}
              <strong>Remove local season hold</strong> so a new run is allowed. If the API
              still reports a conflict, something is still on the club schedule in Club Locker
              (other clinics, one-off games, or the other court)—remove those and try again.
            </p>
            <div className="row" style={{ marginTop: "0.5rem" }}>
              <button
                type="button"
                className="primary"
                disabled={!seasonId || !startMondayForSeason || !confirmSeasonBulk}
                onClick={async () => {
                  setSeasonBulkFeedback(null);
                  setLastSeasonBulkApiResponse(null);
                  setCopySeasonBulkResponseStatus(null);
                  try {
                    const res = await api<SeasonBulkResult>(
                      `/api/seasons/${seasonId}/booking/season-bulk`,
                      {
                        method: "POST",
                        body: JSON.stringify({
                          startMondayDate: startMondayForSeason,
                          seasonWeeks: weeksToBook,
                          confirm: true,
                        }),
                      },
                    );
                    onLog(JSON.stringify(res, null, 2));
                    setLastSeasonBulkApiResponse(res);
                    if (res.idempotent) {
                      setSeasonBulkFeedback({
                        kind: "idempotent",
                        message: res.message,
                      });
                      void refreshLocalSeasonHolds();
                      return;
                    }
                    void refreshLocalSeasonHolds();
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
                  }
                }}
              >
                Run season block (bulk)
              </button>
              {hasActiveSevenWeekHold && activeSeasonHoldId ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={!seasonId || convertWeekLoading || !activeSeasonHoldId}
                  title={`Convert season week ${seasonCalendarWeekIndex + 1} only (delete bulk clinics for this week, create match reservations).`}
                  onClick={async () => {
                    const w = seasonCalendarWeekIndex + 1;
                    if (
                      !window.confirm(
                        `Convert season week ${w}? This deletes the bulk block reservations for this week in Club Locker and creates individual match bookings with players from the week plan.`,
                      )
                    ) {
                      return;
                    }
                    setConvertFeedback(null);
                    setConvertWeekLoading(true);
                    try {
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
                      setConvertFeedback({
                        kind: res.status === "ok" || res.status === "partial" ? "ok" : "error",
                        message: res.message,
                      });
                      void refreshLocalSeasonHolds();
                      const dates = seasonWeekPlayDates(startMondayForSeason, w);
                      const q = new URLSearchParams({
                        mondayDate: dates.firstPlayDate,
                        tuesdayDate: dates.secondPlayDate,
                      });
                      const prev = await api<PreviewResult | { error: string }>(
                        `/api/seasons/${seasonId}/booking/weeks/${w}/preview?${q.toString()}`,
                      );
                      setViewedWeekPreview(prev);
                    } catch (e) {
                      const msg = String(e);
                      onLog(msg);
                      setConvertFeedback({ kind: "error", message: msg });
                    } finally {
                      setConvertWeekLoading(false);
                    }
                  }}
                >
                  {convertWeekLoading
                    ? "Converting week…"
                    : `Convert week ${seasonCalendarWeekIndex + 1} to matches`}
                </button>
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
              <button
                type="button"
                className="secondary"
                disabled={!seasonId}
                onClick={async () => {
                  const list = await api<unknown[]>(
                    `/api/seasons/${seasonId}/booking/holds`,
                  );
                  onLog(JSON.stringify(list, null, 2));
                }}
              >
                List per-week holds (legacy)
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!seasonId}
                onClick={async () => {
                  const list = await api<unknown[]>(
                    `/api/seasons/${seasonId}/booking/runs`,
                  );
                  onLog(JSON.stringify(list, null, 2));
                }}
              >
                List runs
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
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setSingleBookCourt("stadium");
              setSingleBookP1(null);
              setSingleBookP2(null);
              setSingleBookFeedback(null);
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
            }
          }}
        >
          <div
            className="booking-single-match-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="booking-single-match-title"
          >
            <h3 id="booking-single-match-title">Book one court (test)</h3>
            <p className="weekly-meta" style={{ marginTop: 0 }}>
              {formatISODateLongEn(singleBookDraft.date)} · {singleBookDraft.begin}–
              {singleBookDraft.end}. Uses Club Locker match reservation (
              <code>POST /clubs/…/reservations</code>). Only the two selected members are added.
              If this time is covered by an existing bulk block, Club Locker may return a conflict —
              cancel the block for that slot first, or test on an open time.
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
                  singleBookFeedback.startsWith("Error")
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
                  bookingMembers.length === 0
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
                      const res = await api<{
                        ok: boolean;
                        message: string;
                        status?: number;
                        data?: unknown;
                      }>("/api/booking/single-court-match", {
                        method: "POST",
                        body: JSON.stringify({
                          date: singleBookDraft.date,
                          slotBegin: singleBookDraft.begin,
                          slotEnd: singleBookDraft.end,
                          courtSide: singleBookCourt,
                          player1SsmId: id1,
                          player2SsmId: id2,
                          player1Name: bookingMemberPickLabel(m1),
                          player2Name: bookingMemberPickLabel(m2),
                        }),
                      });
                      onLog(JSON.stringify(res, null, 2));
                      setSingleBookFeedback(res.message ?? "Done.");
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
                {singleBookSubmitting ? "Creating…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
