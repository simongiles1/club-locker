import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CalendarDays,
  CalendarOff,
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  EyeOff,
  Grid3x3,
  History,
  LayoutGrid,
  Mail,
  Plus,
  Trash2,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  BOOKING_CALENDAR_SEASONS,
  bookingCalendarSeasonLabel,
  bookingSeasonImmediatelyFollowing,
  defaultBookingSeasonAndStartMonday,
  isBookingCalendarSegmentLocallyActive,
  isUsSquashBoxLeagueRosterLocallyEditable,
  assignableVacantSeasonStartSeats,
  applyAnchoredBoxSeatsToRoster,
  buildBoxUiSeatRows,
  computeBoxSeatByPlayerId,
  effectiveRelativeRankInBox,
  isReturningSeasonStartPlayerInBox,
  OPEN_BOX_SEAT_LABEL,
  parseRelativeRankOverridesJson,
  playersInBoxSortedByEffectiveRank,
  reorderPlayerWithinBoxByCurrentRank,
  reorderRelativeRankInBox,
  relativeRankInBox,
  sanitizeSeatOverridesForGroundTruth,
  type BookingCalendarSeason,
} from "@squash/shared";
import { api, downloadTextFile } from "./api.js";
import { BookingPage } from "./BookingPage.js";
import { EmailsPage } from "./EmailsPage.js";
import { StatutoryHolidaysPage } from "./StatutoryHolidaysPage.js";
import { Schedule } from "./Schedule.js";
import { useToast } from "./toast.js";
import type { ClubMember } from "./MembersPage.js";
import { MemberSearchSelect } from "./MemberSearchSelect.js";
import { RosterImpactReview } from "./RosterImpactReview.js";
import { SeasonStartRosterPage } from "./SeasonStartRosterPage.js";

export type BoxLeagueEvent = {
  eventId: number;
  eventTypeId?: number;
  eventName: string;
  startDate: string;
  endDate: string;
  clubName?: string;
  clubId?: number;
  eventTypeName?: string;
  hidden: boolean;
  numBoxes?: number;
  numPlayers?: number;
  sportId?: number;
};

export type BoxLeaguePlayer = {
  id: number;
  firstName: string;
  lastName: string;
  partnerId: number | null;
  partnerFirstName: string | null;
  partnerLastName: string | null;
  level: number;
  pointsSeason: number;
  winsSeason: number;
  lossesSeason: number;
  prevBox: number;
  prevBoxRank: number;
  rating: number;
  partnerRating: number | null;
  playerCurrentRank: number;
};

function formatEventRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
  };
  return `${s.toLocaleDateString(undefined, opts)} – ${e.toLocaleDateString(undefined, opts)}`;
}

