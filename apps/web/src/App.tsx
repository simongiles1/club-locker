import { useCallback, useEffect, useState } from "react";
import {
  defaultBookingSeasonAndStartMonday,
  formatLocalISODate,
  seasonStartMondayLocal,
  type BookingCalendarSeason,
} from "@squash/shared";
import { api } from "./api.js";
import { ChampionshipsPage } from "./ChampionshipsPage.js";
import { HouseleaguePage } from "./HouseleaguePage.js";
import { MembersPage } from "./MembersPage.js";

type Season = {
  id: string;
  name: string;
  status: string;
  clubYear: number | null;
  calendarSegment: string | null;
  startMondayDate: string | null;
  /** Round → YYYY-MM-DD for all club championships in this season */
  championshipRoundDueDatesJson: string | null;
};

function startMondayForSeasonRow(s: Season): string {
  if (s.startMondayDate) return s.startMondayDate;
  if (
    s.calendarSegment &&
    (s.calendarSegment === "winter" ||
      s.calendarSegment === "spring" ||
      s.calendarSegment === "summer" ||
      s.calendarSegment === "fall") &&
    s.clubYear != null
  ) {
    return formatLocalISODate(
      seasonStartMondayLocal(
        s.calendarSegment as BookingCalendarSeason,
        s.clubYear,
      ),
    );
  }
  return "";
}

/** winter → spring → summer → fall — one canonical season row per club-booking year for championships. */
const CALENDAR_SEGMENT_ORDER: Record<string, number> = {
  winter: 0,
  spring: 1,
  summer: 2,
  fall: 3,
};

function canonicalSeasonIdForClubYear(seasons: Season[], year: number): string {
  const rows = seasons.filter((s) => s.clubYear === year);
  if (rows.length === 0) return "";
  return [...rows].sort((a, b) => {
    const ao =
      a.calendarSegment != null
        ? (CALENDAR_SEGMENT_ORDER[a.calendarSegment] ?? 99)
        : 99;
    const bo =
      b.calendarSegment != null
        ? (CALENDAR_SEGMENT_ORDER[b.calendarSegment] ?? 99)
        : 99;
    return ao - bo;
  })[0]!.id;
}

