import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, Eye, EyeOff } from "lucide-react";
import { api } from "./api.js";
import { Schedule } from "./Schedule.js";

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

function LeagueEventRow({ ev }: { ev: BoxLeagueEvent }) {
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
      <span className="houseleague-event-dates">{rangeText}</span>
    </span>
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
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => {
          if (!disabled) setOpen((o) => !o);
        }}
      >
        <span className="houseleague-picker-trigger-inner">
          {selected ? (
            <LeagueEventRow ev={selected} />
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

export function HouseleaguePage() {
  const [pageTab, setPageTab] = useState<"players" | "schedule">("players");

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
      <div
        className="houseleague-page-tabs"
        role="tablist"
        aria-label="Houseleague"
      >
        <button
          type="button"
          role="tab"
          id="tab-houseleague-players"
          aria-selected={pageTab === "players"}
          aria-controls="panel-houseleague-players"
          className={pageTab === "players" ? "is-active" : ""}
          onClick={() => setPageTab("players")}
        >
          Players
        </button>
        <button
          type="button"
          role="tab"
          id="tab-houseleague-schedule"
          aria-selected={pageTab === "schedule"}
          aria-controls="panel-houseleague-schedule"
          className={pageTab === "schedule" ? "is-active" : ""}
          onClick={() => setPageTab("schedule")}
        >
          Schedule
        </button>
      </div>
      <div className="houseleague-main-header">
        <h1 className="houseleague-title">Houseleague</h1>
        {pageTab === "players" ? (
          <div className="row houseleague-header-controls">
            <label className="houseleague-event-label">
              League event{" "}
              <LeagueEventPicker
                events={eventsForDropdown}
                value={selectedEventId}
                onChange={setSelectedEventId}
                disabled={eventsLoading || events.length === 0}
              />
            </label>
            <button
              type="button"
              className="secondary"
              disabled={eventsLoading}
              onClick={() => {
                loadEvents().catch(() => {
                  /* handled */
                });
              }}
            >
              Refresh
            </button>
          </div>
        ) : null}
      </div>

      {pageTab === "players" ? (
        <div
          id="panel-houseleague-players"
          role="tabpanel"
          aria-labelledby="tab-houseleague-players"
        >
          <p className="houseleague-lead">
            Box league registrants from US Squash, grouped by box for the
            selected league event. Drag a player onto another box to update their
            assignment (US Squash API).
          </p>

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
                        <th scope="col">Rank</th>
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
                          <td>{p.playerCurrentRank}</td>
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
      ) : (
        <div
          id="panel-houseleague-schedule"
          role="tabpanel"
          aria-labelledby="tab-houseleague-schedule"
        >
          <Schedule embedded />
        </div>
      )}
    </div>
  );
}
