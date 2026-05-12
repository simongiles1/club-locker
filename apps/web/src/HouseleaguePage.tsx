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
  ClipboardList,
  Eye,
  EyeOff,
  LayoutGrid,
  Mail,
  Users,
  type LucideIcon,
} from "lucide-react";
import { api } from "./api.js";
import { BookingPage } from "./BookingPage.js";
import { EmailsPage } from "./EmailsPage.js";
import { StatutoryHolidaysPage } from "./StatutoryHolidaysPage.js";
import { Schedule } from "./Schedule.js";
import { useToast } from "./toast.js";

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
}: {
  events: BoxLeagueEvent[];
  value: string;
  onChange: (eventId: string) => void;
  disabled: boolean;
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
              No league events
            </span>
          )}
        </span>
        <ChevronDown
          className={`houseleague-picker-chevron ${open ? "houseleague-picker-chevron--open" : ""}`}
          size={20}
          aria-hidden
        />
      </button>
      {open && events.length > 0 ? (
        <ul className="houseleague-picker-list" role="listbox">
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

export function HouseleaguePage({
  seasonId,
  seasonStartMondayISO,
  bookingSeasonControls,
  onLog,
}: {
  seasonId: string;
  seasonStartMondayISO: string;
  bookingSeasonControls: ReactNode;
  onLog: (message: string) => void;
}) {
  const { show } = useToast();
  const [pageTab, setPageTab] = useState<
    "players" | "registration" | "schedule" | "booking" | "statutory" | "emails"
  >("booking");

  const [events, setEvents] = useState<BoxLeagueEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [selectedEventId, setSelectedEventId] = useState<string>("");
  const [players, setPlayers] = useState<BoxLeaguePlayer[]>([]);
  const [playersLoading, setPlayersLoading] = useState(false);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [playerMoveError, setPlayerMoveError] = useState<string | null>(null);
  const [moveInFlight, setMoveInFlight] = useState(false);
  const [draggingPlayerId, setDraggingPlayerId] = useState<number | null>(
    null,
  );
  const [dropTargetLevel, setDropTargetLevel] = useState<number | null>(null);

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

  useEffect(() => {
    if (eventsLoading || events.length === 0) return;
    const def = defaultLatestEventId(events);
    setSelectedEventId((cur) => {
      if (cur && events.some((e) => String(e.eventId) === cur)) {
        return cur;
      }
      return def;
    });
  }, [eventsLoading, events]);

  const loadPlayers = useCallback(async (eventId: string) => {
    if (!eventId) {
      setPlayers([]);
      return;
    }
    setPlayersLoading(true);
    setPlayersError(null);
    try {
      const data = await api<BoxLeaguePlayer[]>(
        `/api/houseleague/events/${eventId}/players`,
      );
      setPlayers(Array.isArray(data) ? data : []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPlayersError(msg);
      setPlayers([]);
    } finally {
      setPlayersLoading(false);
    }
  }, []);

  useEffect(() => {
    setPlayerMoveError(null);
    if (!selectedEventId) {
      setPlayers([]);
      return;
    }
    loadPlayers(selectedEventId).catch(() => {
      /* handled */
    });
  }, [selectedEventId, loadPlayers]);

  const grouped = useMemo(() => groupPlayersByBox(players), [players]);

  const movePlayerToBox = useCallback(
    async (playerId: number, level: number) => {
      if (!selectedEventId) return;
      setPlayerMoveError(null);
      setMoveInFlight(true);
      try {
        await api<{ ok: boolean }>(
          `/api/houseleague/events/${selectedEventId}/players/${playerId}`,
          {
            method: "PUT",
            body: JSON.stringify({ level }),
          },
        );
        await loadPlayers(selectedEventId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setPlayerMoveError(msg);
      } finally {
        setMoveInFlight(false);
      }
    },
    [selectedEventId, loadPlayers],
  );

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
                id="tab-houseleague-registration"
                aria-selected={pageTab === "registration"}
                aria-controls="panel-houseleague-registration"
                className={pageTab === "registration" ? "is-active" : ""}
                onClick={() => setPageTab("registration")}
              >
                <HouseleagueTabLabel icon={ClipboardList}>
                  Registration
                </HouseleagueTabLabel>
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
            </div>
            <div
              className="houseleague-page-tabs houseleague-page-tabs--secondary"
              role="tablist"
              aria-label="Reference"
            >
              <button
                type="button"
                role="tab"
                id="tab-houseleague-schedule"
                aria-selected={pageTab === "schedule"}
                aria-controls="panel-houseleague-schedule"
                className={pageTab === "schedule" ? "is-active" : ""}
                onClick={() => setPageTab("schedule")}
              >
                <HouseleagueTabLabel icon={CalendarDays}>
                  Schedule
                </HouseleagueTabLabel>
              </button>
              <button
                type="button"
                role="tab"
                id="tab-houseleague-statutory"
                aria-selected={pageTab === "statutory"}
                aria-controls="panel-houseleague-statutory"
                className={pageTab === "statutory" ? "is-active" : ""}
                onClick={() => setPageTab("statutory")}
              >
                <HouseleagueTabLabel icon={CalendarOff}>
                  Statutory holidays
                </HouseleagueTabLabel>
              </button>
            </div>
          </div>
        </div>
        <div className="houseleague-toolbar-actions">
          {pageTab === "players" ? (
            <div className="row houseleague-header-controls">
              <LeagueEventPicker
                events={eventsForDropdown}
                value={selectedEventId}
                onChange={setSelectedEventId}
                disabled={eventsLoading || events.length === 0}
              />
            </div>
          ) : pageTab === "booking" || pageTab === "emails" ? (
            <div className="row houseleague-header-controls">
              {bookingSeasonControls}
            </div>
          ) : null}
        </div>
      </div>

      {pageTab === "players" ? (
        <div
          id="panel-houseleague-players"
          role="tabpanel"
          aria-labelledby="tab-houseleague-players"
        >
          {eventsError ? (
            <div
              className="houseleague-banner houseleague-banner--error"
              role="alert"
            >
              <strong>Could not load league events.</strong> {eventsError}
            </div>
          ) : null}

          {playersError ? (
            <div
              className="houseleague-banner houseleague-banner--error"
              role="alert"
            >
              <strong>Could not load players.</strong> {playersError}
            </div>
          ) : null}

          {playerMoveError ? (
            <div
              className="houseleague-banner houseleague-banner--error"
              role="alert"
            >
              <strong>Could not move player.</strong> {playerMoveError}
            </div>
          ) : null}

          {selectedEventId && playersLoading ? (
            <p className="houseleague-status">Loading registrants…</p>
          ) : null}

          {!selectedEventId && !eventsLoading && events.length === 0 ? (
            <p className="houseleague-status houseleague-status--muted">
              No league events to display.
            </p>
          ) : null}

          {selectedEventId &&
          !playersLoading &&
          players.length === 0 &&
          !playersError ? (
            <p className="houseleague-status houseleague-status--muted">
              No players returned for this event.
            </p>
          ) : null}

          <div className="houseleague-box-grid">
            {grouped.map((group) => {
              const droppable = Number.isFinite(group.sortKey);
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
                        const player = players.find((x) => x.id === pid);
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
                <h2 className="houseleague-box-title">{group.boxLabel}</h2>
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
                      </tr>
                    </thead>
                    <tbody>
                      {group.players.map((p) => (
                        <tr
                          key={p.id}
                          className={
                            draggingPlayerId === p.id
                              ? "houseleague-player-row houseleague-player-row--dragging"
                              : "houseleague-player-row"
                          }
                          draggable={
                            Boolean(selectedEventId) &&
                            !moveInFlight &&
                            !playersLoading
                          }
                          title="Drag to another box to change assignment"
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
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
            })}
          </div>
        </div>
      ) : pageTab === "registration" ? (
        <RegistrationQueueSection onLog={onLog} />
      ) : pageTab === "schedule" ? (
        <div
          id="panel-houseleague-schedule"
          role="tabpanel"
          aria-labelledby="tab-houseleague-schedule"
        >
          <Schedule embedded />
        </div>
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
          />
        </div>
      ) : pageTab === "statutory" ? (
        <StatutoryHolidaysPage />
      ) : pageTab === "booking" ? (
        <div
          id="panel-houseleague-booking"
          role="tabpanel"
          aria-labelledby="tab-houseleague-booking"
        >
          <BookingPage
            seasonId={seasonId}
            seasonStartMondayISO={seasonStartMondayISO}
            onLog={onLog}
          />
        </div>
      ) : null}
    </div>
  );
}

function RegistrationQueueSection({
  onLog,
}: {
  onLog: (message: string) => void;
}) {
  return (
    <div
      id="panel-houseleague-registration"
      role="tabpanel"
      aria-labelledby="tab-houseleague-registration"
    >
      <h2 className="houseleague-registration-heading">Registration queue</h2>
      <div className="card row">
        <button
          type="button"
          className="secondary"
          onClick={async () => {
            const rows = await api<unknown[]>("/api/registration-queue");
            onLog(JSON.stringify(rows, null, 2));
          }}
        >
          Load queue
        </button>
      </div>
      <div className="card">
        <p>Simulate opt-in (uses player email in mock roster)</p>
        <button
          type="button"
          className="primary"
          onClick={async () => {
            const res = await api<unknown>("/api/registration-queue", {
              method: "POST",
              body: JSON.stringify({
                kind: "opt_in",
                fromEmail: "player1@example.test",
                parsedName: "Player 1",
              }),
            });
            onLog(JSON.stringify(res, null, 2));
          }}
        >
          Simulate opt-in player1@example.test
        </button>
      </div>
    </div>
  );
}
