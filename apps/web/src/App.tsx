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
import { FeedbackPage } from "./FeedbackPage.js";
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
type Tab = "houseleague" | "championships" | "members" | "feedback";

/** Members tab still renders when active; toggle to show the nav link again. */
const SHOW_MEMBERS_IN_NAV = false;

export function App() {
  const [tab, setTab] = useState<Tab>("houseleague");
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

  const seasonSelectorOnly = (
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
  );

  const seasonSelectControls = (
    <>
      {seasonSelectorOnly}
      <button type="button" className="secondary" onClick={refreshSeasons}>
        Refresh
      </button>
    </>
  );

  const championshipYears = distinctClubYearsDescending(seasons);
  const championshipYearForSeasonId =
    seasons.find((x) => x.id === seasonId)?.clubYear ?? null;

  const headerSeasonControls =
    tab === "championships" || tab === "feedback" ? null : seasonSelectControls;

  const selectedSeason =
    seasons.find((x) => x.id === seasonId) ?? null;

  return (
    <div
      className={
        tab === "members" ? "layout layout--fill-viewport" : "layout"
      }
    >
      <nav>
        <strong>CL Automation</strong>
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
          className={tab === "feedback" ? "active" : ""}
          onClick={() => setTab("feedback")}
        >
          Feedback
        </button>
        {SHOW_MEMBERS_IN_NAV ? (
          <button
            type="button"
            className={tab === "members" ? "active" : ""}
            onClick={() => setTab("members")}
          >
            Members
          </button>
        ) : null}
      </nav>
      <main className={tab === "members" ? "main--fill-viewport" : undefined}>
        {tab === "houseleague" ? null : headerSeasonControls != null ? (
          <div className="row" style={{ marginBottom: "1rem" }}>
            {headerSeasonControls}
          </div>
        ) : null}
        {tab === "houseleague" && (
          <HouseleaguePage
            seasonId={seasonId}
            seasonStartMondayISO={
              selectedSeason ? startMondayForSeasonRow(selectedSeason) : ""
            }
            bookingSeasonControls={seasonSelectorOnly}
            onLog={setLog}
          />
        )}
        {tab === "championships" && (
          <ChampionshipsPage
            seasonId={seasonId}
            clubYear={championshipYearForSeasonId}
            championshipYears={championshipYears}
            onSelectClubYear={(year) => {
              const id = canonicalSeasonIdForClubYear(seasons, year);
              if (id) setSeasonId(id);
            }}
          />
        )}
        {tab === "feedback" && <FeedbackPage />}
        {tab === "members" && <MembersPage />}
      </main>
    </div>
  );
}
