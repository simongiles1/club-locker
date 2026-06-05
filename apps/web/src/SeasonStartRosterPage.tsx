import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ChevronDown, ChevronUp, Download, Plus, Trash2 } from "lucide-react";
import {
  maxPlayerCurrentRankBelowBox,
  relativeRankInBox,
  type SeasonStartRosterDiffResult,
  type SeasonStartRosterDiffRow,
} from "@squash/shared";
import { api, downloadTextFile } from "./api.js";
import type { ClubMember } from "./MembersPage.js";
import { MemberSearchSelect } from "./MemberSearchSelect.js";
import { useToast } from "./toast.js";

type BoxLeaguePlayer = {
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

function csvEscapeCell(value: string): string {
  const v = String(value ?? "").replace(/\r\n|\n|\r/g, " ").trimEnd();
  if (/["\n,]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function groupPlayersByBox(
  players: BoxLeaguePlayer[],
): { boxLabel: string; sortKey: number; players: BoxLeaguePlayer[] }[] {
  const unassignedKey = Number.POSITIVE_INFINITY;
  const map = new Map<number, BoxLeaguePlayer[]>();

  for (const p of players) {
    const raw = p.level;
    const key =
      typeof raw === "number" && Number.isFinite(raw) && !Number.isNaN(raw)
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

function houseLeagueBoxesCsvText(
  groups: { boxLabel: string; players: BoxLeaguePlayer[] }[],
  relativeRankByPlayerId: Map<number, number>,
): string {
  const esc = csvEscapeCell;
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

function playersInBoxSorted(
  players: BoxLeaguePlayer[],
  level: number,
): BoxLeaguePlayer[] {
  return players
    .filter(
      (p) =>
        typeof p.level === "number" &&
        Number.isFinite(p.level) &&
        p.level === level,
    )
    .sort((a, b) => {
      const ra = a.playerCurrentRank ?? 0;
      const rb = b.playerCurrentRank ?? 0;
      if (ra !== rb) return ra - rb;
      const la = `${a.lastName} ${a.firstName}`;
      const lb = `${b.lastName} ${b.firstName}`;
      return la.localeCompare(lb, undefined, { sensitivity: "base" });
    });
}

function applyBoxPlayerOrder(
  players: BoxLeaguePlayer[],
  level: number,
  orderedIds: number[],
): BoxLeaguePlayer[] {
  const offset = maxPlayerCurrentRankBelowBox(players, level);
  const idToRank = new Map(
    orderedIds.map((id, index) => [id, offset + index + 1]),
  );
  return players.map((p) => {
    if (p.level !== level) return p;
    const rank = idToRank.get(p.id);
    if (rank == null) return p;
    return {
      ...p,
      playerCurrentRank: rank,
      prevBoxRank: rank - offset,
    };
  });
}

function reorderPlayerWithinBox(
  players: BoxLeaguePlayer[],
  playerId: number,
  direction: "up" | "down",
): BoxLeaguePlayer[] | null {
  const player = players.find((p) => p.id === playerId);
  if (!player || typeof player.level !== "number" || !Number.isFinite(player.level)) {
    return null;
  }
  const level = player.level;
  if (level <= 0) return null;

  const inBox = playersInBoxSorted(players, level);
  const idx = inBox.findIndex((p) => p.id === playerId);
  if (idx < 0) return null;
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= inBox.length) return null;

  const orderedIds = inBox.map((p) => p.id);
  [orderedIds[idx], orderedIds[swapIdx]] = [
    orderedIds[swapIdx]!,
    orderedIds[idx]!,
  ];
  return applyBoxPlayerOrder(players, level, orderedIds);
}

function clubMemberToBoxPlayer(
  m: ClubMember,
  level: number,
  seatInBox: number,
  allPlayers: BoxLeaguePlayer[],
): BoxLeaguePlayer {
  const offset = maxPlayerCurrentRankBelowBox(allPlayers, level);
  const rank = offset + seatInBox;
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
    playerCurrentRank: rank,
  };
}

function formatBoxSeat(box: number | null, seat: number | null): string {
  if (box == null) return "—";
  const boxLabel = box === 0 ? "Unassigned" : `Box ${box}`;
  if (seat == null) return boxLabel;
  return `${boxLabel} (seat ${seat})`;
}

function changeKindLabel(kind: SeasonStartRosterDiffRow["changeKind"]): string {
  switch (kind) {
    case "moved":
      return "Moved";
    case "addedOnLive":
      return "Added on Club Locker";
    case "removedFromLive":
      return "Removed from Club Locker";
    case "unchanged":
      return "Unchanged";
    default:
      return kind;
  }
}

function changeKindClass(kind: SeasonStartRosterDiffRow["changeKind"]): string {
  switch (kind) {
    case "moved":
      return "season-start-diff-badge--moved";
    case "addedOnLive":
      return "season-start-diff-badge--added";
    case "removedFromLive":
      return "season-start-diff-badge--removed";
    default:
      return "season-start-diff-badge--unchanged";
  }
}

export function SeasonStartRosterPage({
  seasonId,
  seasonName,
  clubMembers,
  onDiffChange,
  onOpenRosterImpact,
}: {
  seasonId: string;
  seasonName: string;
  clubMembers: ClubMember[];
  onDiffChange?: (hasChanges: boolean) => void;
  onOpenRosterImpact?: () => void;
}) {
  const { show, error } = useToast();
  const [players, setPlayers] = useState<BoxLeaguePlayer[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [diff, setDiff] = useState<SeasonStartRosterDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const [addPlayerModalLevel, setAddPlayerModalLevel] = useState<number | null>(
    null,
  );
  const [addPlayerPickId, setAddPlayerPickId] = useState<number | null>(null);
  const [draggingPlayerId, setDraggingPlayerId] = useState<number | null>(null);
  const [dropTargetLevel, setDropTargetLevel] = useState<number | null>(null);

  const loadRoster = useCallback(async () => {
    if (!seasonId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api<{
        players: BoxLeaguePlayer[] | undefined;
        savedAt: string | null;
      }>(`/api/seasons/${seasonId}/season-start-roster`);
      setPlayers(Array.isArray(res?.players) ? res.players : []);
      setSavedAt(res?.savedAt ?? null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLoadError(msg);
      setPlayers([]);
      setSavedAt(null);
    } finally {
      setLoading(false);
    }
  }, [seasonId]);

  const loadDiff = useCallback(async () => {
    if (!seasonId) return;
    setDiffLoading(true);
    setDiffError(null);
    try {
      const res = await api<SeasonStartRosterDiffResult>(
        `/api/seasons/${seasonId}/season-start-roster/diff`,
      );
      setDiff(res);
      onDiffChange?.(res.summary.hasChanges);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDiffError(msg);
      setDiff(null);
      onDiffChange?.(false);
    } finally {
      setDiffLoading(false);
    }
  }, [onDiffChange, seasonId]);

  useEffect(() => {
    loadRoster().catch(() => {
      /* handled */
    });
  }, [loadRoster]);

  useEffect(() => {
    loadDiff().catch(() => {
      /* handled */
    });
  }, [loadDiff, players, savedAt]);

  const persistRoster = useCallback(
    async (next: BoxLeaguePlayer[]) => {
      if (!seasonId) return;
      setSaving(true);
      try {
        const res = await api<{ ok: boolean; savedAt: string }>(
          `/api/seasons/${seasonId}/season-start-roster`,
          {
            method: "PUT",
            body: JSON.stringify({
              players: next as unknown as Record<string, unknown>[],
            }),
          },
        );
        setPlayers(next);
        setSavedAt(res.savedAt ?? new Date().toISOString());
        show("Season-start roster saved.");
      } catch (e) {
        error(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [error, seasonId, show],
  );

  const seedFromLive = useCallback(async () => {
    if (!seasonId) return;
    const msg =
      players.length > 0
        ? "Replace the current season-start roster with today's Club Locker roster? You can edit it afterward to reconstruct the original boxes."
        : "Copy today's Club Locker roster as a starting point? Edit it to match boxes at season open.";
    if (!window.confirm(msg)) return;
    setSeeding(true);
    try {
      const res = await api<{
        ok: boolean;
        players: BoxLeaguePlayer[];
        savedAt: string;
        playerCount: number;
      }>(`/api/seasons/${seasonId}/season-start-roster/seed-from-live`, {
        method: "POST",
      });
      setPlayers(Array.isArray(res.players) ? res.players : []);
      setSavedAt(res.savedAt ?? null);
      show(`Copied ${res.playerCount} players from Club Locker.`);
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    } finally {
      setSeeding(false);
    }
  }, [error, players.length, seasonId, show]);

  const removePlayer = useCallback(
    async (playerId: number) => {
      const next = players.filter((p) => p.id !== playerId);
      await persistRoster(next);
    },
    [persistRoster, players],
  );

  const movePlayerToBox = useCallback(
    async (playerId: number, level: number) => {
      const player = players.find((x) => x.id === playerId);
      if (!player) return;
      if (player.level === level) return;
      const next = players.map((p) =>
        p.id === playerId ? { ...p, level, prevBox: level } : p,
      );
      await persistRoster(next);
    },
    [persistRoster, players],
  );

  const reorderPlayerInBox = useCallback(
    async (playerId: number, direction: "up" | "down") => {
      const next = reorderPlayerWithinBox(players, playerId, direction);
      if (!next) return;
      await persistRoster(next);
    },
    [persistRoster, players],
  );

  const commitAddClubMemberToBox = useCallback(
    async (ssmChoice?: number | null) => {
      const idToUse =
        typeof ssmChoice === "number" && Number.isFinite(ssmChoice)
          ? ssmChoice
          : addPlayerPickId;
      if (addPlayerModalLevel === null || idToUse == null) return;
      const m = clubMembers.find((x) => x.ssmId === idToUse);
      if (!m) return;

      const inBox =
        players.filter(
          (p) =>
            typeof p.level === "number" &&
            Number.isFinite(p.level) &&
            p.level === addPlayerModalLevel,
        ).length + 1;
      const row = clubMemberToBoxPlayer(
        m,
        addPlayerModalLevel,
        inBox,
        players,
      );
      const next = [...players.filter((p) => p.id !== row.id), row];
      await persistRoster(next);
      setAddPlayerModalLevel(null);
      setAddPlayerPickId(null);
    },
    [addPlayerModalLevel, addPlayerPickId, clubMembers, persistRoster, players],
  );

  const grouped = useMemo(() => groupPlayersByBox(players), [players]);

  const relativeRankByPlayerId = useMemo(() => {
    const map = new Map<number, number>();
    for (const p of players) {
      if (
        typeof p.level !== "number" ||
        !Number.isFinite(p.level) ||
        typeof p.playerCurrentRank !== "number" ||
        !Number.isFinite(p.playerCurrentRank)
      ) {
        continue;
      }
      map.set(p.id, relativeRankInBox(p.playerCurrentRank, p.level, players));
    }
    return map;
  }, [players]);

  const rosterExcludedSsmIds = useMemo(
    () => new Set(players.filter((p) => p.id > 0).map((p) => p.id)),
    [players],
  );

  const downloadCsv = useCallback(() => {
    if (players.length === 0) return;
    const slug = (seasonName || "season-start")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 48);
    const day = new Date().toISOString().slice(0, 10);
    const filename = `${slug || "season-start"}-boxes-${day}.csv`;
    downloadTextFile(houseLeagueBoxesCsvText(grouped, relativeRankByPlayerId), filename);
    show("Downloaded season-start boxes CSV.");
  }, [grouped, players.length, relativeRankByPlayerId, seasonName, show]);

  const diffRows = useMemo(() => {
    if (!diff) return [];
    return diff.rows.filter((r) => r.changeKind !== "unchanged");
  }, [diff]);

  return (
    <div
      id="panel-houseleague-season-start"
      role="tabpanel"
      aria-labelledby="tab-houseleague-season-start"
      className="season-start-roster-page"
    >
      <div className="season-start-intro card">
        <p>
          This is the roster as it was at <strong>season open</strong> — saved
          locally as ground truth.           Edit boxes here to reconstruct the original
          layout if Club Locker was changed afterward. Use the order controls in
          each box to set seat order (relative rank). The <strong>Boxes</strong>{" "}
          tab still shows the live Club Locker roster today.
        </p>
        {savedAt ? (
          <p className="season-start-saved-at">
            Last saved: {new Date(savedAt).toLocaleString()}
          </p>
        ) : null}
      </div>

      {diff?.summary.hasGroundTruth && diff.summary.hasChanges && onOpenRosterImpact ? (
        <div className="houseleague-banner roster-impact-banner" role="status">
          <strong>Live Club Locker differs from season-start ground truth.</strong>{" "}
          Court bookings should match today&apos;s Club Locker roster.{" "}
          <button
            type="button"
            className="link-button roster-impact-open-btn"
            onClick={onOpenRosterImpact}
          >
            Review roster impact
          </button>
        </div>
      ) : null}

      <div className="season-start-layout">
        <section className="season-start-editor card">
          <div className="season-start-toolbar houseleague-player-list-toolbar">
            <div className="season-start-toolbar-actions">
              <button
                type="button"
                className="secondary"
                disabled={loading || saving || seeding}
                onClick={() => seedFromLive().catch(() => {})}
              >
                {seeding ? "Copying…" : "Seed from Club Locker (current)"}
              </button>
              <button
                type="button"
                className="secondary houseleague-player-list-email-btn statutory-holidays-icon-btn"
                title="Download season-start boxes as CSV"
                disabled={players.length === 0 || saving}
                onClick={downloadCsv}
              >
                <Download size={18} strokeWidth={2} aria-hidden />
                <span className="houseleague-player-list-email-btn-label">
                  Download CSV
                </span>
              </button>
            </div>
            <div className="houseleague-player-list-count" aria-live="polite">
              {loading ? (
                "Loading…"
              ) : (
                <>
                  <strong>{players.length}</strong>{" "}
                  {players.length === 1 ? "player" : "players"} across{" "}
                  <strong>{grouped.length}</strong>{" "}
                  {grouped.length === 1 ? "box" : "boxes"}
                  {saving ? " · Saving…" : null}
                </>
              )}
            </div>
          </div>

          {loadError ? (
            <div className="houseleague-banner houseleague-banner--error" role="alert">
              {loadError}
            </div>
          ) : null}

          {!loading && players.length === 0 && !loadError ? (
            <p className="houseleague-status houseleague-status--muted">
              No season-start roster saved yet. Seed from Club Locker, then edit
              boxes to match season open.
            </p>
          ) : null}

          <div className="houseleague-box-grid">
            {grouped.map((group) => {
              const droppable = Number.isFinite(group.sortKey);
              const canReorderInBox = droppable && group.sortKey > 0;
              const dropHover = droppable && dropTargetLevel === group.sortKey;
              const boxPlayerIds = group.players.map((p) => p.id);
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
                          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
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
                          movePlayerToBox(pid, group.sortKey).catch(() => {});
                        }
                      : undefined
                  }
                >
                  <div className="houseleague-box-heading-row">
                    <h2 className="houseleague-box-title">{group.boxLabel}</h2>
                    <button
                      type="button"
                      className="secondary houseleague-box-add-player-btn"
                      title="Add player to this box"
                      aria-label={`Add player to ${group.boxLabel}`}
                      disabled={loading || saving || seeding}
                      onClick={() =>
                        setAddPlayerModalLevel(
                          Number.isFinite(group.sortKey) ? group.sortKey : 0,
                        )
                      }
                    >
                      <Plus size={18} strokeWidth={2} aria-hidden />
                    </button>
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
                          <th scope="col" title="Relative rank within box (seat 1–6)">
                            RR
                          </th>
                          {canReorderInBox ? (
                            <th scope="col" className="season-start-order-col">
                              Order
                            </th>
                          ) : null}
                          <th scope="col" />
                        </tr>
                      </thead>
                      <tbody>
                        {group.players.map((p, rowIndex) => (
                          <tr
                            key={p.id}
                            className={[
                              "houseleague-player-row",
                              draggingPlayerId === p.id
                                ? "houseleague-player-row--dragging"
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            draggable={!loading && !saving && !seeding}
                            title="Drag to another box to change assignment"
                            onDragStart={(e) => {
                              setDraggingPlayerId(p.id);
                              e.dataTransfer.setData("text/plain", String(p.id));
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
                            <td>{relativeRankByPlayerId.get(p.id) ?? "—"}</td>
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
                                    title="Move up in box"
                                    aria-label={`Move ${p.firstName.trim()} ${p.lastName.trim()} up`}
                                    disabled={
                                      loading ||
                                      saving ||
                                      seeding ||
                                      rowIndex === 0
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
                                    title="Move down in box"
                                    aria-label={`Move ${p.firstName.trim()} ${p.lastName.trim()} down`}
                                    disabled={
                                      loading ||
                                      saving ||
                                      seeding ||
                                      rowIndex === boxPlayerIds.length - 1
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
                            <td>
                              <button
                                type="button"
                                className="secondary"
                                title={`Remove ${p.firstName.trim()} ${p.lastName.trim()}`}
                                aria-label={`Remove ${p.firstName.trim()} ${p.lastName.trim()}`}
                                disabled={saving || loading}
                                onClick={() => {
                                  const displayName =
                                    `${p.firstName.trim()} ${p.lastName.trim()}`.trim() ||
                                    "this player";
                                  if (
                                    !window.confirm(
                                      `Remove ${displayName} from the season-start roster?`,
                                    )
                                  ) {
                                    return;
                                  }
                                  removePlayer(p.id).catch(() => {});
                                }}
                              >
                                <Trash2 size={16} strokeWidth={2} aria-hidden />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}
          </div>
        </section>

        <aside className="season-start-diff card">
          <h2 className="season-start-diff-title">Changes since season start</h2>
          <p className="season-start-diff-subtitle">
            Ground truth vs live Club Locker roster
          </p>

          {diffLoading ? (
            <p className="houseleague-status">Loading comparison…</p>
          ) : null}

          {diffError ? (
            <div className="houseleague-banner houseleague-banner--error" role="alert">
              {diffError}
            </div>
          ) : null}

          {!diffLoading && diff && !diff.summary.hasGroundTruth ? (
            <p className="houseleague-status houseleague-status--muted">
              Save a season-start roster to compare against Club Locker.
            </p>
          ) : null}

          {!diffLoading && diff?.summary.hasGroundTruth && !diff.summary.hasChanges ? (
            <p className="houseleague-status houseleague-status--muted">
              Live Club Locker matches season-start ground truth.
            </p>
          ) : null}

          {!diffLoading && diff?.summary.hasGroundTruth && diff.summary.hasChanges ? (
            <>
              <ul className="season-start-diff-summary">
                {diff.summary.moved > 0 ? (
                  <li>
                    <strong>{diff.summary.moved}</strong> moved
                  </li>
                ) : null}
                {diff.summary.addedOnLive > 0 ? (
                  <li>
                    <strong>{diff.summary.addedOnLive}</strong> added on Club Locker
                  </li>
                ) : null}
                {diff.summary.removedFromLive > 0 ? (
                  <li>
                    <strong>{diff.summary.removedFromLive}</strong> removed from Club
                    Locker
                  </li>
                ) : null}
              </ul>
              <div className="houseleague-table-wrap">
                <table className="houseleague-table season-start-diff-table">
                  <thead>
                    <tr>
                      <th scope="col">Player</th>
                      <th scope="col">Season start</th>
                      <th scope="col">Club Locker</th>
                      <th scope="col">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffRows.map((row) => (
                      <tr key={row.playerId}>
                        <td className="houseleague-name">
                          {row.firstName.trim()} {row.lastName.trim()}
                        </td>
                        <td>
                          {formatBoxSeat(row.groundTruthBox, row.groundTruthSeat)}
                        </td>
                        <td>{formatBoxSeat(row.liveBox, row.liveSeat)}</td>
                        <td>
                          <span
                            className={`season-start-diff-badge ${changeKindClass(row.changeKind)}`}
                          >
                            {changeKindLabel(row.changeKind)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </aside>
      </div>

      {addPlayerModalLevel !== null ? (
        <div
          className="booking-single-match-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget && !saving && !loading) {
              setAddPlayerModalLevel(null);
              setAddPlayerPickId(null);
            }
          }}
        >
          <div
            className="booking-single-match-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="season-start-add-player-title"
            style={{ maxWidth: "26rem" }}
          >
            <h3 id="season-start-add-player-title" style={{ marginTop: 0 }}>
              Add club member —{" "}
              {addPlayerModalLevel === 0
                ? "Unassigned"
                : `Box ${addPlayerModalLevel}`}
            </h3>
            <MemberSearchSelect
              idPrefix="season-start-add"
              label="Club member"
              members={clubMembers}
              excludedSsmIds={rosterExcludedSsmIds}
              valueSsmId={addPlayerPickId}
              onChange={(id) => setAddPlayerPickId(id)}
              commitOnSelect
              onCommit={(ssmId) =>
                commitAddClubMemberToBox(ssmId).catch(() => {})
              }
              disabled={loading || saving}
            />
            <div
              className="booking-single-match-actions"
              style={{ marginTop: "1rem" }}
            >
              <button
                type="button"
                className="secondary"
                disabled={loading || saving}
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
                disabled={loading || saving || addPlayerPickId == null}
                onClick={() => commitAddClubMemberToBox().catch(() => {})}
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