function distinctClubYearsDescending(seasons: Season[]): number[] {
  const ys = new Set<number>();
  for (const s of seasons) {
    if (s.clubYear != null) ys.add(s.clubYear);
  }
  return [...ys].sort((a, b) => b - a);
}
type Tab =
  | "overview"
  | "registration"
  | "houseleague"
  | "championships"
  | "phase2"
  | "members";

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonId, setSeasonId] = useState<string>("");
  const setLog = useCallback((_msg: string) => {
    /* feedback UI removed */
  }, []);

  const refreshSeasons = useCallback(async () => {
    const s = await api<Season[]>("/api/seasons");
    setSeasons(s);
    setSeasonId((cur) => {
      const def = defaultBookingSeasonAndStartMonday();
      const match = s.find(
        (row) =>
          row.calendarSegment === def.season &&
          row.clubYear === def.clubYear,
      );
      if (match) return match.id;
      if (cur && s.some((x) => x.id === cur)) return cur;
      return s[0]?.id ?? "";
    });
  }, []);

  useEffect(() => {
    refreshSeasons().catch((e) => console.error(e));
  }, [refreshSeasons]);

  /** Championships are keyed by club-booking year; align with canonical segment row. */
  useEffect(() => {
    if (tab !== "championships") return;
    if (seasons.length === 0) return;
    const row = seasons.find((x) => x.id === seasonId);
    const cy = row?.clubYear;
    if (cy == null) return;
    const canon = canonicalSeasonIdForClubYear(seasons, cy);
    if (canon && canon !== seasonId) setSeasonId(canon);
  }, [tab, seasonId, seasons]);

  const seasonSelectControls = (
    <>
      <label>
        Season{" "}
        <select
          value={seasonId}
          onChange={(e) => setSeasonId(e.target.value)}
        >
          {seasons.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.status})
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="secondary" onClick={refreshSeasons}>
        Refresh
      </button>
    </>
  );

  const championshipYears = distinctClubYearsDescending(seasons);
  const championshipYearForSeasonId =
    seasons.find((x) => x.id === seasonId)?.clubYear ?? null;

  const championshipsYearControls = (
    <>
      <label>
        Year{" "}
        <select
          value={
            championshipYearForSeasonId != null
              ? String(championshipYearForSeasonId)
              : ""
          }
          onChange={(e) => {
            const raw = e.target.value;
            if (!raw) return;
            const year = Number(raw);
            if (!Number.isFinite(year)) return;
            const id = canonicalSeasonIdForClubYear(seasons, year);
            if (id) setSeasonId(id);
          }}
        >
          {championshipYears.length === 0 ? (
            <option value="">No club-booking years</option>
          ) : null}
          {championshipYearForSeasonId == null && championshipYears.length > 0 ? (
            <option value="">— pick year —</option>
          ) : null}
          {championshipYears.map((y) => (
            <option key={y} value={String(y)}>
              {y}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="secondary" onClick={refreshSeasons}>
        Refresh
      </button>
    </>
  );

  const headerSeasonControls =
    tab === "championships" ? championshipsYearControls : seasonSelectControls;

  const selectedSeason =
    seasons.find((x) => x.id === seasonId) ?? null;

  return (
    <div
      className={
        tab === "members" ? "layout layout--fill-viewport" : "layout"
      }
    >
      <nav>
        <strong>Director</strong>
        <button
          type="button"
          className={tab === "overview" ? "active" : ""}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          className={tab === "registration" ? "active" : ""}
          onClick={() => setTab("registration")}
        >
          Registration
        </button>
        <button
          type="button"
          className={tab === "houseleague" ? "active" : ""}
          onClick={() => setTab("houseleague")}
        >
          Houseleague
        </button>
        <button
          type="button"
          className={tab === "championships" ? "active" : ""}
          onClick={() => setTab("championships")}
        >
          Championships
        </button>
        <button
          type="button"
          className={tab === "members" ? "active" : ""}
          onClick={() => setTab("members")}
        >
          Members
        </button>
        <button
          type="button"
          className={tab === "phase2" ? "active" : ""}
          onClick={() => setTab("phase2")}
        >
          Phase 2
        </button>
      </nav>
      <main className={tab === "members" ? "main--fill-viewport" : undefined}>
        {tab === "houseleague" ? null : (
          <div className="row" style={{ marginBottom: "1rem" }}>
            {headerSeasonControls}
          </div>
        )}
        {tab === "overview" && (
          <Overview seasonId={seasonId} onLog={setLog} />
        )}
        {tab === "registration" && <Registration onLog={setLog} />}
        {tab === "houseleague" && (
          <HouseleaguePage
            seasonId={seasonId}
            seasonStartMondayISO={
              selectedSeason ? startMondayForSeasonRow(selectedSeason) : ""
            }
            seasonControls={seasonSelectControls}
            onLog={setLog}
          />
        )}
        {tab === "championships" && (
          <ChampionshipsPage
            seasonId={seasonId}
            clubYear={championshipYearForSeasonId}
          />
        )}
        {tab === "members" && <MembersPage />}
        {tab === "phase2" && <Phase2 seasonId={seasonId} onLog={setLog} />}
      </main>
    </div>
  );
}

function Overview({
  seasonId,
  onLog,
}: {
  seasonId: string;
  onLog: (s: string) => void;
}) {
  return (
    <div>
      <h1>Overview</h1>
      <p>
        Local-first director dashboard. Run API on port 3001; this UI proxies{" "}
        <code>/api</code>.
      </p>
      <div className="card">
        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={!seasonId}
            onClick={async () => {
              const res = await api<unknown>(`/api/seasons/${seasonId}/sync`, {
                method: "POST",
              });
              onLog(JSON.stringify(res, null, 2));
            }}
          >
            Sync Now (Club Locker mock)
          </button>
        </div>
      </div>
    </div>
  );
}

function Registration({ onLog }: { onLog: (s: string) => void }) {
  return (
    <div>
      <h1>Registration queue</h1>
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

function Phase2({
  seasonId,
  onLog,
}: {
  seasonId: string;
  onLog: (s: string) => void;
}) {
  return (
    <div>
      <h1>Phase 2 stubs</h1>
      <div className="card row">
        <button
          type="button"
          className="secondary"
          disabled={!seasonId}
          onClick={async () => {
            const res = await api<unknown>("/api/phase2/booking-proposals", {
              method: "POST",
              body: JSON.stringify({
                seasonId,
                weekNumber: 1,
                payload: {
                  weekNumber: 1,
                  assignments: [
                    {
                      boxNumber: 1,
                      match: [1, 2],
                      court: 1,
                      slotLabel: "Mon4:30",
                    },
                  ],
                },
              }),
            });
            onLog(JSON.stringify(res, null, 2));
          }}
        >
          Create booking proposal (stub)
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!seasonId}
          onClick={async () => {
            const res = await api<unknown>("/api/phase2/rating-adjustments", {
              method: "POST",
              body: JSON.stringify([
                { playerId: "x", suggestedDelta: 0.05, reason: "final win" },
              ]),
            });
            onLog(JSON.stringify(res, null, 2));
          }}
        >
          Try rating write-back (stub)
        </button>
      </div>
    </div>
  );
}
