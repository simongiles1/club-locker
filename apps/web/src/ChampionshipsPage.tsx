import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  CHAMPIONSHIP_KNOCKOUT_STAGE_ORDER,
  divisionCode,
  divisionDisplayName,
  entrantsAtBracketRoundStart,
  interpolateEmailTemplate,
  knockoutStageLabel,
  type ChampionshipDivision,
} from "@squash/shared";
import { api } from "./api.js";
import type { ClubMember } from "./MembersPage.js";
import {
  MemberSearchSelect,
  clubMemberDisplayName as memberDisplayName,
} from "./MemberSearchSelect.js";
import { useToast } from "./toast.js";

type SeasonRoundScheduleRow = {
  id: string;
  name: string;
  clubYear: number | null;
  calendarSegment: string | null;
  championshipRoundDueDatesJson: string | null;
};

/** winter → spring → summer → fall */
const CALENDAR_SEGMENT_ORDER: Record<string, number> = {
  winter: 0,
  spring: 1,
  summer: 2,
  fall: 3,
};

function compareSeasonSegments(a: string | null, b: string | null): number {
  const ao =
    a != null ? (CALENDAR_SEGMENT_ORDER[a] ?? 99) : 99;
  const bo =
    b != null ? (CALENDAR_SEGMENT_ORDER[b] ?? 99) : 99;
  return ao - bo;
}