/** Same rules as `houseLeagueRosterCsvBuffer` in the API (RFC 4180-ish cells). */
function csvEscapeCellAccounting(value: string): string {
  const v = String(value ?? "").replace(/\r\n|\n|\r/g, " ").trimEnd();
  if (/["\n,]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function houseLeagueRosterCsvText(
  roster: { firstName: string; lastName: string }[],
): string {
  const lines = [
    `${csvEscapeCellAccounting("First name")},${csvEscapeCellAccounting("Last name")}`,
  ];
  for (const r of roster) {
    lines.push(
      `${csvEscapeCellAccounting(r.firstName)},${csvEscapeCellAccounting(r.lastName)}`,
    );
  }
  return lines.join("\r\n");
}

function houseLeagueBoxesCsvText(
  groups: { boxLabel: string; players: BoxLeaguePlayer[] }[],
  relativeRankByPlayerId: Map<number, number>,
): string {
  const esc = csvEscapeCellAccounting;
  const lines = [
    [
      esc("Box"),
      esc("First name"),
      esc("Last name"),
      esc("Rating"),
      esc("Wins"),
      esc("Losses"),
      esc("Points"),
      esc("RR"),
    ].join(","),
  ];
  for (const group of groups) {
    for (const p of group.players) {
      const rating =
        typeof p.rating === "number" && !Number.isNaN(p.rating)
          ? p.rating.toFixed(2)
          : "";
      const rr = relativeRankByPlayerId.get(p.id);
      lines.push(
        [
          esc(group.boxLabel),
          esc(p.firstName.trim()),
          esc(p.lastName.trim()),
          esc(rating),
          esc(String(p.winsSeason)),
          esc(String(p.lossesSeason)),
          esc(String(p.pointsSeason)),
          esc(rr != null ? String(rr) : ""),
        ].join(","),
      );
    }
  }
  return lines.join("\r\n");
}

/** Many email clients / browsers cap `mailto:` URL length; stay under a safe size. */
const ACCOUNTING_MAILTO_MAX_URL_LENGTH = 7500;

/**
 * Single-line To field: must look like a normal `local@host.tld` address (not exhaustive vs RFC 5322).
 */
const ACCOUNTING_TO_EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function isAccountingRecipientEmail(value: string): boolean {
  const t = value.trim();
  if (!t || /[\s,;]/.test(t)) return false;
  return ACCOUNTING_TO_EMAIL_RE.test(t);
}

/** Latest event by `startDate` (includes hidden). */
function defaultLatestEventId(events: BoxLeagueEvent[]): string {
  if (events.length === 0) return "";
  const sorted = [...events].sort(
    (a, b) =>
      new Date(b.startDate).getTime() - new Date(a.startDate).getTime(),
  );
  return String(sorted[0]!.eventId);
}

function VisibilityIcon({ hidden }: { hidden: boolean }) {
  if (hidden) {
    return (
      <EyeOff
        className="houseleague-event-visibility-icon houseleague-event-visibility-icon--hidden"
        size={18}
        strokeWidth={2}
        aria-hidden
      />
    );
  }
  return (
    <Eye
      className="houseleague-event-visibility-icon houseleague-event-visibility-icon--visible"
      size={18}
      strokeWidth={2}
      aria-hidden
    />
  );
}

function LeagueEventRow({
  ev,
  showDates = true,
}: {
  ev: BoxLeagueEvent;
  /** When false (e.g. closed picker trigger), only icon + name — dates appear in the list only. */
  showDates?: boolean;
}) {
  const rangeText =
    ev.startDate && ev.endDate
      ? formatEventRange(ev.startDate, ev.endDate)
      : "—";
  return (
    <span className="houseleague-event-row">
      <span
        className="houseleague-event-visibility"
        title={ev.hidden ? "Hidden on US Squash" : "Visible on US Squash"}
      >
        <VisibilityIcon hidden={ev.hidden} />
      </span>
      <span className="houseleague-event-name" title={ev.eventName}>
        {ev.eventName}
      </span>
      {showDates ? (
        <span className="houseleague-event-dates">{rangeText}</span>
      ) : null}
    </span>
  );
}

function HouseleagueTabLabel({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <>
      <Icon
        className="houseleague-page-tab-icon"
        size={18}
        strokeWidth={2}
        aria-hidden
      />
      <span>{children}</span>
    </>
  );
}

function LeagueEventPicker({
  events,
  value,
  onChange,
  disabled,
  leadingAction,
}: {
  events: BoxLeagueEvent[];
  value: string;
  onChange: (eventId: string) => void;
  disabled: boolean;
  /** First row in the menu (e.g. create flow) — does not change `value`. */
  leadingAction?: { label: string; onSelect: () => void };
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = events.find((e) => String(e.eventId) === value) ?? null;

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const el = rootRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const listHasRows =
    Boolean(leadingAction) || events.length > 0;

  return (
    <div className="houseleague-picker" ref={rootRef}>
      <button
        type="button"
        className="houseleague-picker-trigger"
        disabled={disabled}
        aria-label="Select league event"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => {
          if (!disabled) setOpen((o) => !o);
        }}
      >
        <span className="houseleague-picker-trigger-inner">
          {selected ? (
            <LeagueEventRow ev={selected} showDates={false} />
          ) : (
            <span className="houseleague-picker-placeholder">
              {leadingAction && events.length === 0
                ? "Create season or pick an event…"
                : "No league events"}
            </span>
          )}
        </span>
        <ChevronDown
          className={`houseleague-picker-chevron ${open ? "houseleague-picker-chevron--open" : ""}`}
          size={20}
          aria-hidden
        />
      </button>
      {open && listHasRows ? (
        <ul className="houseleague-picker-list" role="listbox">
          {leadingAction ? (
            <li key="__create_season__" role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="houseleague-picker-option houseleague-picker-option--action"
                onClick={() => {
                  leadingAction.onSelect();
                  setOpen(false);
                }}
              >
                <span className="houseleague-picker-action-label">
                  {leadingAction.label}
                </span>
              </button>
            </li>
          ) : null}
          {events.map((ev) => {
            const idStr = String(ev.eventId);
            const isSelected = idStr === value;
            return (
              <li key={ev.eventId} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={
                    isSelected
                      ? "houseleague-picker-option houseleague-picker-option--selected"
                      : "houseleague-picker-option"
                  }
                  onClick={() => {
                    onChange(idStr);
                    setOpen(false);
                  }}
                >
                  <LeagueEventRow ev={ev} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function sortBoxLeaguePlayersByName(players: BoxLeaguePlayer[]): BoxLeaguePlayer[] {
  return [...players].sort((x, y) => {
    const la = `${x.lastName} ${x.firstName}`;
    const lb = `${y.lastName} ${y.firstName}`;
    return la.localeCompare(lb, undefined, { sensitivity: "base" });
  });
}

type PlayersListSortKey =
  | "firstName"
  | "lastName"
  | "level"
  | "rating"
  | "points";
type PlayersListSortDir = "asc" | "desc";

function playersListSortableNameKey(p: BoxLeaguePlayer): string {
  return `${p.lastName.trim()} ${p.firstName.trim()}`;
}

/** Compare rows for Players tab sorting (excluding W–L which is unsortable). */
function comparePlayersListByColumn(
  a: BoxLeaguePlayer,
  b: BoxLeaguePlayer,
  key: PlayersListSortKey,
  dir: PlayersListSortDir,
): number {
  const m = dir === "asc" ? 1 : -1;
  switch (key) {
    case "firstName":
      return (
        a.firstName.trim().localeCompare(b.firstName.trim(), undefined, {
          sensitivity: "base",
        }) * m
      );
    case "lastName":
      return (
        a.lastName.trim().localeCompare(b.lastName.trim(), undefined, {
          sensitivity: "base",
        }) * m
      );
    case "level": {
      const la =
        typeof a.level === "number" && Number.isFinite(a.level) ? a.level : null;
      const lb =
        typeof b.level === "number" && Number.isFinite(b.level) ? b.level : null;
      if (la == null && lb == null) return 0;
      if (la == null) return 1;
      if (lb == null) return -1;
      return (la - lb) * m;
    }
    case "rating": {
      const ra =
        typeof a.rating === "number" &&
        Number.isFinite(a.rating) &&
        !Number.isNaN(a.rating)
          ? a.rating
          : null;
      const rb =
        typeof b.rating === "number" &&
        Number.isFinite(b.rating) &&
        !Number.isNaN(b.rating)
          ? b.rating
          : null;
      if (ra == null && rb == null) return 0;
      if (ra == null) return 1;
      if (rb == null) return -1;
      return (ra - rb) * m;
    }
    case "points":
      return (a.pointsSeason - b.pointsSeason) * m;
    default:
      return 0;
  }
}

function tieBreakPlayersListRows(a: BoxLeaguePlayer, b: BoxLeaguePlayer): number {
  return playersListSortableNameKey(a).localeCompare(
    playersListSortableNameKey(b),
    undefined,
    { sensitivity: "base" },
  );
}

function PlayersListSortableTh({
  label,
  column,
  activeKey,
  dir,
  onSort,
}: {
  label: string;
  column: PlayersListSortKey;
  activeKey: PlayersListSortKey;
  dir: PlayersListSortDir;
  onSort: (column: PlayersListSortKey) => void;
}) {
  const active = activeKey === column;
  return (
    <th
      className="houseleague-th-sort-cell"
      scope="col"
      aria-sort={
        active ? (dir === "asc" ? "ascending" : "descending") : undefined
      }
    >
      <button
        type="button"
        className={`houseleague-th-sort${active ? " houseleague-th-sort--active" : ""}`}
        onClick={() => onSort(column)}
      >
        {label}
        <span
          className={
            active
              ? "houseleague-th-sort__dir"
              : "houseleague-th-sort__dir houseleague-th-sort__dir--reserved"
          }
          aria-hidden
        >
          {active ? (dir === "asc" ? "↑" : "↓") : "↑"}
        </span>
      </button>
    </th>
  );
}

function groupPlayersByBox(
  players: BoxLeaguePlayer[],
): { boxLabel: string; sortKey: number; players: BoxLeaguePlayer[] }[] {
  const unassignedKey = Number.POSITIVE_INFINITY;
  const map = new Map<number, BoxLeaguePlayer[]>();

  for (const p of players) {
    const raw = p.level;
    const key =
      typeof raw === "number" &&
      Number.isFinite(raw) &&
      !Number.isNaN(raw)
        ? raw
        : unassignedKey;
    const arr = map.get(key) ?? [];
    arr.push(p);
    map.set(key, arr);
  }

  const entries = [...map.entries()].sort(([a], [b]) => {
    if (a === unassignedKey) return 1;
    if (b === unassignedKey) return -1;
    return a - b;
  });

  return entries.map(([boxNum, plist]) => ({
    boxLabel:
      boxNum === unassignedKey
        ? "Unassigned"
        : boxNum === 0
          ? "Unassigned Players"
          : `Box ${boxNum}`,
    sortKey: boxNum,
    players: plist.sort((x, y) => {
      const ra = x.playerCurrentRank ?? 0;
      const rb = y.playerCurrentRank ?? 0;
      if (ra !== rb) return ra - rb;
      const la = `${x.lastName} ${x.firstName}`;
      const lb = `${y.lastName} ${y.firstName}`;
      return la.localeCompare(lb, undefined, { sensitivity: "base" });
    }),
  }));
}

/** Row tint from GET players `prevBox` vs current `level` (players endpoint data only). */
function playerRowPrevBoxClass(
  prevBox: number,
  level: number,
): string | null {
  if (
    typeof prevBox !== "number" ||
    !Number.isFinite(prevBox) ||
    typeof level !== "number" ||
    !Number.isFinite(level)
  ) {
    return null;
  }
  if (prevBox === level) return null;
  if (prevBox === 0) return "houseleague-player-row--prev-box-zero";
  if (prevBox > level) return "houseleague-player-row--prev-box-gt-level";
  return "houseleague-player-row--prev-box-lt-level";
}

/** Build a roster row shaped like US Squash data for storing in local draft roster JSON. */
function clubMemberToDraftBoxPlayer(
  m: ClubMember,
  level: number,
  seatInBox: number,
): BoxLeaguePlayer {
  const rating =
    typeof m.ratingSingles === "number" && Number.isFinite(m.ratingSingles)
      ? m.ratingSingles
      : 0;
  return {
    id: m.ssmId,
    firstName: m.firstName,
    lastName: m.lastName,
    partnerId: null,
    partnerFirstName: null,
    partnerLastName: null,
    level,
    pointsSeason: 0,
    winsSeason: 0,
    lossesSeason: 0,
    prevBox: level,
    prevBoxRank: seatInBox,
    rating,
    partnerRating: null,
    playerCurrentRank: seatInBox,
  };
}

export type HouseleagueSelectedSeasonMeta = {
  id: string;
  name: string;
  status: string;
  clubYear: number | null;
  calendarSegment: string | null;
  /** When set on the seasons row or US Squash sync, inclusive local end calendar day. */
  endDate?: string | null;
  startMondayDate: string | null;
  houseLeagueEventId?: number | null;
};

export function HouseleaguePage({
  seasonId,
  seasonStartMondayISO,
  selectedBookingSeason,
  onSelectSeason,
  onSeasonsRefresh,
}: {
  seasonId: string;
  seasonStartMondayISO: string;
  selectedBookingSeason: HouseleagueSelectedSeasonMeta | null;
  onSelectSeason: (seasonId: string) => void;
  onSeasonsRefresh: () => Promise<void>;
}) {
  const { show, error } = useToast();
  const isDraftPrep = selectedBookingSeason?.status === "draft";

  const [pageTab, setPageTab] = useState<
    "booking" | "boxes" | "players" | "emails" | "seasonStart"
  >("booking");
  const [setupSidebarOpen, setSetupSidebarOpen] = useState(false);
  const [setupTab, setSetupTab] = useState<"schedule" | "statutory">(
    "schedule",
  );

  const [events, setEvents] = useState<BoxLeagueEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [selectedEventId, setSelectedEventId] = useState<string>("");

  const canEditLiveHouseLeagueRoster = useMemo(() => {
    const s = selectedBookingSeason;
    if (!s || !selectedEventId.trim()) return false;
    const linked = s.houseLeagueEventId;
    if (linked != null && String(linked) !== selectedEventId) return false;

    const ev = events.find((e) => String(e.eventId) === selectedEventId);
    if (ev && typeof ev.endDate === "string" && ev.endDate.trim() !== "") {
      return isUsSquashBoxLeagueRosterLocallyEditable({
        eventStartISO: ev.startDate,
        eventEndISO: ev.endDate,
        enforceStart: false,
      });
    }

    if (s.clubYear == null || s.calendarSegment == null) return false;
    if (
      !(BOOKING_CALENDAR_SEASONS as readonly string[]).includes(s.calendarSegment)
    ) {
      return false;
    }
    return isBookingCalendarSegmentLocallyActive({
      segment: s.calendarSegment as BookingCalendarSeason,
      clubYear: s.clubYear,
      explicitSeasonEndDate: s.endDate,
    });
  }, [events, selectedBookingSeason, selectedEventId]);

  /** Draft prep is always editable locally; live edits use US Squash event dates through `endDate`. */
  const rosterWritesEnabled = isDraftPrep || canEditLiveHouseLeagueRoster;

  const [players, setPlayers] = useState<BoxLeaguePlayer[]>([]);
  const [playersLoading, setPlayersLoading] = useState(false);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [playersPrevSeason, setPlayersPrevSeason] = useState<BoxLeaguePlayer[]>(
    [],
  );
  const [playersPrevLoading, setPlayersPrevLoading] = useState(false);
  const [playersPrevError, setPlayersPrevError] = useState<string | null>(null);
  const [playersListFilter, setPlayersListFilter] = useState<
    "thisSeason" | "newThisSeason" | "removedFromSeason"
  >("thisSeason");
  const [playersListSort, setPlayersListSort] = useState<{
    key: PlayersListSortKey;
    dir: PlayersListSortDir;
  }>({ key: "lastName", dir: "asc" });
  const [playerMoveError, setPlayerMoveError] = useState<string | null>(null);
  const [moveInFlight, setMoveInFlight] = useState(false);
  const [draggingPlayerId, setDraggingPlayerId] = useState<number | null>(
    null,
  );
  const [dropTargetLevel, setDropTargetLevel] = useState<number | null>(null);
  const [rosterDirty, setRosterDirty] = useState(false);
  const [rosterImpactOpen, setRosterImpactOpen] = useState(false);
  const [seasonStartDiffHasChanges, setSeasonStartDiffHasChanges] =
    useState(false);

  const showSeasonStartTab =
    !isDraftPrep && selectedBookingSeason?.houseLeagueEventId != null;

  const refreshSeasonStartDiff = useCallback(async () => {
    if (!seasonId || isDraftPrep || !selectedBookingSeason?.houseLeagueEventId) {
      setSeasonStartDiffHasChanges(false);
      return;
    }
    try {
      const res = await api<{ summary: { hasChanges: boolean } }>(
        `/api/seasons/${seasonId}/season-start-roster/diff`,
      );
      setSeasonStartDiffHasChanges(Boolean(res.summary?.hasChanges));
    } catch {
      setSeasonStartDiffHasChanges(false);
    }
  }, [isDraftPrep, seasonId, selectedBookingSeason?.houseLeagueEventId]);

  useEffect(() => {
    refreshSeasonStartDiff().catch(() => {
      /* optional */
    });
  }, [refreshSeasonStartDiff, players, pageTab]);

  const [draftPlayers, setDraftPlayers] = useState<BoxLeaguePlayer[]>([]);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);

  const [liveRosterMutating, setLiveRosterMutating] = useState(false);
  const [relativeRankOverrides, setRelativeRankOverrides] = useState<
    Map<number, number>
  >(new Map());
  const [rankOverridesSaving, setRankOverridesSaving] = useState(false);
  const [seasonStartPlayers, setSeasonStartPlayers] = useState<
    Pick<
      BoxLeaguePlayer,
      "id" | "level" | "playerCurrentRank" | "firstName" | "lastName"
    >[]
  >([]);

  useEffect(() => {
    if (!seasonId || isDraftPrep) {
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
        const parsed: typeof seasonStartPlayers = [];
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
  }, [isDraftPrep, seasonId]);

  useEffect(() => {
    if (!seasonId || isDraftPrep) {
      setRelativeRankOverrides(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ overrides: Record<string, number> }>(
          `/api/seasons/${seasonId}/house-league/relative-rank-overrides`,
        );
        if (cancelled) return;
        setRelativeRankOverrides(
          parseRelativeRankOverridesJson(JSON.stringify(res.overrides ?? {})),
        );
      } catch {
        if (!cancelled) setRelativeRankOverrides(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDraftPrep, seasonId]);

  const persistRelativeRankOverrides = useCallback(
    async (next: Map<number, number>) => {
      if (!seasonId) return;
      setRankOverridesSaving(true);
      setPlayerMoveError(null);
      try {
        const res = await api<{ overrides: Record<string, number> }>(
          `/api/seasons/${seasonId}/house-league/relative-rank-overrides?seasonId=${encodeURIComponent(
            seasonId,
          )}`,
          {
            method: "PUT",
            body: JSON.stringify({
              overrides: Object.fromEntries(
                [...next.entries()].map(([id, rr]) => [String(id), rr]),
              ),
            }),
          },
        );
        setRelativeRankOverrides(
          parseRelativeRankOverridesJson(JSON.stringify(res.overrides ?? {})),
        );
        setRosterDirty(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        error(msg);
        setPlayerMoveError(msg);
      } finally {
        setRankOverridesSaving(false);
      }
    },
    [error, seasonId],
  );

  const [clubMembers, setClubMembers] = useState<ClubMember[]>([]);

  const [createSeasonModalOpen, setCreateSeasonModalOpen] = useState(false);
  const [createSeasonName, setCreateSeasonName] = useState("");
  const [createSeasonStartMonday, setCreateSeasonStartMonday] = useState("");
  const [modalSourceHouseLeagueEventId, setModalSourceHouseLeagueEventId] =
    useState("");
  const [createSeasonBusy, setCreateSeasonBusy] = useState(false);
  const [addPlayerModalLevel, setAddPlayerModalLevel] = useState<number | null>(
    null,
  );
  const [addPlayerPickId, setAddPlayerPickId] = useState<number | null>(null);

  const [accountingMailOpen, setAccountingMailOpen] = useState(false);
  const [accountingMailTo, setAccountingMailTo] = useState("");
  const [accountingMailBody, setAccountingMailBody] = useState("");
  const [accountingMailSending, setAccountingMailSending] = useState(false);

  const prevSeasonIdRef = useRef<string | undefined>(undefined);

  const loadClubMembers = useCallback(async () => {
    try {
      const data = await api<ClubMember[]>("/api/club-members");
      setClubMembers(Array.isArray(data) ? data : []);
    } catch {
      setClubMembers([]);
    }
  }, []);

  useEffect(() => {
    loadClubMembers().catch(() => {
      /* ignore */
    });
  }, [loadClubMembers]);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsError(null);
    try {
      const data = await api<BoxLeagueEvent[]>("/api/houseleague/events");
      setEvents(Array.isArray(data) ? data : []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setEventsError(msg);
      setEvents([]);
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEvents().catch(() => {
      /* handled */
    });
  }, [loadEvents]);

  /** Newest `startDate` first so the dropdown order matches “latest default”. */
  const eventsForDropdown = useMemo(() => {
    return [...events].sort(
      (a, b) =>
        new Date(b.startDate).getTime() - new Date(a.startDate).getTime(),
    );
  }, [events]);

  /** Next older league in the dropdown (sorted newest-first) — used only for roster comparison on the Players tab. */
  const prevSeasonEventId = useMemo(() => {
    const idx = eventsForDropdown.findIndex(
      (e) => String(e.eventId) === selectedEventId,
    );
    if (idx < 0 || idx >= eventsForDropdown.length - 1) return "";
    return String(eventsForDropdown[idx + 1]!.eventId);
  }, [eventsForDropdown, selectedEventId]);

  useEffect(() => {
    setPlayersListFilter("thisSeason");
  }, [selectedEventId]);

  useEffect(() => {
    setPlayersListSort({ key: "lastName", dir: "asc" });
  }, [selectedEventId, playersListFilter]);

  useEffect(() => {
    if (eventsLoading || events.length === 0) return;
    const prev = prevSeasonIdRef.current;
    prevSeasonIdRef.current = seasonId;
    const seasonChanged = prev !== undefined && prev !== seasonId;

    setSelectedEventId((cur) => {
      const validCur = Boolean(
        cur && events.some((e) => String(e.eventId) === cur),
      );
      if (!seasonChanged && validCur) return cur;

      const stored =
        selectedBookingSeason?.houseLeagueEventId != null
          ? String(selectedBookingSeason.houseLeagueEventId)
          : "";
      if (stored && events.some((e) => String(e.eventId) === stored))
        return stored;
      return defaultLatestEventId(events);
    });
  }, [
    seasonId,
    eventsLoading,
    events,
    selectedBookingSeason?.houseLeagueEventId,
  ]);

  const onLeaguePickerChange = useCallback(
    async (eventId: string) => {
      setSelectedEventId(eventId);
      if (!seasonId) return;
      const n = Number(eventId);
      const body =
        eventId && Number.isFinite(n) && n > 0
          ? { houseLeagueEventId: n }
          : { houseLeagueEventId: null };
      try {
        await api(`/api/seasons/${seasonId}/house-league-event`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        await onSeasonsRefresh();
      } catch (e) {
        error(e instanceof Error ? e.message : String(e));
      }
    },
    [seasonId, onSeasonsRefresh, error],
  );

  const fetchHubEventPlayers = useCallback(async (eventId: string) => {
    const data = await api<BoxLeaguePlayer[]>(
      `/api/houseleague/events/${eventId}/players`,
    );
    return Array.isArray(data) ? data : [];
  }, []);

  const loadPlayers = useCallback(
    async (eventId: string) => {
      if (!eventId) {
        setPlayers([]);
        return;
      }
      setPlayersLoading(true);
      setPlayersError(null);
      try {
        const rows = await fetchHubEventPlayers(eventId);
        setPlayers(rows);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setPlayersError(msg);
        setPlayers([]);
      } finally {
        setPlayersLoading(false);
      }
    },
    [fetchHubEventPlayers],
  );

  const loadDraftRoster = useCallback(async () => {
    if (!seasonId || selectedBookingSeason?.status !== "draft") return;
    setDraftLoading(true);
    setDraftError(null);
    try {
      const res = await api<{ players: BoxLeaguePlayer[] | undefined }>(
        `/api/seasons/${seasonId}/draft-house-league-roster`,
      );
      setDraftPlayers(Array.isArray(res?.players) ? res.players : []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDraftError(msg);
      setDraftPlayers([]);
    } finally {
      setDraftLoading(false);
    }
  }, [seasonId, selectedBookingSeason?.status]);

  useEffect(() => {
    if (!isDraftPrep) {
      setDraftPlayers([]);
      setDraftError(null);
      return;
    }
    loadDraftRoster().catch(() => {
      /* handled */
    });
  }, [isDraftPrep, loadDraftRoster]);

  useEffect(() => {
    let cancelled = false;
    setPlayerMoveError(null);

    async function runPrev() {
      if (!prevSeasonEventId) {
        setPlayersPrevSeason([]);
        setPlayersPrevError(null);
        setPlayersPrevLoading(false);
        return;
      }
      setPlayersPrevLoading(true);
      setPlayersPrevError(null);
      try {
        const rows = await fetchHubEventPlayers(prevSeasonEventId);
        if (!cancelled) setPlayersPrevSeason(rows);
      } catch (e) {
        if (!cancelled) {
          setPlayersPrevError(e instanceof Error ? e.message : String(e));
          setPlayersPrevSeason([]);
        }
      } finally {
        if (!cancelled) setPlayersPrevLoading(false);
      }
    }

    async function runCurrent() {
      if (isDraftPrep || !selectedEventId) {
        setPlayers([]);
        setPlayersError(null);
        setPlayersLoading(false);
        return;
      }
      setPlayersLoading(true);
      setPlayersError(null);
      try {
        const rows = await fetchHubEventPlayers(selectedEventId);
        if (!cancelled) setPlayers(rows);
      } catch (e) {
        if (!cancelled) {
          setPlayersError(e instanceof Error ? e.message : String(e));
          setPlayers([]);
        }
      } finally {
        if (!cancelled) setPlayersLoading(false);
      }
    }

    void Promise.all([runCurrent(), runPrev()]);
    return () => {
      cancelled = true;
    };
  }, [fetchHubEventPlayers, isDraftPrep, prevSeasonEventId, selectedEventId]);

  const effectiveSeatOverrides = useMemo(
    () =>
      sanitizeSeatOverridesForGroundTruth(
        isDraftPrep ? draftPlayers : players,
        seasonStartPlayers,
        relativeRankOverrides,
      ),
    [draftPlayers, isDraftPrep, players, relativeRankOverrides, seasonStartPlayers],
  );

  useEffect(() => {
    if (
      isDraftPrep ||
      !seasonId ||
      playersLoading ||
      rankOverridesSaving ||
      players.length === 0 ||
      seasonStartPlayers.length === 0
    ) {
      return;
    }
    const same =
      relativeRankOverrides.size === effectiveSeatOverrides.size &&
      [...relativeRankOverrides.entries()].every(
        ([id, seat]) => effectiveSeatOverrides.get(id) === seat,
      );
    if (same) return;
    void persistRelativeRankOverrides(effectiveSeatOverrides);
  }, [
    effectiveSeatOverrides,
    isDraftPrep,
    persistRelativeRankOverrides,
    players.length,
    playersLoading,
    rankOverridesSaving,
    relativeRankOverrides,
    seasonId,
    seasonStartPlayers.length,
  ]);

  const displayPlayers = useMemo(() => {
    const raw = isDraftPrep ? draftPlayers : players;
    if (isDraftPrep) return raw;
    if (seasonStartPlayers.length > 0 || effectiveSeatOverrides.size > 0) {
      return applyAnchoredBoxSeatsToRoster(
        raw,
        seasonStartPlayers.length > 0 ? seasonStartPlayers : undefined,
        effectiveSeatOverrides,
      );
    }
    return raw;
  }, [
    draftPlayers,
    effectiveSeatOverrides,
    isDraftPrep,
    players,
    seasonStartPlayers,
  ]);

  const playerIdSetsForList = useMemo(() => {
    const currentIds = new Set(
      displayPlayers.filter((p) => p.id > 0).map((p) => p.id),
    );
    const prevIds = new Set(
      playersPrevSeason.filter((p) => p.id > 0).map((p) => p.id),
    );
    return { currentIds, prevIds };
  }, [displayPlayers, playersPrevSeason]);

  const playersListRows = useMemo(() => {
    const { currentIds, prevIds } = playerIdSetsForList;

    switch (playersListFilter) {
      case "thisSeason":
        return sortBoxLeaguePlayersByName(displayPlayers);
      case "newThisSeason": {
        if (!isDraftPrep && playersError) return [];
        if (
          prevSeasonEventId &&
          !playersPrevLoading &&
          playersPrevError
        ) {
          return [];
        }
        return sortBoxLeaguePlayersByName(
          displayPlayers.filter((p) => p.id > 0 && !prevIds.has(p.id)),
        );
      }
      case "removedFromSeason": {
        if (!isDraftPrep && playersError) return [];
        if (
          prevSeasonEventId &&
          !playersPrevLoading &&
          playersPrevError
        ) {
          return [];
        }
        return sortBoxLeaguePlayersByName(
          playersPrevSeason.filter((p) => p.id > 0 && !currentIds.has(p.id)),
        );
      }
      default:
        return [];
    }
  }, [
    displayPlayers,
    isDraftPrep,
    playerIdSetsForList,
    playersError,
    playersListFilter,
    playersPrevError,
    playersPrevLoading,
    playersPrevSeason,
    prevSeasonEventId,
  ]);

  const togglePlayersListSort = useCallback((key: PlayersListSortKey) => {
    setPlayersListSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }, []);

  const playersListRowsSorted = useMemo(() => {
    const rows = [...playersListRows];
    rows.sort((a, b) => {
      const c = comparePlayersListByColumn(
        a,
        b,
        playersListSort.key,
        playersListSort.dir,
      );
      return c !== 0 ? c : tieBreakPlayersListRows(a, b);
    });
    return rows;
  }, [playersListRows, playersListSort]);

  const openAccountingMailModal = useCallback(() => {
    const ev = eventsForDropdown.find(
      (e) => String(e.eventId) === selectedEventId,
    );
    const n = playersListRowsSorted.length;
    const title = ev?.eventName?.trim();
    const intro = title
      ? `Attached is a CSV (${n} player${n === 1 ? "" : "s"}) listing First name and Last name columns for "${title}".`
      : `Attached is a CSV (${n} player${n === 1 ? "" : "s"}) listing First name and Last name columns for this league event.`;

    setAccountingMailBody(`${intro}\n\n`);
    setAccountingMailOpen(true);
  }, [
    eventsForDropdown,
    selectedEventId,
    playersListRowsSorted,
  ]);

  const submitAccountingMail = useCallback(async () => {
    const to = accountingMailTo.trim();
    const bodyTxt = accountingMailBody.trim();

    if (!isAccountingRecipientEmail(accountingMailTo)) {
      error("Enter a valid recipient email.");
      return;
    }
    if (!bodyTxt) {
      error("Enter a message body.");
      return;
    }
    const rosterPayload = playersListRowsSorted.map((p) => ({
      firstName: p.firstName.trim(),
      lastName: p.lastName.trim(),
    }));

    setAccountingMailSending(true);
    try {
      await api<{ ok?: boolean }>("/api/houseleague/roster/send-accounting", {
        method: "POST",
        body: JSON.stringify({
          to,
          body: bodyTxt,
          seasonId,
          roster: rosterPayload,
        }),
      });
      show("Email sent.");
      setAccountingMailOpen(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error(`Could not send email: ${msg}`);
    } finally {
      setAccountingMailSending(false);
    }
  }, [
    accountingMailBody,
    accountingMailTo,
    playersListRowsSorted,
    seasonId,
    error,
    show,
  ]);

  const accountingRecipientValid = useMemo(
    () => isAccountingRecipientEmail(accountingMailTo),
    [accountingMailTo],
  );
  const accountingBodyNonEmpty = useMemo(
    () => accountingMailBody.trim().length > 0,
    [accountingMailBody],
  );

  const accountingMailto = useMemo(() => {
    const to = accountingMailTo.trim();
    const bodyTxt = accountingMailBody.trim();
    const n = playersListRowsSorted.length;
    if (!isAccountingRecipientEmail(accountingMailTo) || !bodyTxt || n === 0) {
      return { href: null as string | null, tooLongForMailto: false };
    }
    const subject = `House league roster (${n} players)`;
    const rosterPayload = playersListRowsSorted.map((p) => ({
      firstName: p.firstName.trim(),
      lastName: p.lastName.trim(),
    }));
    const csvText = houseLeagueRosterCsvText(rosterPayload);

    const build = (body: string) => {
      const params = new URLSearchParams();
      params.set("subject", subject);
      params.set("body", body);
      return `mailto:${encodeURIComponent(to)}?${params.toString()}`;
    };

    const csvNote =
      "Roster (save as .csv or copy into a spreadsheet — First name, Last name):\r\n";
    let body = `${bodyTxt}\r\n\r\n${csvNote}${csvText}`;
    let href = build(body);
    if (href.length > ACCOUNTING_MAILTO_MAX_URL_LENGTH) {
      body = `${bodyTxt}\r\n\r\nThe roster is too large to embed in a mailto link. Use “Send” above for a CSV attachment, or copy from the player table.`;
      href = build(body);
    }
    if (href.length > ACCOUNTING_MAILTO_MAX_URL_LENGTH) {
      return { href: null, tooLongForMailto: true };
    }
    return { href, tooLongForMailto: false };
  }, [accountingMailBody, accountingMailTo, playersListRowsSorted]);

  const playersListCurrentLoading = isDraftPrep
    ? draftLoading
    : Boolean(selectedEventId && playersLoading);
  const playersListComparisonLoading =
    Boolean(prevSeasonEventId) && playersPrevLoading;
  const playersListDataLoading =
    playersListFilter === "thisSeason"
      ? playersListCurrentLoading
      : playersListCurrentLoading ||
        (Boolean(prevSeasonEventId) && playersListComparisonLoading);

  const rosterExcludedSsmIds = useMemo(
    () =>
      new Set(displayPlayers.filter((p) => p.id > 0).map((p) => p.id)),
    [displayPlayers],
  );

  const relativeRankByPlayerId = useMemo(() => {
    const map = new Map<number, number>();
    const raw = isDraftPrep ? draftPlayers : players;
    const gt =
      !isDraftPrep && seasonStartPlayers.length > 0
        ? seasonStartPlayers
        : undefined;
    for (const p of displayPlayers) {
      if (typeof p.level !== "number" || !Number.isFinite(p.level)) continue;
      if (gt) {
        const seat = computeBoxSeatByPlayerId(
          p.level,
          raw,
          gt,
          effectiveSeatOverrides,
        ).get(p.id);
        if (seat != null) map.set(p.id, seat);
        continue;
      }
      const rr =
        !isDraftPrep && effectiveSeatOverrides.size > 0
          ? effectiveRelativeRankInBox(p, raw, effectiveSeatOverrides, gt)
          : typeof p.playerCurrentRank === "number" &&
              Number.isFinite(p.playerCurrentRank)
            ? relativeRankInBox(p.playerCurrentRank, p.level, displayPlayers)
            : null;
      if (rr != null) map.set(p.id, rr);
    }
    return map;
  }, [
    displayPlayers,
    draftPlayers,
    isDraftPrep,
    players,
    effectiveSeatOverrides,
    seasonStartPlayers,
  ]);

  const grouped = useMemo(() => {
    const base = groupPlayersByBox(displayPlayers);
    const rosterForSeats = isDraftPrep ? draftPlayers : players;
    const gt =
      !isDraftPrep && seasonStartPlayers.length > 0
        ? seasonStartPlayers
        : undefined;

    return base.map((group) => {
      if (!Number.isFinite(group.sortKey) || group.sortKey <= 0) {
        return {
          ...group,
          uiRows: group.players.map((p) => ({
            seat: relativeRankByPlayerId.get(p.id) ?? 0,
            player: p,
            open: false as const,
          })),
        };
      }

      if (gt) {
        const seatRows = buildBoxUiSeatRows(
          group.sortKey,
          rosterForSeats,
          gt,
          effectiveSeatOverrides,
        );
        const playerById = new Map(displayPlayers.map((p) => [p.id, p]));
        const uiRows = seatRows.map((row) => ({
          seat: row.seat,
          open: row.open,
          unassigned: row.unassigned,
          player: row.playerId != null ? playerById.get(row.playerId) : undefined,
        }));
        return {
          ...group,
          uiRows,
          players: uiRows
            .filter((r) => r.player)
            .map((r) => r.player!),
        };
      }

      const sorted =
        effectiveSeatOverrides.size > 0
          ? playersInBoxSortedByEffectiveRank(
              displayPlayers,
              group.sortKey,
              effectiveSeatOverrides,
              gt,
            )
          : group.players;
      return {
        ...group,
        players: sorted,
        uiRows: sorted.map((p) => ({
          seat: relativeRankByPlayerId.get(p.id) ?? 0,
          player: p,
          open: false as const,
        })),
      };
    });
  }, [
    displayPlayers,
    draftPlayers,
    isDraftPrep,
    players,
    relativeRankByPlayerId,
    effectiveSeatOverrides,
    seasonStartPlayers.length,
  ]);

  /** Cumulative `playerCurrentRank` from Club Locker (1…N across the league), before local seat overrides. */
  const clubLockerRankByPlayerId = useMemo(() => {
    const raw = isDraftPrep ? draftPlayers : players;
    const map = new Map<number, number>();
    for (const p of raw) {
      if (
        typeof p.playerCurrentRank === "number" &&
        Number.isFinite(p.playerCurrentRank)
      ) {
        map.set(p.id, p.playerCurrentRank);
      }
    }
    return map;
  }, [draftPlayers, isDraftPrep, players]);

  const boxesDataLoading = isDraftPrep
    ? draftLoading
    : Boolean(selectedEventId && playersLoading);

  const downloadBoxesCsv = useCallback(() => {
    if (displayPlayers.length === 0) return;
    const ev = eventsForDropdown.find(
      (e) => String(e.eventId) === selectedEventId,
    );
    const title = isDraftPrep
      ? selectedBookingSeason?.name?.trim() || "draft-roster"
      : ev?.eventName?.trim() || "house-league";
    const slug = title
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 48);
    const day = new Date().toISOString().slice(0, 10);
    const filename = `${slug || "house-league"}-boxes-${day}.csv`;
    const csv = houseLeagueBoxesCsvText(grouped, relativeRankByPlayerId);
    downloadTextFile(csv, filename);
    show("Downloaded boxes CSV.");
  }, [
    displayPlayers.length,
    eventsForDropdown,
    grouped,
    isDraftPrep,
    relativeRankByPlayerId,
    selectedBookingSeason?.name,
    selectedEventId,
    show,
  ]);

  const persistDraftRoster = useCallback(
    async (next: BoxLeaguePlayer[]) => {
      if (!seasonId) return;
      setDraftSaving(true);
      try {
        await api(`/api/seasons/${seasonId}/draft-house-league-roster`, {
          method: "PUT",
          body: JSON.stringify({
            players: next as unknown as Record<string, unknown>[],
          }),
        });
        setDraftPlayers(next);
      } catch (e) {
        error(e instanceof Error ? e.message : String(e));
      } finally {
        setDraftSaving(false);
      }
    },
    [seasonId, error],
  );

  const removeDraftPlayer = useCallback(
    async (playerId: number) => {
      const next = draftPlayers.filter((p) => p.id !== playerId);
      await persistDraftRoster(next);
    },
    [draftPlayers, persistDraftRoster],
  );

  const openCreateSeasonModal = useCallback(() => {
    const latestEv =
      selectedEventId && events.some((e) => String(e.eventId) === selectedEventId)
        ? selectedEventId
        : defaultLatestEventId(events);
    setModalSourceHouseLeagueEventId(latestEv);
    let nameDef = "New league season";
    let startDef = defaultBookingSeasonAndStartMonday().startMondayISO;
    const base = selectedBookingSeason;
    if (
      base?.calendarSegment &&
      (base.calendarSegment === "winter" ||
        base.calendarSegment === "spring" ||
        base.calendarSegment === "summer" ||
        base.calendarSegment === "fall") &&
      base.clubYear != null
    ) {
      const fol = bookingSeasonImmediatelyFollowing(
        base.calendarSegment as BookingCalendarSeason,
        base.clubYear,
      );
      nameDef = `${bookingCalendarSeasonLabel(fol.season)} ${fol.clubYear}`;
      startDef = fol.startMondayISO;
    } else {
      const d = defaultBookingSeasonAndStartMonday();
      nameDef = `${bookingCalendarSeasonLabel(d.season)} ${d.clubYear}`;
      startDef = d.startMondayISO;
    }
    setCreateSeasonName(nameDef);
    setCreateSeasonStartMonday(startDef);
    setCreateSeasonModalOpen(true);
  }, [events, selectedEventId, selectedBookingSeason]);

  const confirmCreateSeasonFromPrevious = useCallback(async () => {
    if (
      !selectedBookingSeason?.id ||
      !createSeasonName.trim() ||
      !createSeasonStartMonday.trim() ||
      !modalSourceHouseLeagueEventId
    )
      return;
    setCreateSeasonBusy(true);
    try {
      const res = await api<{
        seasonId: string;
        warning?: string;
      }>("/api/seasons/create-from-previous", {
        method: "POST",
        body: JSON.stringify({
          sourceSeasonId: selectedBookingSeason.id,
          sourceHouseLeagueEventId: modalSourceHouseLeagueEventId,
          name: createSeasonName.trim(),
          startMondayDate: createSeasonStartMonday.trim(),
        }),
      });
      if (res.warning) show(res.warning);
      await onSeasonsRefresh();
      onSelectSeason(res.seasonId);
      setCreateSeasonModalOpen(false);
      setPageTab("boxes");
      show(
        "Draft season created — review Boxes to remove anyone not returning.",
      );
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreateSeasonBusy(false);
    }
  }, [
    createSeasonName,
    createSeasonStartMonday,
    modalSourceHouseLeagueEventId,
    onSeasonsRefresh,
    onSelectSeason,
    selectedBookingSeason?.id,
    show,
    error,
  ]);

  const commitAddClubMemberToBox = useCallback(
    async (ssmChoice?: number | null) => {
      const idToUse =
        typeof ssmChoice === "number" && Number.isFinite(ssmChoice)
          ? ssmChoice
          : addPlayerPickId;
      if (addPlayerModalLevel === null || idToUse == null) return;
      const m = clubMembers.find((x) => x.ssmId === idToUse);
      if (!m) return;

      if (isDraftPrep) {
        const inBox =
          draftPlayers.filter(
            (p) =>
              typeof p.level === "number" &&
              Number.isFinite(p.level) &&
              p.level === addPlayerModalLevel,
          ).length + 1;
        const row = clubMemberToDraftBoxPlayer(m, addPlayerModalLevel, inBox);
        const next = [...draftPlayers.filter((p) => p.id !== row.id), row];
        await persistDraftRoster(next);
        setAddPlayerModalLevel(null);
        setAddPlayerPickId(null);
        return;
      }

      if (
        !canEditLiveHouseLeagueRoster ||
        !selectedEventId ||
        !seasonId
      )
        return;

      const ratingNum =
        typeof m.ratingSingles === "number" && Number.isFinite(m.ratingSingles)
          ? m.ratingSingles
          : undefined;

      setLiveRosterMutating(true);
      setPlayerMoveError(null);
      try {
        await api<{ ok: boolean }>(
          `/api/houseleague/events/${selectedEventId}/players?seasonId=${encodeURIComponent(
            seasonId,
          )}`,
          {
            method: "POST",
            body: JSON.stringify({
              level: addPlayerModalLevel,
              playerId: idToUse,
              firstName: m.firstName,
              lastName: m.lastName,
              ...(ratingNum != null ? { rating: ratingNum } : {}),
            }),
          },
        );
        await loadPlayers(selectedEventId);
        setRosterDirty(true);
        setAddPlayerModalLevel(null);
        setAddPlayerPickId(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        error(msg);
        setPlayerMoveError(msg);
      } finally {
        setLiveRosterMutating(false);
      }
    },
    [
      addPlayerModalLevel,
      addPlayerPickId,
      canEditLiveHouseLeagueRoster,
      clubMembers,
      draftPlayers,
      error,
      isDraftPrep,
      loadPlayers,
      persistDraftRoster,
      selectedEventId,
      seasonId,
    ],
  );

  const removeRegisteredPlayerLive = useCallback(
    async (playerId: number) => {
      if (!selectedEventId || !seasonId || !canEditLiveHouseLeagueRoster)
        return;
      setLiveRosterMutating(true);
      setPlayerMoveError(null);
      try {
        await api<{ ok: boolean }>(
          `/api/houseleague/events/${selectedEventId}/players/${playerId}?seasonId=${encodeURIComponent(
            seasonId,
          )}`,
          {
            method: "DELETE",
          },
        );
        await loadPlayers(selectedEventId);
        if (relativeRankOverrides.has(playerId)) {
          const pruned = new Map(relativeRankOverrides);
          pruned.delete(playerId);
          await persistRelativeRankOverrides(pruned);
        } else {
          setRosterDirty(true);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        error(msg);
        setPlayerMoveError(msg);
      } finally {
        setLiveRosterMutating(false);
      }
    },
    [
      canEditLiveHouseLeagueRoster,
      error,
      loadPlayers,
      persistRelativeRankOverrides,
      relativeRankOverrides,
      seasonId,
      selectedEventId,
    ],
  );

  const movePlayerToBox = useCallback(
    async (playerId: number, level: number) => {
      if (isDraftPrep) {
        setPlayerMoveError(null);
        const player = draftPlayers.find((x) => x.id === playerId);
        if (!player) return;
        const cur = player.level;
        const same =
          typeof cur === "number" && Number.isFinite(cur) && cur === level;
        if (same) return;
        const next = draftPlayers.map((p) =>
          p.id === playerId ? { ...p, level, prevBox: level } : p,
        );
        await persistDraftRoster(next);
        return;
      }

      if (!canEditLiveHouseLeagueRoster || !seasonId || !selectedEventId)
        return;

      setPlayerMoveError(null);
      setMoveInFlight(true);
      try {
        await api<{ ok: boolean }>(
          `/api/houseleague/events/${selectedEventId}/players/${playerId}?seasonId=${encodeURIComponent(
            seasonId,
          )}`,
          {
            method: "PUT",
            body: JSON.stringify({ level }),
          },
        );
        await loadPlayers(selectedEventId);
        if (relativeRankOverrides.has(playerId)) {
          const pruned = new Map(relativeRankOverrides);
          pruned.delete(playerId);
          await persistRelativeRankOverrides(pruned);
        } else {
          setRosterDirty(true);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setPlayerMoveError(msg);
      } finally {
        setMoveInFlight(false);
      }
    },
    [
      canEditLiveHouseLeagueRoster,
      draftPlayers,
      isDraftPrep,
      loadPlayers,
      persistDraftRoster,
      persistRelativeRankOverrides,
      relativeRankOverrides,
      seasonId,
      selectedEventId,
    ],
  );

  const reorderPlayerInBox = useCallback(
    async (playerId: number, direction: "up" | "down") => {
      if (isDraftPrep) {
        const next = reorderPlayerWithinBoxByCurrentRank(
          draftPlayers,
          playerId,
          direction,
        );
        if (!next) return;
        await persistDraftRoster(next);
        return;
      }

      if (!canEditLiveHouseLeagueRoster || !seasonId) return;
      const nextOverrides = reorderRelativeRankInBox(
        players,
        effectiveSeatOverrides,
        playerId,
        direction,
        seasonStartPlayers.length > 0 ? seasonStartPlayers : undefined,
      );
      if (!nextOverrides) return;
      await persistRelativeRankOverrides(nextOverrides);
    },
    [
      canEditLiveHouseLeagueRoster,
      draftPlayers,
      isDraftPrep,
      persistDraftRoster,
      persistRelativeRankOverrides,
      players,
      effectiveSeatOverrides,
      seasonId,
      seasonStartPlayers,
    ],
  );

  useEffect(() => {
    if (addPlayerModalLevel !== null) setAddPlayerPickId(null);
  }, [addPlayerModalLevel]);

  useEffect(() => {
    if (!setupSidebarOpen) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setSetupSidebarOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setupSidebarOpen]);

  const bookingDevLog = useCallback((_message: string) => {
    /* App previously used silent dev log for booking payloads */
  }, []);

  return (
    <div className="houseleague-page">
      <h1 className="houseleague-page-title">Houseleague</h1>

      <div className="houseleague-page-toolbar">
        <div className="houseleague-page-toolbar-tabs">
          <div className="houseleague-toolbar-tab-strip">
            <div
              className="houseleague-page-tabs"
              role="tablist"
              aria-label="Houseleague"
            >
              <button
                type="button"
                role="tab"
                id="tab-houseleague-booking"
                aria-selected={pageTab === "booking"}
                aria-controls="panel-houseleague-booking"
                className={pageTab === "booking" ? "is-active" : ""}
                onClick={() => setPageTab("booking")}
              >
                <HouseleagueTabLabel icon={LayoutGrid}>
                  Court booking
                </HouseleagueTabLabel>
              </button>
              <button
                type="button"
                role="tab"
                id="tab-houseleague-boxes"
                aria-selected={pageTab === "boxes"}
                aria-controls="panel-houseleague-boxes"
                className={pageTab === "boxes" ? "is-active" : ""}
                onClick={() => setPageTab("boxes")}
              >
                <HouseleagueTabLabel icon={Grid3x3}>Boxes</HouseleagueTabLabel>
              </button>
              <button
                type="button"
                role="tab"
                id="tab-houseleague-players"
                aria-selected={pageTab === "players"}
                aria-controls="panel-houseleague-players"
                className={pageTab === "players" ? "is-active" : ""}
                onClick={() => setPageTab("players")}
              >
                <HouseleagueTabLabel icon={Users}>Players</HouseleagueTabLabel>
              </button>
              <button
                type="button"
                role="tab"
                id="tab-houseleague-emails"
                aria-selected={pageTab === "emails"}
                aria-controls="panel-houseleague-emails"
                className={pageTab === "emails" ? "is-active" : ""}
                onClick={() => setPageTab("emails")}
              >
                <HouseleagueTabLabel icon={Mail}>Emails</HouseleagueTabLabel>
              </button>
              {showSeasonStartTab ? (
                <button
                  type="button"
                  role="tab"
                  id="tab-houseleague-season-start"
                  aria-selected={pageTab === "seasonStart"}
                  aria-controls="panel-houseleague-season-start"
                  className={pageTab === "seasonStart" ? "is-active" : ""}
                  onClick={() => setPageTab("seasonStart")}
                >
                  <HouseleagueTabLabel icon={History}>
                    Season start
                  </HouseleagueTabLabel>
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="houseleague-toolbar-actions">
          <div className="row houseleague-header-controls houseleague-setup-shell">
            {pageTab === "boxes" && isDraftPrep ? (
              <span className="houseleague-status houseleague-status--muted">
                Draft roster tied to the current booking season — finalized US Squash
                event plugs in upstream when you promote this season.
              </span>
            ) : (
              <LeagueEventPicker
                events={eventsForDropdown}
                value={selectedEventId}
                onChange={(id) => {
                  void onLeaguePickerChange(id);
                }}
                disabled={eventsLoading}
                leadingAction={
                  pageTab === "boxes" && !isDraftPrep
                    ? {
                        label: "Create season from previous…",
                        onSelect: () => {
                          if (!selectedBookingSeason?.id) {
                            error(
                              "No booking season context to copy from. Reload after seasons load, or check the API.",
                            );
                            return;
                          }
                          openCreateSeasonModal();
                        },
                      }
                    : undefined
                }
              />
            )}
            <button
              type="button"
              className="secondary houseleague-setup-open"
              onClick={() => setSetupSidebarOpen(true)}
            >
              Setup
            </button>
          </div>
        </div>
      </div>

      {pageTab === "boxes" ? (
        <div
          id="panel-houseleague-boxes"
          role="tabpanel"
          aria-labelledby="tab-houseleague-boxes"
        >
          {isDraftPrep ? (
            <div className="houseleague-banner" role="status">
              <strong>Draft roster for your next booking segment.</strong> Remove anyone
              not returning or move them between boxes — when the season opens for
              play, standings here reset.
            </div>
          ) : null}

          {!isDraftPrep &&
          selectedBookingSeason &&
          !canEditLiveHouseLeagueRoster ? (
            <div className="houseleague-banner" role="status">
              <strong>Roster read-only.</strong> Live edits stay open until the advertised
              US Squash league <strong>end date</strong> (you can organise before kick-off),
              and only when this booking season&apos;s linked league matches what you chose
              in the picker. If metadata isn&apos;t loaded yet or the window has ended, use{' '}
              <em>Create season from previous…</em> to work in a draft.
            </div>
          ) : null}

          {eventsError ? (
            <div
              className="houseleague-banner houseleague-banner--error"
              role="alert"
            >
              <strong>Could not load league events.</strong> {eventsError}
            </div>
          ) : null}

          {!isDraftPrep && playersError ? (
            <div
              className="houseleague-banner houseleague-banner--error"
              role="alert"
            >
              <strong>Could not load players.</strong> {playersError}
            </div>
          ) : null}

          {draftError ? (
            <div
              className="houseleague-banner houseleague-banner--error"
              role="alert"
            >
              <strong>Could not load draft roster.</strong> {draftError}
            </div>
          ) : null}

          {playerMoveError ? (
            <div
              className="houseleague-banner houseleague-banner--error"
              role="alert"
            >
              <strong>Could not update roster.</strong> {playerMoveError}
            </div>
          ) : null}

          {!isDraftPrep &&
          rosterWritesEnabled &&
          selectedBookingSeason?.houseLeagueEventId ? (
            <div className="houseleague-banner roster-impact-banner" role="status">
              {rosterDirty ? (
                <strong>Roster changed.</strong>
              ) : seasonStartDiffHasChanges ? (
                <strong>Roster differs from season-start ground truth.</strong>
              ) : (
                <strong>Roster impact.</strong>
              )}{" "}
              Court bookings (boxes 1–16) and weekly emails may be out of date after
              adds, removals, or moves.{" "}
              <button
                type="button"
                className="link-button roster-impact-open-btn"
                onClick={() => setRosterImpactOpen(true)}
              >
                Review roster impact
              </button>
            </div>
          ) : null}

          {!isDraftPrep &&
          !rosterWritesEnabled &&
          seasonStartDiffHasChanges &&
          selectedBookingSeason?.houseLeagueEventId ? (
            <div className="houseleague-banner roster-impact-banner" role="status">
              <strong>Roster differs from season-start ground truth.</strong> Court
              bookings may need updates to match Club Locker.{" "}
              <button
                type="button"
                className="link-button roster-impact-open-btn"
                onClick={() => setRosterImpactOpen(true)}
              >
                Review roster impact
              </button>
            </div>
          ) : null}

          {isDraftPrep && draftLoading ? (
            <p className="houseleague-status">Loading draft roster…</p>
          ) : !isDraftPrep && selectedEventId && playersLoading ? (
            <p className="houseleague-status">Loading registrants…</p>
          ) : null}

          {!selectedEventId && !eventsLoading && events.length === 0 ? (
            <p className="houseleague-status houseleague-status--muted">
              No league events to display.
            </p>
          ) : null}

          {!isDraftPrep &&
          selectedEventId &&
          !playersLoading &&
          players.length === 0 &&
          !playersError ? (
            <p className="houseleague-status houseleague-status--muted">
              No players returned for this event.
            </p>
          ) : null}

          {isDraftPrep &&
          !draftLoading &&
          displayPlayers.length === 0 &&
          !draftError ? (
            <p className="houseleague-status houseleague-status--muted">
              No draft players yet — use Create season from previous (with an event
              selected in the popup) to copy registrants here.
            </p>
          ) : null}

          {!boxesDataLoading && displayPlayers.length > 0 ? (
            <div className="houseleague-boxes-toolbar houseleague-player-list-toolbar">
              <div className="houseleague-player-list-toolbar-right">
                <div className="houseleague-player-list-count" aria-live="polite">
                  <strong>{displayPlayers.length}</strong>{" "}
                  {displayPlayers.length === 1 ? "player" : "players"} across{" "}
                  <strong>{grouped.length}</strong>{" "}
                  {grouped.length === 1 ? "box" : "boxes"}
                </div>
                <button
                  type="button"
                  className="secondary houseleague-player-list-email-btn statutory-holidays-icon-btn"
                  title="Download all boxes as CSV"
                  disabled={displayPlayers.length === 0}
                  onClick={downloadBoxesCsv}
                >
                  <Download size={18} strokeWidth={2} aria-hidden />
                  <span className="houseleague-player-list-email-btn-label">
                    Download CSV
                  </span>
                </button>
              </div>
            </div>
          ) : null}

          <div className="houseleague-box-grid">
            {grouped.map((group) => {
              const droppable =
                rosterWritesEnabled && Number.isFinite(group.sortKey);
              const canReorderInBox = droppable && group.sortKey > 0;
              const dropHover =
                droppable && dropTargetLevel === group.sortKey;
              return (
              <section
                key={`${group.sortKey}-${group.boxLabel}`}
                className="card houseleague-box-card"
                onDragOver={
                  droppable
                    ? (e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setDropTargetLevel(group.sortKey);
                      }
                    : undefined
                }
                onDragLeave={
                  droppable
                    ? (e) => {
                        if (
                          !e.currentTarget.contains(
                            e.relatedTarget as Node,
                          )
                        ) {
                          setDropTargetLevel((cur) =>
                            cur === group.sortKey ? null : cur,
                          );
                        }
                      }
                    : undefined
                }
                onDrop={
                  droppable
                    ? (e) => {
                        e.preventDefault();
                        setDropTargetLevel(null);
                        const raw = e.dataTransfer.getData("text/plain");
                        const pid = Number(raw);
                        if (!Number.isFinite(pid)) return;
                        const targetLevel = group.sortKey;
                        const player = displayPlayers.find((x) => x.id === pid);
                        if (!player) return;
                        const cur = player.level;
                        const same =
                          typeof cur === "number" &&
                          Number.isFinite(cur) &&
                          cur === targetLevel;
                        if (same) return;
                        movePlayerToBox(pid, targetLevel).catch(() => {
                          /* handled in movePlayerToBox */
                        });
                      }
                    : undefined
                }
              >
                <div className="houseleague-box-heading-row">
                  <h2 className="houseleague-box-title">{group.boxLabel}</h2>
                  {rosterWritesEnabled ? (
                    <button
                      type="button"
                      className="secondary houseleague-box-add-player-btn"
                      title="Add player to this box"
                      aria-label={`Add player to ${group.boxLabel}`}
                      disabled={
                        !seasonId ||
                        (isDraftPrep
                          ? draftLoading || draftSaving
                          : playersLoading ||
                            liveRosterMutating ||
                            moveInFlight)
                      }
                      onClick={() =>
                        setAddPlayerModalLevel(
                          Number.isFinite(group.sortKey) ? group.sortKey : 0,
                        )
                      }
                    >
                      <Plus size={18} strokeWidth={2} aria-hidden />
                    </button>
                  ) : null}
                </div>
                <p className="houseleague-box-meta">
                  {group.players.length} player
                  {group.players.length === 1 ? "" : "s"}
                </p>
                <div
                  className={`houseleague-table-wrap${dropHover ? " houseleague-table-wrap--drop-hover" : ""}`}
                >
                  <table className="houseleague-table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Rating</th>
                        <th scope="col">W–L</th>
                        <th scope="col">Pts</th>
                        <th
                          scope="col"
                          className="houseleague-table-col--rank"
                          title="Club Locker cumulative rank (1 through N across the league)"
                        >
                          CL
                        </th>
                        <th
                          scope="col"
                          className="houseleague-table-col--rank"
                          title={
                            seasonStartPlayers.length > 0 && !isDraftPrep
                              ? "Season-start seat (1–6); vacant slots stay open"
                              : "Relative rank within box (seat 1–6)"
                          }
                        >
                          RR
                        </th>
                        {canReorderInBox ? (
                          <th scope="col" className="season-start-order-col">
                            Order
                          </th>
                        ) : null}
                        {rosterWritesEnabled ? <th scope="col" /> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {(group.uiRows ?? group.players.map((p) => ({
                        seat: relativeRankByPlayerId.get(p.id) ?? 0,
                        player: p,
                        open: false as const,
                      }))).map((row) => {
                        if (row.open || !row.player) {
                          return (
                            <tr
                              key={`open-${group.sortKey}-${row.seat}`}
                              className="houseleague-player-row houseleague-player-row--open-slot"
                            >
                              <td className="houseleague-name houseleague-name--open">
                                {OPEN_BOX_SEAT_LABEL}
                              </td>
                              <td>—</td>
                              <td>—</td>
                              <td>—</td>
                              <td className="houseleague-table-col--rank">—</td>
                              <td className="houseleague-table-col--rank">
                                {row.seat}
                              </td>
                              {canReorderInBox ? (
                                <td className="season-start-order-col" />
                              ) : null}
                              {rosterWritesEnabled ? <td /> : null}
                            </tr>
                          );
                        }

                        const p = row.player;
                        const seat = row.seat;
                        const isUnassigned = Boolean(
                          "unassigned" in row && row.unassigned,
                        );
                        const gtAnchored =
                          !isDraftPrep &&
                          seasonStartPlayers.length > 0 &&
                          Number.isFinite(group.sortKey) &&
                          group.sortKey > 0;
                        const returningGt =
                          gtAnchored &&
                          isReturningSeasonStartPlayerInBox(
                            p.id,
                            group.sortKey,
                            seasonStartPlayers,
                          );
                        let disableMoveUp =
                          isDraftPrep || returningGt
                            ? seat <= 1
                            : seat <= 1;
                        let disableMoveDown =
                          isDraftPrep || returningGt
                            ? seat >= 6
                            : seat >= 6;
                        if (gtAnchored && !returningGt && !isDraftPrep) {
                          const vacant = assignableVacantSeasonStartSeats(
                            group.sortKey,
                            players,
                            seasonStartPlayers,
                            effectiveSeatOverrides,
                          );
                          const assignedSeat =
                            effectiveSeatOverrides.get(p.id) ?? null;
                          if (isUnassigned || assignedSeat == null) {
                            disableMoveUp = vacant.length === 0;
                            disableMoveDown = true;
                          } else {
                            disableMoveUp = !vacant.some(
                              (s) => s < assignedSeat,
                            );
                            disableMoveDown = false;
                          }
                        } else if (returningGt) {
                          disableMoveUp = true;
                          disableMoveDown = true;
                        }
                        return (
                        <tr
                          key={isUnassigned ? `unassigned-${p.id}` : p.id}
                          className={[
                            "houseleague-player-row",
                            isUnassigned
                              ? "houseleague-player-row--unassigned"
                              : "",
                            draggingPlayerId === p.id
                              ? "houseleague-player-row--dragging"
                              : "",
                            !isDraftPrep
                              ? playerRowPrevBoxClass(p.prevBox, p.level) ?? ""
                              : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          draggable={
                            rosterWritesEnabled &&
                            Boolean(seasonId) &&
                            !rankOverridesSaving &&
                            (isDraftPrep
                              ? !draftLoading && !draftSaving
                              : Boolean(selectedEventId) &&
                                !moveInFlight &&
                                !playersLoading &&
                                !liveRosterMutating)
                          }
                          title={
                            rosterWritesEnabled
                              ? "Drag to another box to change assignment"
                              : "Roster edits are only available for draft seasons or while this booking segment is active"
                          }
                          onDragStart={(e) => {
                            setDraggingPlayerId(p.id);
                            e.dataTransfer.setData(
                              "text/plain",
                              String(p.id),
                            );
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onDragEnd={() => {
                            setDraggingPlayerId(null);
                            setDropTargetLevel(null);
                          }}
                        >
                          <td className="houseleague-name">
                            {p.firstName.trim()} {p.lastName.trim()}
                          </td>
                          <td>
                            {typeof p.rating === "number" &&
                            !Number.isNaN(p.rating)
                              ? p.rating.toFixed(2)
                              : "—"}
                          </td>
                          <td>
                            {p.winsSeason}-{p.lossesSeason}
                          </td>
                          <td>{p.pointsSeason}</td>
                          <td className="houseleague-table-col--rank">
                            {clubLockerRankByPlayerId.get(p.id) ?? "—"}
                          </td>
                          <td className="houseleague-table-col--rank">
                            {isUnassigned
                              ? "—"
                              : seat || (relativeRankByPlayerId.get(p.id) ?? "—")}
                          </td>
                          {canReorderInBox ? (
                            <td className="season-start-order-col">
                              <div
                                className="season-start-player-order-btns"
                                role="group"
                                aria-label={`Reorder ${p.firstName.trim()} ${p.lastName.trim()}`}
                              >
                                <button
                                  type="button"
                                  className="secondary season-start-order-btn"
                                  title={
                                    gtAnchored && !returningGt && isUnassigned
                                      ? "Assign to lowest open season-start seat"
                                      : "Move up in box"
                                  }
                                  aria-label={`Move ${p.firstName.trim()} ${p.lastName.trim()} up`}
                                  disabled={
                                    isDraftPrep
                                      ? draftSaving ||
                                        draftLoading ||
                                        disableMoveUp
                                      : playersLoading ||
                                        liveRosterMutating ||
                                        moveInFlight ||
                                        rankOverridesSaving ||
                                        disableMoveUp
                                  }
                                  onClick={() =>
                                    reorderPlayerInBox(p.id, "up").catch(
                                      () => {},
                                    )
                                  }
                                >
                                  <ChevronUp
                                    size={16}
                                    strokeWidth={2}
                                    aria-hidden
                                  />
                                </button>
                                <button
                                  type="button"
                                  className="secondary season-start-order-btn"
                                  title={
                                    gtAnchored && !returningGt && !isUnassigned
                                      ? "Move to next open season-start seat or unassign"
                                      : "Move down in box"
                                  }
                                  aria-label={`Move ${p.firstName.trim()} ${p.lastName.trim()} down`}
                                  disabled={
                                    isDraftPrep
                                      ? draftSaving ||
                                        draftLoading ||
                                        disableMoveDown
                                      : playersLoading ||
                                        liveRosterMutating ||
                                        moveInFlight ||
                                        rankOverridesSaving ||
                                        disableMoveDown
                                  }
                                  onClick={() =>
                                    reorderPlayerInBox(p.id, "down").catch(
                                      () => {},
                                    )
                                  }
                                >
                                  <ChevronDown
                                    size={16}
                                    strokeWidth={2}
                                    aria-hidden
                                  />
                                </button>
                              </div>
                            </td>
                          ) : null}
                          {rosterWritesEnabled ? (
                            <td>
                              <button
                                type="button"
                                className="secondary"
                                title={`Remove ${p.firstName.trim()} ${p.lastName.trim()}`}
                                aria-label={`Remove ${p.firstName.trim()} ${p.lastName.trim()}`}
                                disabled={
                                  isDraftPrep
                                    ? draftSaving || draftLoading
                                    : playersLoading ||
                                      liveRosterMutating ||
                                      moveInFlight ||
                                      rankOverridesSaving
                                }
                                onClick={() => {
                                  const displayName =
                                    `${p.firstName.trim()} ${p.lastName.trim()}`.trim() ||
                                    "this player";
                                  const msg = isDraftPrep
                                    ? `Remove ${displayName} from this season's draft roster?`
                                    : `Remove ${displayName} from this box league? This will update the roster on US Squash.`;
                                  if (!window.confirm(msg)) return;
                                  if (isDraftPrep) {
                                    removeDraftPlayer(p.id).catch(() => {
                                      /* handled */
                                    });
                                  } else {
                                    removeRegisteredPlayerLive(p.id).catch(
                                      () => {
                                        /* handled */
                                      },
                                    );
                                  }
                                }}
                              >
                                <Trash2 size={16} strokeWidth={2} aria-hidden />
                              </button>
                            </td>
                          ) : null}
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
            })}
          </div>
        </div>
      ) : pageTab === "players" ? (
        <div
          id="panel-houseleague-players"
          role="tabpanel"
          aria-labelledby="tab-houseleague-players"
        >
          <p className="houseleague-lead houseleague-lead--page">
            Rosters below follow the league selected above. Comparisons treat the{' '}
            <strong>next older event</strong> in that dropdown (same order) as the
            previous season.
          </p>

          {eventsError ? (
            <div
              className="houseleague-banner houseleague-banner--error"
              role="alert"
            >
              <strong>Could not load league events.</strong> {eventsError}
            </div>
          ) : null}

          {!isDraftPrep && playersError ? (
            <div
              className="houseleague-banner houseleague-banner--error"
              role="alert"
            >
              <strong>Could not load current league roster.</strong> {playersError}
            </div>
          ) : null}

          {playersPrevError ? (
            <div
              className="houseleague-banner houseleague-banner--error"
              role="alert"
            >
              <strong>Could not load roster for comparison season.</strong>{" "}
              {playersPrevError}
            </div>
          ) : null}

          {draftError ? (
            <div
              className="houseleague-banner houseleague-banner--error"
              role="alert"
            >
              <strong>Could not load draft roster.</strong> {draftError}
            </div>
          ) : null}

          <div className="houseleague-player-list-toolbar">
            <label className="houseleague-player-list-filter">
              <span className="houseleague-player-list-filter-label">
                Show
              </span>
              <select
                className="houseleague-player-list-select"
                value={playersListFilter}
                onChange={(ev) =>
                  setPlayersListFilter(ev.target.value as typeof playersListFilter)
                }
                aria-label="Filter player list"
              >
                <option value="thisSeason">This season</option>
                <option value="newThisSeason">New this season</option>
                <option value="removedFromSeason">
                  Removed from this season
                </option>
              </select>
            </label>
            {selectedEventId && !playersListDataLoading ? (
              <div className="houseleague-player-list-toolbar-right">
                <div className="houseleague-player-list-count" aria-live="polite">
                  <strong>{playersListRows.length}</strong>{" "}
                  {playersListRows.length === 1 ? "player" : "players"}
                </div>
                <button
                  type="button"
                  className="houseleague-player-list-email-btn statutory-holidays-icon-btn"
                  title="Email roster to accounting (CSV attachment)"
                  disabled={playersListRows.length === 0}
                  onClick={openAccountingMailModal}
                >
                  <Mail size={18} strokeWidth={2} aria-hidden />
                  <span className="houseleague-player-list-email-btn-label">
                    Email list
                  </span>
                </button>
              </div>
            ) : null}
          </div>

          {!prevSeasonEventId &&
          events.length > 0 &&
          selectedEventId &&
          (playersListFilter === "newThisSeason" ||
            playersListFilter === "removedFromSeason") ? (
            <p className="houseleague-status houseleague-status--muted">
              No older league is available after the selection in this list, so newcomer
              and removal filters have nothing to compare against.
            </p>
          ) : null}

          {playersListDataLoading ? (
            <p className="houseleague-status">Loading players…</p>
          ) : !selectedEventId && !eventsLoading && events.length === 0 ? (
            <p className="houseleague-status houseleague-status--muted">
              No league events to display.
            </p>
          ) : !selectedEventId ? (
            <p className="houseleague-status houseleague-status--muted">
              Choose a league event to load its roster.
            </p>
          ) : playersListRows.length === 0 &&
            !playersListDataLoading &&
            !(isDraftPrep && draftLoading) &&
            !(selectedEventId && !isDraftPrep && playersLoading) &&
            !(prevSeasonEventId && playersPrevLoading) ? (
            <p className="houseleague-status houseleague-status--muted">
              {playersListFilter === "thisSeason"
                ? "No players in this roster yet."
                : playersListFilter === "newThisSeason"
                  ? "No players flagged as new relative to the previous league."
                  : "No players missing from this season who were on the previous league."}
            </p>
          ) : !playersListDataLoading &&
            playersListRows.length > 0 ? (
            <div className="houseleague-player-list-frame">
              <div className="houseleague-player-list-scroll">
                <table className="houseleague-table houseleague-player-list-table">
                  <colgroup>
                    <col className="houseleague-player-list-col houseleague-player-list-col--first" />
                    <col className="houseleague-player-list-col houseleague-player-list-col--last" />
                    <col className="houseleague-player-list-col houseleague-player-list-col--box" />
                    <col className="houseleague-player-list-col houseleague-player-list-col--rating" />
                    <col className="houseleague-player-list-col houseleague-player-list-col--wl" />
                    <col className="houseleague-player-list-col houseleague-player-list-col--pts" />
                  </colgroup>
                  <thead>
                    <tr>
                      <PlayersListSortableTh
                        label="First name"
                        column="firstName"
                        activeKey={playersListSort.key}
                        dir={playersListSort.dir}
                        onSort={togglePlayersListSort}
                      />
                      <PlayersListSortableTh
                        label="Last name"
                        column="lastName"
                        activeKey={playersListSort.key}
                        dir={playersListSort.dir}
                        onSort={togglePlayersListSort}
                      />
                      <PlayersListSortableTh
                        label="Box"
                        column="level"
                        activeKey={playersListSort.key}
                        dir={playersListSort.dir}
                        onSort={togglePlayersListSort}
                      />
                      <PlayersListSortableTh
                        label="Rating"
                        column="rating"
                        activeKey={playersListSort.key}
                        dir={playersListSort.dir}
                        onSort={togglePlayersListSort}
                      />
                      <th scope="col">W–L</th>
                      <PlayersListSortableTh
                        label="Pts"
                        column="points"
                        activeKey={playersListSort.key}
                        dir={playersListSort.dir}
                        onSort={togglePlayersListSort}
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {playersListRowsSorted.map((p) => (
                      <tr
                        key={`${playersListFilter}-${p.id}`}
                        className="houseleague-player-row"
                      >
                        <td className="houseleague-name">
                          {p.firstName.trim() || "—"}
                        </td>
                        <td className="houseleague-name">
                          {p.lastName.trim() || "—"}
                        </td>
                        <td>
                          {typeof p.level === "number" &&
                          Number.isFinite(p.level)
                            ? p.level
                            : "—"}
                        </td>
                        <td>
                          {typeof p.rating === "number" &&
                          !Number.isNaN(p.rating)
                            ? p.rating.toFixed(2)
                            : "—"}
                        </td>
                        <td>
                          {p.winsSeason}-{p.lossesSeason}
                        </td>
                        <td>{p.pointsSeason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      ) : pageTab === "seasonStart" && showSeasonStartTab ? (
        <SeasonStartRosterPage
          seasonId={seasonId}
          seasonName={selectedBookingSeason?.name ?? ""}
          clubMembers={clubMembers}
          onDiffChange={(hasChanges) => {
            setSeasonStartDiffHasChanges(hasChanges);
          }}
          onOpenRosterImpact={() => setRosterImpactOpen(true)}
        />
      ) : pageTab === "emails" ? (
        <div
          id="panel-houseleague-emails"
          role="tabpanel"
          aria-labelledby="tab-houseleague-emails"
        >
          <EmailsPage
            onLog={show}
            templateScope="house_league"
            showPageHeading={false}
            linkedSeasonId={seasonId}
          />
        </div>
      ) : pageTab === "booking" ? (
        <div
          id="panel-houseleague-booking"
          role="tabpanel"
          aria-labelledby="tab-houseleague-booking"
        >
          <BookingPage
            seasonId={seasonId}
            seasonStartMondayISO={seasonStartMondayISO}
            boxLeaguePlayers={displayPlayers}
            onLog={bookingDevLog}
          />
        </div>
      ) : null}

      <RosterImpactReview
        seasonId={seasonId}
        open={rosterImpactOpen}
        onClose={() => setRosterImpactOpen(false)}
        weekFilter="current_and_future"
        onApplied={() => {
          setRosterDirty(false);
          refreshSeasonStartDiff().catch(() => {});
        }}
      />

      {setupSidebarOpen ? (
        <div
          className="houseleague-setup-sidebar-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget) setSetupSidebarOpen(false);
          }}
        >
          <aside
            className="houseleague-setup-sidebar"
            role="dialog"
            aria-modal="true"
            aria-labelledby="houseleague-setup-sidebar-title"
            onMouseDown={(ev) => ev.stopPropagation()}
          >
            <div className="houseleague-setup-sidebar-top">
              <h2
                id="houseleague-setup-sidebar-title"
                className="houseleague-setup-sidebar-heading"
              >
                Setup
              </h2>
              <button
                type="button"
                className="houseleague-setup-sidebar-close"
                aria-label="Close setup"
                onClick={() => setSetupSidebarOpen(false)}
              >
                <X size={20} strokeWidth={2} aria-hidden />
              </button>
            </div>
            <div
              className="houseleague-page-tabs houseleague-setup-sidebar-tabs"
              role="tablist"
              aria-label="Setup"
            >
              <button
                type="button"
                role="tab"
                id="tab-hl-setup-schedule"
                aria-selected={setupTab === "schedule"}
                aria-controls="panel-hl-setup-schedule"
                className={setupTab === "schedule" ? "is-active" : ""}
                onClick={() => setSetupTab("schedule")}
              >
                <HouseleagueTabLabel icon={CalendarDays}>
                  Schedule
                </HouseleagueTabLabel>
              </button>
              <button
                type="button"
                role="tab"
                id="tab-hl-setup-statutory"
                aria-selected={setupTab === "statutory"}
                aria-controls="panel-hl-setup-statutory"
                className={setupTab === "statutory" ? "is-active" : ""}
                onClick={() => setSetupTab("statutory")}
              >
                <HouseleagueTabLabel icon={CalendarOff}>
                  Statutory holidays
                </HouseleagueTabLabel>
              </button>
            </div>
            <div className="houseleague-setup-sidebar-body">
              {setupTab === "schedule" ? (
                <div
                  id="panel-hl-setup-schedule"
                  role="tabpanel"
                  aria-labelledby="tab-hl-setup-schedule"
                >
                  <Schedule embedded />
                </div>
              ) : (
                <div
                  id="panel-hl-setup-statutory"
                  role="tabpanel"
                  aria-labelledby="tab-hl-setup-statutory"
                >
                  <StatutoryHolidaysPage embedded />
                </div>
              )}
            </div>
          </aside>
        </div>
      ) : null}

      {accountingMailOpen ? (
        <div
          className="booking-single-match-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (
              ev.target === ev.currentTarget &&
              !accountingMailSending
            ) {
              setAccountingMailOpen(false);
            }
          }}
        >
          <div
            className="booking-single-match-modal houseleague-accounting-mail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="houseleague-accounting-mail-title"
            style={{ maxWidth: "34rem", width: "100%" }}
          >
            <h3 id="houseleague-accounting-mail-title" style={{ marginTop: 0 }}>
              Email roster to accounting
            </h3>
            <p className="houseleague-accounting-mail-intro">
              A CSV attachment with columns <strong>First name</strong> and{' '}
              <strong>Last name</strong> will be generated from the current
              roster (same order shown in the table).
            </p>
            <div className="booking-single-match-field">
              <label htmlFor="houseleague-accounting-mail-to">To</label>
              <input
                id="houseleague-accounting-mail-to"
                type="email"
                autoComplete="email"
                spellCheck={false}
                placeholder="accounting@example.com"
                value={accountingMailTo}
                onChange={(ev) =>
                  setAccountingMailTo(ev.target.value)
                }
                disabled={accountingMailSending}
              />
            </div>
            <div className="booking-single-match-field">
              <label htmlFor="houseleague-accounting-mail-body">
                Message body
              </label>
              <textarea
                id="houseleague-accounting-mail-body"
                rows={6}
                value={accountingMailBody}
                onChange={(ev) =>
                  setAccountingMailBody(ev.target.value)
                }
                disabled={accountingMailSending}
              />
            </div>
            <div className="booking-single-match-actions">
              <button
                type="button"
                className="secondary"
                disabled={accountingMailSending}
                onClick={() => setAccountingMailOpen(false)}
              >
                Cancel
              </button>
              {accountingMailto.href ? (
                <a
                  className="houseleague-accounting-mailto-btn"
                  href={accountingMailto.href}
                >
                  Open in my email app
                </a>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    accountingMailSending ||
                    !accountingRecipientValid ||
                    !accountingBodyNonEmpty ||
                    playersListRowsSorted.length === 0 ||
                    accountingMailto.tooLongForMailto
                  }
                  title={
                    playersListRowsSorted.length === 0
                      ? "Roster is empty."
                      : !accountingBodyNonEmpty
                        ? "Enter a message body."
                        : !accountingRecipientValid
                          ? "Enter a valid recipient email."
                          : accountingMailto.tooLongForMailto
                            ? "This message is too long for a mailto link. Shorten the body or use Send."
                            : undefined
                  }
                >
                  Open in my email app
                </button>
              )}
              <button
                type="button"
                className="primary"
                disabled={
                  accountingMailSending ||
                  !selectedEventId ||
                  playersListRowsSorted.length === 0 ||
                  !accountingRecipientValid ||
                  !accountingBodyNonEmpty
                }
                onClick={() => {
                  void submitAccountingMail();
                }}
              >
                {accountingMailSending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {createSeasonModalOpen ? (
        <div
          className="booking-single-match-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget && !createSeasonBusy) {
              setCreateSeasonModalOpen(false);
            }
          }}
        >
          <div
            className="booking-single-match-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="houseleague-create-season-title"
            style={{ maxWidth: "26rem" }}
          >
            <h3 id="houseleague-create-season-title" style={{ marginTop: 0 }}>
              Create season from previous
            </h3>
            <p className="weekly-meta" style={{ marginTop: 0 }}>
              This calls a provisional API stub. Plug in upstream Club Locker / US
              Squash “copy league season” curl when ready; for now registrations
              are copied from the event you choose below.
            </p>
            <label
              style={{ display: "block", marginTop: "0.75rem" }}
            >
              Copy roster from league event
              <div style={{ marginTop: "0.35rem" }}>
                <LeagueEventPicker
                  events={eventsForDropdown}
                  value={modalSourceHouseLeagueEventId}
                  onChange={setModalSourceHouseLeagueEventId}
                  disabled={eventsLoading || events.length === 0 || createSeasonBusy}
                />
              </div>
            </label>
            <label style={{ display: "block", marginTop: "0.75rem" }}>
              Season name
              <input
                style={{ marginTop: "0.25rem", width: "100%" }}
                type="text"
                value={createSeasonName}
                autoComplete="off"
                disabled={createSeasonBusy}
                onChange={(ev) => setCreateSeasonName(ev.target.value)}
              />
            </label>
            <div style={{ display: "block", marginTop: "0.75rem" }}>
              <div
                id="houseleague-create-season-start-monday-label"
                style={{ marginBottom: "0.25rem", cursor: "default" }}
              >
                Booking season start Monday
              </div>
              <input
                id="houseleague-create-season-start-monday"
                aria-labelledby="houseleague-create-season-start-monday-label"
                style={{
                  marginTop: 0,
                  width: "100%",
                  cursor: createSeasonBusy ? "not-allowed" : "pointer",
                }}
                type="date"
                value={createSeasonStartMonday}
                disabled={createSeasonBusy}
                onClickCapture={(ev) => {
                  const el = ev.currentTarget;
                  if (el.disabled) return;
                  try {
                    el.showPicker?.();
                  } catch {
                    /* secure context / NotAllowedError in some browsers */
                  }
                }}
                onChange={(ev) =>
                  setCreateSeasonStartMonday(ev.target.value.trim())
                }
              />
            </div>
            <div
              className="booking-single-match-actions"
              style={{ marginTop: "1rem" }}
            >
              <button
                type="button"
                className="secondary"
                disabled={createSeasonBusy}
                onClick={() => setCreateSeasonModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  createSeasonBusy ||
                  !modalSourceHouseLeagueEventId ||
                  !createSeasonName.trim() ||
                  !createSeasonStartMonday.trim() ||
                  !selectedBookingSeason?.id
                }
                onClick={() =>
                  confirmCreateSeasonFromPrevious().catch(() => {
                    /* handled */
                  })
                }
              >
                {createSeasonBusy ? "Creating…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {addPlayerModalLevel !== null ? (
        <div
          className="booking-single-match-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (
              ev.target === ev.currentTarget &&
              !(draftSaving || draftLoading || liveRosterMutating)
            ) {
              setAddPlayerModalLevel(null);
              setAddPlayerPickId(null);
            }
          }}
        >
          <div
            className="booking-single-match-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="houseleague-add-player-title"
            style={{ maxWidth: "26rem" }}
          >
            <h3 id="houseleague-add-player-title" style={{ marginTop: 0 }}>
              Add club member —{" "}
              {addPlayerModalLevel === 0 ? "Unassigned" : `Box ${addPlayerModalLevel}`}
            </h3>
            <MemberSearchSelect
              idPrefix="houseleague-draft-add"
              label="Club member"
              members={clubMembers}
              excludedSsmIds={rosterExcludedSsmIds}
              valueSsmId={addPlayerPickId}
              onChange={(id) => setAddPlayerPickId(id)}
              commitOnSelect
              onCommit={(ssmId) =>
                commitAddClubMemberToBox(ssmId).catch(() => {
                  /* handled */
                })
              }
              disabled={
                draftLoading ||
                draftSaving ||
                liveRosterMutating ||
                (!isDraftPrep && playersLoading)
              }
            />
            <div
              className="booking-single-match-actions"
              style={{ marginTop: "1rem" }}
            >
              <button
                type="button"
                className="secondary"
                disabled={
                  draftLoading ||
                  draftSaving ||
                  liveRosterMutating ||
                  (!isDraftPrep && playersLoading)
                }
                onClick={() => {
                  setAddPlayerModalLevel(null);
                  setAddPlayerPickId(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  draftLoading ||
                  draftSaving ||
                  liveRosterMutating ||
                  (!isDraftPrep && playersLoading) ||
                  addPlayerPickId == null
                }
                onClick={() =>
                  commitAddClubMemberToBox().catch(() => {
                    /* handled */
                  })
                }
              >
                Add
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