/** Parse `{ "32": "YYYY-MM-DD", "16": … }` keyed by entrants at round start. */
function scheduleJsonToFormState(
  json: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of CHAMPIONSHIP_KNOCKOUT_STAGE_ORDER) {
    out[String(n)] = "";
  }
  if (!json?.trim()) return out;
  try {
    const o = JSON.parse(json) as unknown;
    if (typeof o !== "object" || o === null) return out;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string") out[String(k)] = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

type PlayerRow = {
  id: string;
  displayName: string;
  email: string | null;
  rating: string;
  externalId: string | null;
};

type ChampionshipRow = {
  id: string;
  seasonId: string | null;
  format: "singles" | "doubles";
  divisionKind: "skill" | "age";
  divisionLabel: string;
  name: string;
  status: string;
  roundOneDueDate: string | null;
};

type EnrichedEntry = {
  id: string;
  championshipId: string;
  playerId: string;
  partnerPlayerId: string | null;
  seed: number | null;
  playerName: string;
  playerEmail: string | null;
  partnerName: string | null;
  partnerEmail: string | null;
};

type MatchRow = {
  id: string;
  championshipId: string;
  drawId: string;
  round: number;
  matchIndex: number;
  topEntryId: string | null;
  topIsBye: number;
  bottomEntryId: string | null;
  bottomIsBye: number;
  winnerEntryId: string | null;
  dueDate: string | null;
  /** ISO 8601 when players agreed a concrete play time (AI or director). */
  scheduledAt: string | null;
  completedAt: string | null;
};

type DrawRow = {
  id: string;
  championshipId: string;
  status: "draft" | "published";
  size: number;
  snapshotJson: string;
  createdAt: string;
  matches: MatchRow[];
};

type ChampionshipDetail = {
  championship: ChampionshipRow;
  entries: EnrichedEntry[];
  activeDraw: DrawRow | null;
};

function logError(scope: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[championships:${scope}]`, err);
  return msg;
}

async function ensureClubMemberPlayer(m: ClubMember): Promise<PlayerRow> {
  return api<PlayerRow>("/api/players/from-club-member", {
    method: "POST",
    body: JSON.stringify({
      ssmId: m.ssmId,
      firstName: m.firstName,
      lastName: m.lastName,
      email: m.email ?? "",
      ratingSingles: m.ratingSingles,
    }),
  });
}

export function ChampionshipsPage({
  seasonId,
  clubYear,
}: {
  seasonId: string;
  /** Calendar club-booking year for labels (canonical season row still backs APIs). */
  clubYear: number | null;
}) {
  const { show, error } = useToast();
  const [divisions, setDivisions] = useState<ChampionshipDivision[]>([]);
  const [selectedCode, setSelectedCode] = useState<string>("");
  const [championships, setChampionships] = useState<ChampionshipRow[]>([]);
  const [detail, setDetail] = useState<ChampionshipDetail | null>(null);
  /** Local roster rows — used to map league/championship entries to club member IDs for exclusions. */
  const [rosterPlayers, setRosterPlayers] = useState<PlayerRow[]>([]);
  const [clubMembers, setClubMembers] = useState<ClubMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pageTab, setPageTab] = useState<"divisions" | "schedule">(
    "divisions",
  );

  const refreshRosterPlayers = useCallback(async () => {
    const rows = await api<PlayerRow[]>("/api/players");
    setRosterPlayers(rows);
  }, []);

  const loadClubMembers = useCallback(async () => {
    setMembersLoading(true);
    try {
      const data = await api<ClubMember[]>("/api/club-members");
      setClubMembers(data);
    } catch (e) {
      error(logError("club-members", e));
      setClubMembers([]);
    } finally {
      setMembersLoading(false);
    }
  }, [error]);

  const selectedDivision = useMemo(
    () => divisions.find((d) => divisionCode(d) === selectedCode) ?? null,
    [divisions, selectedCode],
  );
  const championshipForSelection = useMemo(() => {
    if (!selectedDivision) return null;
    return (
      championships.find(
        (c) =>
          (clubYear != null
            ? true
            : (c.seasonId ?? null) === (seasonId || null)) &&
          c.format === selectedDivision.format &&
          c.divisionKind === selectedDivision.kind &&
          c.divisionLabel === selectedDivision.label,
      ) ?? null
    );
  }, [championships, seasonId, selectedDivision, clubYear]);

  /** Division codes that already have a championship row for the selected year. */
  const divisionCodesCreatedForSeason = useMemo(() => {
    const codes = new Set<string>();
    for (const c of championships) {
      if (
        clubYear == null &&
        (c.seasonId ?? null) !== (seasonId || null)
      ) {
        continue;
      }
      codes.add(
        divisionCode({
          format: c.format,
          kind: c.divisionKind,
          label: c.divisionLabel,
        }),
      );
    }
    return codes;
  }, [championships, seasonId, clubYear]);

  const refreshChampionships = useCallback(async () => {
    const rows = await api<ChampionshipRow[]>(
      clubYear != null
        ? `/api/championships?clubYear=${encodeURIComponent(String(clubYear))}`
        : seasonId
          ? `/api/championships?seasonId=${encodeURIComponent(seasonId)}`
          : "/api/championships",
    );
    setChampionships(rows);
  }, [seasonId, clubYear]);

  const loadDetail = useCallback(async (championshipId: string) => {
    const d = await api<ChampionshipDetail>(
      `/api/championships/${championshipId}`,
    );
    setDetail(d);
  }, []);

  // Initial bootstrap.
  useEffect(() => {
    api<ChampionshipDivision[]>("/api/championships/divisions")
      .then((d) => {
        setDivisions(d);
        if (d.length > 0 && !selectedCode) setSelectedCode(divisionCode(d[0]));
      })
      .catch((e) => error(logError("divisions", e)));
    refreshRosterPlayers().catch((e) =>
      error(logError("players", e)),
    );
    loadClubMembers().catch((e) =>
      error(logError("club-members", e)),
    );
    refreshChampionships().catch((e) =>
      error(logError("championships", e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonId]);

  // Load detail when selection changes.
  useEffect(() => {
    if (!championshipForSelection) {
      setDetail(null);
      return;
    }
    loadDetail(championshipForSelection.id).catch((e) =>
      error(logError("detail", e)),
    );
  }, [championshipForSelection, loadDetail]);

  async function ensureChampionshipExists(): Promise<ChampionshipRow | null> {
    if (championshipForSelection) return championshipForSelection;
    if (!selectedDivision) return null;
    setBusy(true);
    try {
      const created = await api<ChampionshipRow>("/api/championships", {
        method: "POST",
        body: JSON.stringify({
          seasonId: seasonId || undefined,
          division: selectedDivision,
        }),
      });
      setChampionships((cur) => [...cur, created]);
      show(`Created ${created.name}`);
      return created;
    } catch (e) {
      error(logError("create", e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleAddEntry(
    primarySsmId: number,
    partnerSsmId: number | null,
  ) {
    const d = detail;
    if (!d) return;

    const primaryMember = clubMembers.find((m) => m.ssmId === primarySsmId);
    if (!primaryMember) {
      error("Could not find the selected member.");
      return;
    }

    const isDoubles = d.championship.format === "doubles";
    if (isDoubles) {
      if (partnerSsmId == null) {
        error("Choose both players before adding a doubles team.");
        return;
      }
      if (partnerSsmId === primarySsmId) {
        error("Primary and partner must be different people.");
        return;
      }
    }
    setBusy(true);
    try {
      const primaryPlayer = await ensureClubMemberPlayer(primaryMember);
      let partnerPlayerId: string | undefined;
      if (isDoubles && partnerSsmId != null) {
        const pm = clubMembers.find((m) => m.ssmId === partnerSsmId);
        if (!pm) {
          error("Could not find the partner member.");
          return;
        }
        const pp = await ensureClubMemberPlayer(pm);
        partnerPlayerId = pp.id;
      }

      await api(`/api/championships/${d.championship.id}/entries`, {
        method: "POST",
        body: JSON.stringify({
          playerId: primaryPlayer.id,
          partnerPlayerId,
        }),
      });
      await loadDetail(d.championship.id);
      await refreshRosterPlayers();
      show(isDoubles ? "Pair added." : "Player added.");
    } catch (e) {
      error(logError("add-entry", e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveEntry(entryId: string) {
    if (!detail) return;
    setBusy(true);
    try {
      await api(
        `/api/championships/${detail.championship.id}/entries/${entryId}`,
        { method: "DELETE" },
      );
      await loadDetail(detail.championship.id);
    } catch (e) {
      error(logError("remove-entry", e));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateSeed(entryId: string, seed: number | null) {
    if (!detail) return;
    setBusy(true);
    try {
      await api(
        `/api/championships/${detail.championship.id}/entries/${entryId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ seed }),
        },
      );
      await loadDetail(detail.championship.id);
    } catch (e) {
      error(logError("update-seed", e));
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateDraw() {
    if (!detail) return;
    setBusy(true);
    try {
      const updated = await api<ChampionshipDetail>(
        `/api/championships/${detail.championship.id}/draw`,
        { method: "POST" },
      );
      setDetail(updated);
      show("Draw generated. Review the bracket below.");
    } catch (e) {
      error(logError("generate", e));
    } finally {
      setBusy(false);
    }
  }

  async function handlePublishDraw() {
    if (!detail) return;
    setBusy(true);
    try {
      const updated = await api<ChampionshipDetail>(
        `/api/championships/${detail.championship.id}/draw/publish`,
        { method: "POST" },
      );
      setDetail(updated);
      show("Draw published.");
    } catch (e) {
      error(logError("publish", e));
    } finally {
      setBusy(false);
    }
  }

  async function handleStageEmails(round: number) {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await api<{
        created: string[];
        skipped: { matchId: string; reason: string }[];
      }>(`/api/championships/${detail.championship.id}/email-matches`, {
        method: "POST",
        body: JSON.stringify({ round }),
      });
      const skippedNote = res.skipped.length
        ? ` Skipped ${res.skipped.length} match(es): ${res.skipped
            .map((s) => s.reason)
            .join(", ")}.`
        : "";
      show(
        `Staged ${res.created.length} draft email(s) in the email outbox.${skippedNote}`,
      );
      await loadDetail(detail.championship.id);
    } catch (e) {
      error(logError("email", e));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateMatch(
    matchId: string,
    patch: Record<string, unknown>,
  ) {
    if (!detail) return;
    setBusy(true);
    try {
      await api(
        `/api/championships/${detail.championship.id}/matches/${matchId}`,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
        },
      );
      await loadDetail(detail.championship.id);
    } catch (e) {
      error(logError("update-match", e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Club Championships</h1>
      <p className="champ-help">
        Manage draws by division under <strong>Divisions</strong>, or open{" "}
        <strong>Round schedule</strong> to set playoff round due dates once for the
        year (shared by every bracket).
      </p>

      <div className="champ-page-tabs" role="tablist" aria-label="Championship sections">
        <button
          type="button"
          role="tab"
          id="tab-divisions"
          aria-selected={pageTab === "divisions"}
          aria-controls="panel-divisions"
          className={pageTab === "divisions" ? "is-active" : ""}
          onClick={() => setPageTab("divisions")}
        >
          Divisions
        </button>
        <button
          type="button"
          role="tab"
          id="tab-schedule"
          aria-selected={pageTab === "schedule"}
          aria-controls="panel-schedule"
          className={pageTab === "schedule" ? "is-active" : ""}
          onClick={() => setPageTab("schedule")}
        >
          Round schedule
        </button>
      </div>

      {pageTab === "schedule" ? (
        <div
          id="panel-schedule"
          role="tabpanel"
          aria-labelledby="tab-schedule"
        >
          <ChampionshipRoundSchedulePanel
            seasonId={seasonId}
            clubYear={clubYear}
            busy={busy}
            setBusy={setBusy}
            show={show}
            error={error}
          />
        </div>
      ) : null}

      <div
        id="panel-divisions"
        role="tabpanel"
        aria-labelledby="tab-divisions"
        className="card row"
        hidden={pageTab !== "divisions"}
        style={{ alignItems: "flex-end" }}
      >
        <div className="champ-division-field">
          <label className="champ-division-label">
            Division{" "}
            <select
              className="champ-division-select"
              value={selectedCode}
              onChange={(e) => setSelectedCode(e.target.value)}
              aria-describedby="champ-division-legend"
            >
              {divisions.map((d) => {
                const code = divisionCode(d);
                const created = divisionCodesCreatedForSeason.has(code);
                return (
                  <option key={code} value={code}>
                    {divisionDisplayName(d)}
                    {created ? " ✓" : ""}
                  </option>
                );
              })}
            </select>
          </label>
          <p id="champ-division-legend" className="champ-division-legend">
            ✓ = a championship exists for this year (division created).
          </p>
        </div>
        {!championshipForSelection && selectedDivision ? (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={ensureChampionshipExists}
          >
            Create division for this year
          </button>
        ) : null}
        {championshipForSelection ? (
          <span className={`champ-badge champ-badge--${detail?.championship.status ?? championshipForSelection.status}`}>
            {(detail?.championship.status ?? championshipForSelection.status).toUpperCase()}
          </span>
        ) : null}
      </div>

      {detail && pageTab === "divisions" ? (
        <>
          <RosterCard
            detail={detail}
            clubMembers={clubMembers}
            rosterPlayers={rosterPlayers}
            membersLoading={membersLoading}
            busy={busy}
            onAdd={handleAddEntry}
            onRemove={handleRemoveEntry}
            onUpdateSeed={handleUpdateSeed}
            onGenerate={handleGenerateDraw}
          />
          {detail.activeDraw ? (
            <BracketCard
              detail={detail}
              rosterPlayers={rosterPlayers}
              clubMembers={clubMembers}
              membersLoading={membersLoading}
              onEnsuredTestEmailPlayer={refreshRosterPlayers}
              busy={busy}
              notifySuccess={show}
              notifyError={error}
              onPublish={handlePublishDraw}
              onStageEmails={handleStageEmails}
              onUpdateMatch={handleUpdateMatch}
            />
          ) : null}
        </>
      ) : null}
      {!detail && selectedDivision && pageTab === "divisions" ? (
        <div className="card champ-empty">
          No division yet for this year. Click{" "}
          <strong>Create division for this year</strong> above to start
          enrolling players.
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ChampionshipRoundSchedulePanel({
  seasonId,
  clubYear,
  busy,
  setBusy,
  show,
  error,
}: {
  seasonId: string;
  clubYear: number | null;
  busy: boolean;
  setBusy: (next: boolean) => void;
  show: (msg: string) => void;
  error: (msg: string) => void;
}) {
  const [seasonLabel, setSeasonLabel] = useState("");
  const [rounds, setRounds] = useState<Record<string, string>>(() =>
    scheduleJsonToFormState(null),
  );

  useEffect(() => {
    let cancelled = false;
    api<SeasonRoundScheduleRow[]>("/api/seasons")
      .then((rows) => {
        if (cancelled) return;
        if (clubYear != null) {
          const sameYear = rows
            .filter((r) => r.clubYear === clubYear)
            .sort((a, b) =>
              compareSeasonSegments(a.calendarSegment, b.calendarSegment),
            );
          if (sameYear.length === 0) {
            setSeasonLabel("");
            setRounds(scheduleJsonToFormState(null));
            return;
          }
          let mergedJson: string | null = null;
          for (const r of sameYear) {
            const j = r.championshipRoundDueDatesJson?.trim();
            if (j) {
              mergedJson = r.championshipRoundDueDatesJson;
              break;
            }
          }
          setSeasonLabel(sameYear[0]?.name ?? "");
          setRounds(scheduleJsonToFormState(mergedJson));
          return;
        }
        const s = rows.find((r) => r.id === seasonId);
        if (!s) {
          setSeasonLabel("");
          setRounds(scheduleJsonToFormState(null));
          return;
        }
        setSeasonLabel(s.name);
        setRounds(scheduleJsonToFormState(s.championshipRoundDueDatesJson));
      })
      .catch((e) => error(logError("season-round-schedule", e)));
    return () => {
      cancelled = true;
    };
  }, [seasonId, clubYear]);

  async function handleSave() {
    setBusy(true);
    try {
      const roundsPayload: Record<string, string | null> = {};
      for (const n of CHAMPIONSHIP_KNOCKOUT_STAGE_ORDER) {
        const k = String(n);
        const raw = rounds[k]?.trim() ?? "";
        roundsPayload[k] = raw === "" ? null : raw;
      }
      await api<SeasonRoundScheduleRow>(
        `/api/seasons/${encodeURIComponent(seasonId)}/championship-round-dates`,
        {
          method: "PATCH",
          body: JSON.stringify({ rounds: roundsPayload }),
        },
      );
      show("Saved championship round schedule.");
    } catch (e) {
      error(logError("save-round-schedule", e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card champ-round-schedule">
      <h2 style={{ margin: 0 }}>Round due dates</h2>
      <p className="champ-help-small" style={{ marginTop: "0.5rem" }}>
        {clubYear != null || seasonLabel ? (
          <>
            These dates apply to <strong>every</strong> club championship bracket
            in <strong>
              {clubYear != null ? clubYear : seasonLabel}
            </strong>
            . When you stage emails from a bracket,
            the due date is taken from the matching stage below (Round of 32 through
            Final — the same names as the bracket column headings).
          </>
        ) : (
          <>Loading schedule…</>
        )}
      </p>
      <div className="champ-round-schedule-grid">
        {CHAMPIONSHIP_KNOCKOUT_STAGE_ORDER.map((n: number) => (
          <label key={n} className="champ-round-schedule-field">
            <span className="champ-round-schedule-label">
              {knockoutStageLabel(n)} — complete by
            </span>
            <input
              type="date"
              value={rounds[String(n)] ?? ""}
              onChange={(ev) =>
                setRounds((cur) => ({
                  ...cur,
                  [String(n)]: ev.target.value,
                }))
              }
              disabled={busy}
            />
          </label>
        ))}
      </div>
      <div style={{ marginTop: "1rem" }}>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void handleSave()}
        >
          Save schedule
        </button>
      </div>
    </div>
  );
}

function RosterCard({
  detail,
  clubMembers,
  rosterPlayers,
  membersLoading,
  busy,
  onAdd,
  onRemove,
  onUpdateSeed,
  onGenerate,
}: {
  detail: ChampionshipDetail;
  clubMembers: ClubMember[];
  rosterPlayers: PlayerRow[];
  membersLoading: boolean;
  busy: boolean;
  onAdd: (
    primarySsmId: number,
    partnerSsmId: number | null,
  ) => void | Promise<void>;
  onRemove: (entryId: string) => void;
  onUpdateSeed: (entryId: string, seed: number | null) => void;
  onGenerate: () => void;
}) {
  const [doublesPrimarySsmId, setDoublesPrimarySsmId] = useState<number | null>(
    null,
  );
  const [doublesPartnerSsmId, setDoublesPartnerSsmId] = useState<number | null>(
    null,
  );
  const isDoubles = detail.championship.format === "doubles";

  useEffect(() => {
    setDoublesPrimarySsmId(null);
    setDoublesPartnerSsmId(null);
  }, [detail.championship.id]);

  const enrolledSsmIds = useMemo(() => {
    const byPlayerId = new Map(rosterPlayers.map((p) => [p.id, p]));
    const set = new Set<number>();
    for (const e of detail.entries) {
      for (const pid of [e.playerId, e.partnerPlayerId] as (string | null)[]) {
        if (!pid) continue;
        const p = byPlayerId.get(pid);
        const ext = p?.externalId?.trim();
        if (!ext) continue;
        const n = Number(ext);
        if (Number.isFinite(n)) set.add(n);
      }
    }
    return set;
  }, [detail.entries, rosterPlayers]);

  const excludedForSinglesAdd = useMemo(
    () => new Set(enrolledSsmIds),
    [enrolledSsmIds],
  );

  const excludedForDoublesPrimary = useMemo(() => {
    const s = new Set(enrolledSsmIds);
    if (doublesPartnerSsmId != null) s.add(doublesPartnerSsmId);
    return s;
  }, [enrolledSsmIds, doublesPartnerSsmId]);

  const excludedForDoublesPartner = useMemo(() => {
    const s = new Set(enrolledSsmIds);
    if (doublesPrimarySsmId != null) s.add(doublesPrimarySsmId);
    return s;
  }, [enrolledSsmIds, doublesPrimarySsmId]);

  const addRowDisabled = membersLoading || busy || clubMembers.length === 0;

  const doublesPairReady =
    doublesPrimarySsmId != null &&
    doublesPartnerSsmId != null &&
    doublesPrimarySsmId !== doublesPartnerSsmId;

  const partnerSearchInputRef = useRef<HTMLInputElement>(null);
  const prevDoublesPrimaryRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isDoubles || addRowDisabled) return;
    if (doublesPrimarySsmId == null) {
      prevDoublesPrimaryRef.current = null;
      return;
    }
    const prev = prevDoublesPrimaryRef.current;
    if (prev === doublesPrimarySsmId) return;
    prevDoublesPrimaryRef.current = doublesPrimarySsmId;
    const id = window.setTimeout(() => {
      partnerSearchInputRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(id);
  }, [isDoubles, doublesPrimarySsmId, addRowDisabled]);

  return (
    <div className="card champ-roster">
      <div className="champ-roster-head">
        <h2 style={{ margin: 0 }}>Players in {detail.championship.name}</h2>
        <span className="champ-count">
          {detail.entries.length} entr{detail.entries.length === 1 ? "y" : "ies"}
        </span>
      </div>

      <div className="champ-add-row">
        <div
          className="row"
          style={{ flexWrap: "wrap", gap: "1rem", alignItems: "flex-end" }}
        >
          {!isDoubles ? (
            <MemberSearchSelect
              idPrefix="champ-primary"
              label="Add player"
              members={clubMembers}
              excludedSsmIds={excludedForSinglesAdd}
              valueSsmId={null}
              onChange={() => {}}
              commitOnSelect
              onCommit={(ssmId) => {
                void onAdd(ssmId, null);
              }}
              disabled={addRowDisabled}
            />
          ) : (
            <>
              <MemberSearchSelect
                idPrefix="champ-doubles-p1"
                label="Primary"
                members={clubMembers}
                excludedSsmIds={excludedForDoublesPrimary}
                valueSsmId={doublesPrimarySsmId}
                onChange={setDoublesPrimarySsmId}
                disabled={addRowDisabled}
              />
              <MemberSearchSelect
                idPrefix="champ-doubles-p2"
                label="Partner"
                members={clubMembers}
                excludedSsmIds={excludedForDoublesPartner}
                valueSsmId={doublesPartnerSsmId}
                onChange={setDoublesPartnerSsmId}
                disabled={addRowDisabled}
                inputRef={partnerSearchInputRef}
              />
              <button
                type="button"
                className="primary"
                disabled={addRowDisabled || !doublesPairReady}
                onClick={async () => {
                  if (
                    doublesPrimarySsmId == null ||
                    doublesPartnerSsmId == null ||
                    doublesPrimarySsmId === doublesPartnerSsmId
                  ) {
                    return;
                  }
                  await onAdd(doublesPrimarySsmId, doublesPartnerSsmId);
                  setDoublesPrimarySsmId(null);
                  setDoublesPartnerSsmId(null);
                }}
              >
                Add pair
              </button>
            </>
          )}
        </div>
        {isDoubles ? (
          <p className="champ-doubles-hint">
            Select both teammates, then click <strong>Add pair</strong> to sign
            them up as one team. Entries without a partner are not allowed.
          </p>
        ) : null}
      </div>

      {membersLoading ? (
        <p className="champ-help-small" style={{ marginTop: "0.5rem" }}>
          Loading club members…
        </p>
      ) : clubMembers.length === 0 ? (
        <p className="champ-empty" style={{ marginTop: "0.5rem" }}>
          No club members loaded. Use the Members tab to confirm the list loads,
          then refresh this page.
        </p>
      ) : null}

      {detail.entries.length === 0 ? (
        <p className="champ-empty">
          No players signed up yet. Add players above.
        </p>
      ) : (
        <table className="champ-table">
          <thead>
            <tr>
              <th>Seed</th>
              <th>Player</th>
              {isDoubles ? <th>Partner</th> : null}
              <th>Email</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {detail.entries.map((e) => (
              <tr key={e.id}>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={detail.entries.length}
                    value={e.seed ?? ""}
                    onChange={(ev) => {
                      const v = ev.target.value.trim();
                      const next = v === "" ? null : Number(v);
                      onUpdateSeed(e.id, next);
                    }}
                    style={{ width: "4.5rem" }}
                  />
                </td>
                <td>{e.playerName}</td>
                {isDoubles ? <td>{e.partnerName ?? "—"}</td> : null}
                <td className="champ-email-cell">
                  {e.playerEmail ?? <span className="champ-missing">—</span>}
                </td>
                <td>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => onRemove(e.id)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row" style={{ marginTop: "0.75rem" }}>
        <button
          type="button"
          className="primary"
          disabled={detail.entries.length < 2 || busy}
          onClick={onGenerate}
        >
          {detail.activeDraw
            ? "Re-generate draw (replaces current bracket)"
            : "Generate draw"}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** Preset when opening test email from bracket (null = blank form). */
type TestEmailFormPreset = {
  recipients: PlayerRow[];
  subject: string;
  body: string;
  /** Extra `{{variables}}` merged on send (matchup lines, etc.). */
  templateContext?: Record<string, string>;
} | null;

type EmailTemplateRow = {
  id: string;
  name: string;
  subjectTemplate: string;
  bodyTemplate: string;
};

function matchEligibleForBracketTestEmail(
  match: MatchRow,
  entryById: Map<string, EnrichedEntry>,
): boolean {
  if (match.topIsBye === 1 || match.bottomIsBye === 1) return false;
  if (!match.topEntryId || !match.bottomEntryId) return false;
  return !!(
    entryById.get(match.topEntryId) && entryById.get(match.bottomEntryId)
  );
}

function playerIdsForChampionshipEntry(e: EnrichedEntry): string[] {
  const ids = [e.playerId];
  if (e.partnerPlayerId) ids.push(e.partnerPlayerId);
  return ids;
}

function rosterPlayerRowsFromMatchEntries(
  rosterById: Map<string, PlayerRow>,
  top: EnrichedEntry,
  bottom: EnrichedEntry,
): PlayerRow[] {
  const seen = new Set<string>();
  const out: PlayerRow[] = [];
  for (const e of [top, bottom]) {
    for (const pid of playerIdsForChampionshipEntry(e)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const p = rosterById.get(pid);
      if (p) out.push(p);
    }
  }
  return out;
}

function ChampBracketMailGlyph() {
  return (
    <svg
      className="champ-match-mail-svg"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

function BracketCard({
  detail,
  rosterPlayers,
  clubMembers,
  membersLoading,
  onEnsuredTestEmailPlayer,
  busy,
  notifySuccess,
  notifyError,
  onPublish,
  onStageEmails,
  onUpdateMatch,
}: {
  detail: ChampionshipDetail;
  rosterPlayers: PlayerRow[];
  clubMembers: ClubMember[];
  membersLoading: boolean;
  onEnsuredTestEmailPlayer: () => Promise<void>;
  busy: boolean;
  notifySuccess: (msg: string) => void;
  notifyError: (msg: string) => void;
  onPublish: () => void;
  onStageEmails: (round: number) => void;
  onUpdateMatch: (matchId: string, patch: Record<string, unknown>) => void;
}) {
  const [emailRound, setEmailRound] = useState(1);
  const [testEmailOpen, setTestEmailOpen] = useState(false);
  const [testEmailPreset, setTestEmailPreset] =
    useState<TestEmailFormPreset>(null);
  const [testEmailModalNonce, setTestEmailModalNonce] = useState(0);
  const draw = detail.activeDraw!;
  const entryById = useMemo(
    () => new Map(detail.entries.map((e) => [e.id, e])),
    [detail.entries],
  );
  const rosterById = useMemo(
    () => new Map(rosterPlayers.map((p) => [p.id, p])),
    [rosterPlayers],
  );
  const rounds = useMemo(() => groupMatchesByRound(draw.matches), [draw.matches]);

  function openBlankTestEmailModal() {
    setTestEmailPreset(null);
    setTestEmailModalNonce((n) => n + 1);
    setTestEmailOpen(true);
  }

  function openMatchBracketTestEmail(m: MatchRow) {
    if (!matchEligibleForBracketTestEmail(m, entryById)) return;
    const top = entryById.get(m.topEntryId!)!;
    const bottom = entryById.get(m.bottomEntryId!)!;
    const recipients = rosterPlayerRowsFromMatchEntries(rosterById, top, bottom);
    if (recipients.length === 0) {
      notifyError(
        "Could not load roster rows for both sides — refresh the page or Members list.",
      );
      return;
    }
    const vsBracket = `${formatEntryBracket(top)} vs ${formatEntryBracket(bottom)}`;
    const vsFull = `${formatEntry(top)} vs ${formatEntry(bottom)}`;
    setTestEmailPreset({
      recipients,
      subject: `[Test] ${detail.championship.name}: ${vsBracket}`,
      body:
        `Hi,\n\nThis message is about your club championship match (${detail.championship.name}).\n\n` +
        `Matchup: ${vsFull}\n\n`,
      templateContext: {
        matchupBracket: vsBracket,
        matchupFull: vsFull,
        matchDueDate: m.dueDate?.trim() ?? "",
        championshipName: detail.championship.name,
        matchRound: knockoutStageLabel(
          entrantsAtBracketRoundStart(draw.size, m.round),
        ),
      },
    });
    setTestEmailModalNonce((n) => n + 1);
    setTestEmailOpen(true);
  }

  useEffect(() => {
    setEmailRound((prev) =>
      Math.min(Math.max(1, prev), Math.max(1, rounds.length)),
    );
  }, [detail.championship.id, rounds.length]);

  return (
    <div className="card champ-bracket-card">
      <div className="champ-bracket-head">
        <h2 style={{ margin: 0 }}>Bracket</h2>
        <span className={`champ-badge champ-badge--${draw.status}`}>
          {draw.status.toUpperCase()}
        </span>
        <span className="champ-meta">
          {draw.size}-player single elimination · {rounds.length} round
          {rounds.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="champ-bracket">
        {rounds.map((roundMatches, idx) => (
          <div key={idx} className="champ-round">
            <h4 className="champ-round-title">
              {knockoutStageLabel(
                entrantsAtBracketRoundStart(draw.size, idx + 1),
              )}
            </h4>
            <div className="champ-round-list">
              {roundMatches.map((m) => (
                <MatchCard
                  key={m.id}
                  match={m}
                  entryById={entryById}
                  entries={detail.entries}
                  busy={busy}
                  onBracketTestEmail={() => openMatchBracketTestEmail(m)}
                  onUpdateMatch={onUpdateMatch}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="row champ-bracket-actions">
        {draw.status === "draft" ? (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={onPublish}
          >
            Publish draw
          </button>
        ) : (
          <span className="champ-published-note">
            Draw is published. You can still modify matches and add entries
            below.
          </span>
        )}

        <label className="champ-email-round-row">
          Email matches in{" "}
          <select
            className="champ-email-round-select"
            value={emailRound}
            onChange={(e) => setEmailRound(Number(e.target.value))}
            disabled={busy}
            aria-label="Bracket round to email"
          >
            {rounds.map((_, i) => {
              const rn = i + 1;
              return (
                <option key={rn} value={rn}>
                  {knockoutStageLabel(
                    entrantsAtBracketRoundStart(draw.size, rn),
                  )}
                </option>
              );
            })}
          </select>
        </label>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => onStageEmails(emailRound)}
        >
          Stage match emails
        </button>
        <button
          type="button"
          className="secondary champ-test-email-btn"
          title="Temporary: send one-off test mail to a chosen roster player."
          disabled={busy}
          onClick={openBlankTestEmailModal}
        >
          Test email…
        </button>
      </div>
      {testEmailOpen ? (
        <TestEmailModal
          key={testEmailModalNonce}
          preset={testEmailPreset}
          defaultSubstitutionContext={{
            championshipName: detail.championship.name,
          }}
          clubMembers={clubMembers}
          membersLoading={membersLoading}
          onEnsuredPlayer={onEnsuredTestEmailPlayer}
          busy={busy}
          onClose={() => {
            setTestEmailOpen(false);
            setTestEmailPreset(null);
          }}
          onSent={(msg) => notifySuccess(msg)}
          onFail={(msg) => notifyError(msg)}
        />
      ) : null}
      <p className="champ-help-small">
        “Stage match emails” adds a draft email per match in the selected round to
        the Email outbox (dates come from the{" "}
        <strong>Round schedule</strong> tab). Approve and send from there.
      </p>
    </div>
  );
}

function formatMatchScheduledAtLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function MatchCard({
  match,
  entryById,
  entries,
  busy,
  onBracketTestEmail,
  onUpdateMatch,
}: {
  match: MatchRow;
  entryById: Map<string, EnrichedEntry>;
  entries: EnrichedEntry[];
  busy: boolean;
  onBracketTestEmail: () => void;
  onUpdateMatch: (matchId: string, patch: Record<string, unknown>) => void;
}) {
  const top = match.topEntryId ? entryById.get(match.topEntryId) : null;
  const bottom = match.bottomEntryId ? entryById.get(match.bottomEntryId) : null;

  function handleSlotChange(
    side: "top" | "bottom",
    nextEntryId: string | null,
  ) {
    onUpdateMatch(match.id, {
      [side === "top" ? "topEntryId" : "bottomEntryId"]: nextEntryId,
    });
  }

  function handleWinner(winnerId: string | null) {
    onUpdateMatch(match.id, { winnerEntryId: winnerId });
  }

  const slotOptions = entries;
  const bracketEmailEnabled = matchEligibleForBracketTestEmail(match, entryById);

  return (
    <div className={`champ-match ${match.winnerEntryId ? "has-winner" : ""}`}>
      <div className={`champ-slot ${match.winnerEntryId === match.topEntryId ? "champ-slot--winner" : ""}`}>
        <span className="champ-seed">{top?.seed ?? ""}</span>
        <select
          className="champ-slot-entry-select"
          aria-label="Top entry"
          value={match.topEntryId ?? ""}
          disabled={busy || match.topIsBye === 1}
          onChange={(e) =>
            handleSlotChange("top", e.target.value || null)
          }
        >
          <option value="">— change —</option>
          {slotOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {formatEntryBracket(opt)}
            </option>
          ))}
        </select>
      </div>
      <div className={`champ-slot ${match.winnerEntryId === match.bottomEntryId ? "champ-slot--winner" : ""}`}>
        <span className="champ-seed">{bottom?.seed ?? ""}</span>
        <select
          className="champ-slot-entry-select"
          aria-label="Bottom entry"
          value={match.bottomEntryId ?? ""}
          disabled={busy || match.bottomIsBye === 1}
          onChange={(e) =>
            handleSlotChange("bottom", e.target.value || null)
          }
        >
          <option value="">— change —</option>
          {slotOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {formatEntryBracket(opt)}
            </option>
          ))}
        </select>
      </div>
      {match.scheduledAt ? (
        <div className="champ-match-scheduled" title={match.scheduledAt}>
          <span className="champ-match-scheduled-label">Scheduled</span>
          <span className="champ-match-scheduled-time">
            {formatMatchScheduledAtLocal(match.scheduledAt)}
          </span>
        </div>
      ) : null}
      <div className="champ-match-actions">
        <button
          type="button"
          className="champ-match-mail"
          aria-label={
            bracketEmailEnabled
              ? "Send test email about this matchup"
              : "Test email unavailable until both entrants are known and neither side is a bye"
          }
          title={
            bracketEmailEnabled
              ? "Prefill test email with this matchup’s entrants"
              : "Available when both spots are filled and neither side is a bye"
          }
          disabled={busy || !bracketEmailEnabled}
          onClick={onBracketTestEmail}
        >
          <ChampBracketMailGlyph />
        </button>
        <div className="champ-match-winner-cell">
          <label className="champ-match-winner">
            Winner{" "}
            <select
              value={match.winnerEntryId ?? ""}
              disabled={busy || (!match.topEntryId && !match.bottomEntryId)}
              onChange={(e) => handleWinner(e.target.value || null)}
            >
              <option value="">—</option>
              {match.topEntryId ? (
                <option value={match.topEntryId}>
                  {top ? formatEntry(top) : "Top"}
                </option>
              ) : null}
              {match.bottomEntryId ? (
                <option value={match.bottomEntryId}>
                  {bottom ? formatEntry(bottom) : "Bottom"}
                </option>
              ) : null}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}

function formatEntry(e: EnrichedEntry): string {
  const seedTag = e.seed ? `[${e.seed}] ` : "";
  return e.partnerName
    ? `${seedTag}${e.playerName} / ${e.partnerName}`
    : `${seedTag}${e.playerName}`;
}

/** Shorter label for cramped bracket slots: first initial + last name */
function abbrevPersonName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return displayName.trim();
  if (parts.length === 1) return parts[0]!;
  const initial = parts[0]![0]?.toUpperCase() ?? "?";
  const last = parts[parts.length - 1]!;
  return `${initial}. ${last}`;
}

function formatEntryBracket(e: EnrichedEntry): string {
  const seedTag = e.seed ? `[${e.seed}] ` : "";
  return e.partnerName
    ? `${seedTag}${abbrevPersonName(e.playerName)} / ${abbrevPersonName(e.partnerName)}`
    : `${seedTag}${abbrevPersonName(e.playerName)}`;
}

/** Club member SSM id stored on roster `PlayerRow.externalId` after from-club-member upsert. */
function clubSsmIdFromPlayerRow(p: PlayerRow): number | null {
  const ext = p.externalId?.trim();
  if (!ext) return null;
  const n = Number(ext);
  return Number.isFinite(n) ? n : null;
}

/** Mirrors `todayIsoLocalDate()` in the API (local calendar date string). */
function todayIsoLocalDateClient(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Matches `/api/emails/test-send` variable construction for each recipient
 * (`playerName`, `playerName2`–`4`, `date` plus merged client vars).
 */
function substitutionVarsForTestSendRecipient(
  recipients: { id: string; displayName: string }[],
  recipientIndex: number,
  baseVars: Record<string, string>,
): Record<string, string> {
  const rows = recipients;
  const date = todayIsoLocalDateClient();
  if (rows.length === 0) {
    return {
      ...baseVars,
      playerName: "Alex Player",
      playerName2: "Taylor Team",
      playerName3: "Jordan Roe",
      playerName4: "Pat Partner",
      date,
    };
  }
  const clamped =
    recipientIndex >= 0 && recipientIndex < rows.length
      ? recipientIndex
      : 0;
  const r = rows[clamped]!;
  const others = rows
    .filter((x) => x.id !== r.id)
    .map((x) => x.displayName)
    .slice(0, 3);
  return {
    ...baseVars,
    playerName: r.displayName,
    playerName2: others[0] ?? "",
    playerName3: others[1] ?? "",
    playerName4: others[2] ?? "",
    date,
  };
}

function TestEmailModal({
  preset,
  defaultSubstitutionContext = {},
  clubMembers,
  membersLoading,
  onEnsuredPlayer,
  busy,
  onClose,
  onSent,
  onFail,
}: {
  preset: TestEmailFormPreset;
  /** Always applied (e.g. `championshipName`); merged with preset’s `templateContext` on send. */
  defaultSubstitutionContext?: Record<string, string>;
  clubMembers: ClubMember[];
  membersLoading: boolean;
  onEnsuredPlayer: () => Promise<void>;
  busy: boolean;
  onClose: () => void;
  onSent: (msg: string) => void;
  onFail: (msg: string) => void;
}) {
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplateRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    api<EmailTemplateRow[]>("/api/email-templates")
      .then((rows) => {
        if (!cancelled) setEmailTemplates(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const [recipients, setRecipients] = useState<PlayerRow[]>(
    () => preset?.recipients ?? [],
  );
  const [subject, setSubject] = useState(
    () => preset?.subject ?? "[Test] Director email",
  );
  const [body, setBody] = useState(() => preset?.body ?? "");
  const [sending, setSending] = useState(false);
  const [previewRecipientIdx, setPreviewRecipientIdx] = useState(0);

  /** String keys only — matches `/api/emails/test-send` JSON payloads. */
  const mergedSubstitutionBase = useMemo(() => {
    const out: Record<string, string> = {};
    const mergeVars = (
      obj: Record<string, string | undefined> | undefined,
    ): void => {
      if (!obj) return;
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        out[k] = String(v);
      }
    };
    mergeVars(defaultSubstitutionContext);
    mergeVars(preset?.templateContext);
    return out;
  }, [defaultSubstitutionContext, preset]);

  useEffect(() => {
    setPreviewRecipientIdx((idx) => {
      if (recipients.length === 0) return 0;
      return Math.min(idx, recipients.length - 1);
    });
  }, [recipients]);

  const previewVars = useMemo(
    () =>
      substitutionVarsForTestSendRecipient(
        recipients,
        previewRecipientIdx,
        mergedSubstitutionBase,
      ),
    [recipients, previewRecipientIdx, mergedSubstitutionBase],
  );

  const previewSubjectResolved = useMemo(() => {
    const tpl = subject.trim() || "[Test] Director email";
    return interpolateEmailTemplate(tpl, previewVars).trim();
  }, [subject, previewVars]);

  const previewBodyResolved = useMemo(
    () => interpolateEmailTemplate(body, previewVars).trim(),
    [body, previewVars],
  );

  const excludedSsmIds = useMemo(() => {
    const s = new Set<number>();
    for (const r of recipients) {
      const sid = clubSsmIdFromPlayerRow(r);
      if (sid != null) s.add(sid);
    }
    return s;
  }, [recipients]);

  const addRecipientDisabled =
    busy || sending || membersLoading || clubMembers.length === 0;

  async function handleAddRecipient(ssmId: number) {
    const m = clubMembers.find((x) => x.ssmId === ssmId);
    if (!m) {
      onFail("Could not find that member.");
      return;
    }
    const clubEmail = (m.email ?? "").trim();
    if (!clubEmail) {
      onFail(`${memberDisplayName(m)} has no email in Club Locker.`);
      return;
    }
    try {
      const playerRow = await ensureClubMemberPlayer(m);
      const em = (playerRow.email ?? "").trim();
      if (!em) {
        onFail("Player record has no email after sync.");
        return;
      }
      setRecipients((cur) => {
        if (cur.some((r) => r.id === playerRow.id)) return cur;
        return [...cur, playerRow];
      });
      await onEnsuredPlayer();
    } catch (err) {
      onFail(err instanceof Error ? err.message : String(err));
    }
  }

  function removeRecipient(playerId: string) {
    setRecipients((cur) => cur.filter((r) => r.id !== playerId));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (recipients.length === 0) {
      onFail("Add at least one recipient.");
      return;
    }
    if (!body.trim()) {
      onFail("Enter a message body.");
      return;
    }
    setSending(true);
    try {
      await api<{ ok?: boolean; error?: string }>("/api/emails/test-send", {
        method: "POST",
        body: JSON.stringify({
          playerIds: recipients.map((r) => r.id),
          subject: subject.trim() || "[Test] Director email",
          body: body.trim(),
          substitutionVars: mergedSubstitutionBase,
        }),
      });
      const names = recipients.map((r) => r.displayName).join(", ");
      onSent(
        `Test email sent to ${recipients.length} recipient(s): ${names}.`,
      );
      onClose();
    } catch (err) {
      onFail(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="champ-test-email-backdrop"
      role="presentation"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        className="champ-test-email-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="champ-test-email-title"
      >
        <h3 id="champ-test-email-title">Send test email</h3>
        <p className="champ-help-small" style={{ marginTop: 0 }}>
          Sends immediately through the configured email adapter to each address
          below (use for your own account or willing testers — not for bulk
          mail).
        </p>
        <form onSubmit={(ev) => void handleSubmit(ev)}>
          <div className="champ-test-email-field">
            <label htmlFor="champ-email-template-load">Email template</label>
            <select
              id="champ-email-template-load"
              className="champ-email-template-select"
              value=""
              onChange={(ev) => {
                const id = ev.target.value;
                ev.target.value = "";
                if (!id) return;
                const t = emailTemplates.find((x) => x.id === id);
                if (t) {
                  setSubject(t.subjectTemplate);
                  setBody(t.bodyTemplate);
                }
              }}
              disabled={busy || sending || emailTemplates.length === 0}
              aria-label="Load saved email template"
            >
              <option value="">
                {emailTemplates.length === 0
                  ? "— No templates (create under Emails) —"
                  : "— Load a template… —"}
              </option>
              {emailTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="champ-test-email-field">
            <MemberSearchSelect
              idPrefix="champ-test-email-add"
              label="Add recipient"
              members={clubMembers}
              excludedSsmIds={excludedSsmIds}
              valueSsmId={null}
              onChange={() => {}}
              disabled={addRecipientDisabled}
              commitOnSelect
              onCommit={(ssmId) => {
                void handleAddRecipient(ssmId);
              }}
            />
            {membersLoading ? (
              <p className="champ-help-small" style={{ marginTop: "0.35rem" }}>
                Loading club members…
              </p>
            ) : clubMembers.length === 0 ? (
              <p className="champ-help-small" style={{ marginTop: "0.35rem" }}>
                No club members loaded. Open the Members tab or refresh the page.
              </p>
            ) : null}
          </div>

          {recipients.length > 0 ? (
            <div className="champ-test-email-recipients">
              <div className="champ-test-email-recipients-label">Recipients</div>
              <ul className="champ-test-email-recipient-list">
                {recipients.map((r) => {
                  const em = (r.email ?? "").trim();
                  return (
                    <li key={r.id} className="champ-test-email-recipient-row">
                      <span className="champ-test-email-recipient-name">
                        {r.displayName}
                      </span>
                      <span
                        className="champ-test-email-recipient-email"
                        title={em || undefined}
                      >
                        {em || "—"}
                      </span>
                      <button
                        type="button"
                        className="secondary champ-test-email-recipient-remove"
                        disabled={sending}
                        aria-label={`Remove ${r.displayName}`}
                        onClick={() => removeRecipient(r.id)}
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="champ-help-small champ-test-email-recipients-empty">
              Search and pick people above to add them here. Each person gets
              their own copy of the message.
            </p>
          )}

          <label className="champ-test-email-field">
            <span>Subject</span>
            <input
              type="text"
              value={subject}
              onChange={(ev) => setSubject(ev.target.value)}
              disabled={busy || sending}
              autoComplete="off"
            />
            <p
              className="champ-test-email-resolved-hint"
              aria-live="polite"
            >
              <span className="champ-test-email-resolved-label">
                As sent — subject
              </span>{" "}
              {previewSubjectResolved}
            </p>
          </label>
          <label className="champ-test-email-field">
            <span>Body</span>
            <textarea
              value={body}
              onChange={(ev) => setBody(ev.target.value)}
              disabled={busy || sending}
              rows={8}
              required
              placeholder="Write the test message…"
            />
          </label>

          <div
            className="card champ-test-email-preview-card"
            style={{ marginBottom: "1rem", background: "#f8f9fa" }}
          >
            <h4 style={{ marginTop: 0 }}>Preview (as delivered)</h4>
            <p className="champ-help-small" style={{ marginTop: 0 }}>
              {recipients.length === 0 ? (
                <>
                  Showing sample names until you add recipients — each recipient
                  then gets{" "}
                  <code style={{ whiteSpace: "nowrap" }}>
                    {"{{playerName}}"}
                  </code>{" "}
                  and related fields resolved like the server.
                </>
              ) : recipients.length >= 2 ? (
                <>
                  Same interpolation as send; pick who to preview — others get the
                  same template with different{" "}
                  <code style={{ whiteSpace: "nowrap" }}>
                    {"{{playerName}}"}
                  </code>
                  /
                  <code style={{ whiteSpace: "nowrap" }}>{"{{playerName2}}"}</code>
                  /
                  …
                  .
                  <label
                    style={{
                      display: "block",
                      marginTop: "0.5rem",
                    }}
                  >
                    <span style={{ marginRight: "0.5rem" }}>Preview for</span>
                    <select
                      value={previewRecipientIdx}
                      onChange={(ev) =>
                        setPreviewRecipientIdx(Number(ev.target.value))
                      }
                      disabled={busy || sending}
                      aria-label="Which recipient to preview"
                    >
                      {recipients.map((r, i) => (
                        <option key={r.id} value={i}>
                          {r.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <>
                  Matches what will be sent to{" "}
                  <strong>{recipients[0]?.displayName}</strong> (add more
                  recipients to preview each copy).
                </>
              )}
            </p>
            <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>
              Subject:{" "}
              <span style={{ fontWeight: 400 }}>{previewSubjectResolved}</span>
            </p>
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                fontFamily: "inherit",
              }}
            >
              {previewBodyResolved}
            </pre>
          </div>

          <div className="champ-test-email-actions">
            <button
              type="button"
              className="secondary"
              disabled={sending}
              onClick={onClose}
            >
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy || sending}>
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function groupMatchesByRound(matches: MatchRow[]): MatchRow[][] {
  const map = new Map<number, MatchRow[]>();
  for (const m of matches) {
    if (!map.has(m.round)) map.set(m.round, []);
    map.get(m.round)!.push(m);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list.sort((a, b) => a.matchIndex - b.matchIndex));
}

