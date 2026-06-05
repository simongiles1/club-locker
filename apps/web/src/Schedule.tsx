import {
  formatWeekByesDisplay,
  formatWeekMatchupsDisplay,
  REGULAR_SEASON_BOX_LEVELS,
} from "@squash/shared";
import { useState } from "react";
import { Calendar, Trophy } from "lucide-react";

const ONE_VS_SIX_TOOLTIP =
  "Six players in a box each play every other player: that is “6 choose 2”, or 6×5/2 = 15 unique pairings. " +
  "The league uses two courts for seven weeks, so 2×7 = 14 of those matchups are placed on the schedule. " +
  "The one pairing that does not fit is 1 v 6, which you arrange yourselves.";

/** Eight Monday slots — 40 minutes apart from **4:30 pm** through **9:10 pm starts** (**9:50 pm** end). */
const MONDAY_TIMES = [
  "4:30pm",
  "5:10pm",
  "5:50pm",
  "6:30pm",
  "7:10pm",
  "7:50pm",
  "8:30pm",
  "9:10pm",
] as const;

/** Same numbering as Monday keys; Tue “4:30/5:10/5:50” = lunch band, remainder = afternoons. */
const TUESDAY_TIMES = [
  "11:50am",
  "12:30pm",
  "1:10pm",
  "4:30pm",
  "5:10pm",
  "5:50pm",
  "6:30pm",
  "7:10pm",
] as const;

type PlayDay = "monday" | "tuesday";

const TIMES_BY_DAY: Record<PlayDay, readonly string[]> = {
  monday: MONDAY_TIMES,
  tuesday: TUESDAY_TIMES,
};

export type WeekRow = {
  weekLabel: string;
  isPlayoffs: boolean;
  title?: string;
  matches: string;
  byes: string;
  levels: number[];
};

/** Public rotation grid (Mondays = boxes 1–8, Tuesdays = 9–16 in the same order). */
export const leagueSchedule: WeekRow[] = [
  ...REGULAR_SEASON_BOX_LEVELS.map((levels, idx) => {
    const weekNum = idx + 1;
    return {
      weekLabel: `Week ${weekNum}`,
      isPlayoffs: false as const,
      matches: formatWeekMatchupsDisplay(weekNum),
      byes: formatWeekByesDisplay(weekNum),
      levels: [...levels],
    };
  }),
  {
    weekLabel: "Semi-Finals",
    isPlayoffs: true,
    title: "Semi-Finals",
    matches: "1st v 4th, 2nd v 3rd",
    byes: "",
    levels: [6, 1, 2, 3, 4, 5, 7, 8],
  },
];

function weekHeaderPrimary(week: WeekRow) {
  if (week.isPlayoffs) {
    return week.title ?? "Semi-Finals";
  }
  return week.weekLabel;
}

/** Add whole calendar days; keeps local Y-M-D (same approach as getCalculatedDate). */
function addCalendarDaysToIso(iso: string, delta: number): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + delta);
  return toIsoDateString(date);
}

function getCalculatedDate(
  startStr: string,
  weekOffset: number,
  playDay: PlayDay,
): string {
  if (!startStr) return "";
  const [y, m, d] = startStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + weekOffset * 7);
  if (playDay === "tuesday") {
    date.setDate(date.getDate() + 1);
  }
  const day = String(date.getDate()).padStart(2, "0");
  const monthNames = [
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
  ];
  const month = monthNames[date.getMonth()];
  return `${day}-${month}`;
}

/** First calendar Monday in October (local). */
function firstMondayInOctober(year: number): Date {
  const oct1 = new Date(year, 9, 1);
  const dow = oct1.getDay();
  const daysToMonday = (1 - dow + 7) % 7;
  return new Date(year, 9, 1 + daysToMonday);
}

function toIsoDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** First Monday in the upcoming October (next Oct whose first Monday is today or later). */
function defaultSeasonStartDate(): string {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let y = now.getFullYear();
  let monday = firstMondayInOctober(y);
  if (monday < todayStart) {
    monday = firstMondayInOctober(y + 1);
  }
  return toIsoDateString(monday);
}

function PlayDayToggle({
  playDay,
  onChange,
}: {
  playDay: PlayDay;
  onChange: (day: PlayDay) => void;
}) {
  return (
    <div className="schedule-day-toggle">
      <button
        type="button"
        className={
          playDay === "monday"
            ? "schedule-day-toggle-btn schedule-day-toggle-btn-active"
            : "schedule-day-toggle-btn"
        }
        aria-pressed={playDay === "monday"}
        onClick={() => onChange("monday")}
      >
        Monday
      </button>
      <button
        type="button"
        className={
          playDay === "tuesday"
            ? "schedule-day-toggle-btn schedule-day-toggle-btn-active"
            : "schedule-day-toggle-btn"
        }
        aria-pressed={playDay === "tuesday"}
        onClick={() => onChange("tuesday")}
      >
        Tuesday
      </button>
    </div>
  );
}

export function Schedule({ embedded = false }: { embedded?: boolean }) {
  const [startDate, setStartDate] = useState(defaultSeasonStartDate);
  const [playDay, setPlayDay] = useState<PlayDay>("monday");

  const times = TIMES_BY_DAY[playDay];

  return (
    <div>
      {embedded ? null : <h1>Schedule</h1>}
      {embedded ? null : (
        <p className="schedule-lead">
          Houseleague spring rotation. Set a season start date to show each
          week&apos;s calendar date; pick Monday or Tuesday for that day&apos;s
          timeslots. Monday night lists boxes 1–8; Tuesday lists boxes 9–16 (same
          rotation pattern). The table shows matchups, byes, and which box is on
          court at each time, for every week.
        </p>
      )}

      <div className="card schedule-controls">
        <div className="schedule-controls-main">
          <div className="schedule-controls-field">
            <label className="schedule-date-label" htmlFor="schedule-start-date">
              <Calendar className="schedule-inline-icon" aria-hidden />
              Season start date
            </label>
            <input
              id="schedule-start-date"
              type="date"
              value={
                playDay === "tuesday"
                  ? addCalendarDaysToIso(startDate, 1)
                  : startDate
              }
              onChange={(e) => {
                const v = e.target.value;
                if (!v) {
                  setStartDate("");
                  return;
                }
                setStartDate(
                  playDay === "tuesday"
                    ? addCalendarDaysToIso(v, -1)
                    : v,
                );
              }}
            />
          </div>
          <div
            className="schedule-controls-field"
            role="group"
            aria-label="Play day"
          >
            <span className="schedule-date-label schedule-day-toggle-label">
              Play day
            </span>
            <PlayDayToggle playDay={playDay} onChange={setPlayDay} />
          </div>
        </div>
        <div className="schedule-1v6-callout" role="note">
          <p id="schedule-1v6-desc" className="visually-hidden">
            {ONE_VS_SIX_TOOLTIP}
          </p>
          <p className="schedule-1v6-text">
            In each box, one pairing is not on the club schedule: you organize{" "}
            <button
              type="button"
              className="schedule-1v6-badge"
              aria-describedby="schedule-1v6-desc"
              title={ONE_VS_SIX_TOOLTIP}
            >
              1 v 6
            </button>{" "}
            on your own.
          </p>
        </div>
      </div>

      <div className="card schedule-week-card">
        <h2 className="schedule-section-title">Season schedule</h2>

        <div className="schedule-table-wrap">
          <table className="schedule-table schedule-table-grid">
            <thead>
              <tr>
                <th
                  scope="col"
                  className="schedule-col-corner"
                  aria-label="Time column"
                />
                {leagueSchedule.map((week, idx) => (
                  <th
                    key={week.weekLabel}
                    scope="col"
                    className="schedule-col-week-head"
                    title={week.isPlayoffs ? week.title : undefined}
                  >
                    <span className="schedule-week-head-inner">
                      <span className="schedule-week-name">
                        {weekHeaderPrimary(week)}
                        {week.isPlayoffs ? (
                          <Trophy
                            className="schedule-week-trophy"
                            aria-label="Playoffs"
                          />
                        ) : null}
                      </span>
                      <span className="schedule-week-cal">
                        {getCalculatedDate(startDate, idx, playDay) || "TBD"}
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
              <tr className="schedule-thead-meta">
                <th scope="row" className="schedule-row-label">
                  Matchups
                </th>
                {leagueSchedule.map((week) => (
                  <td
                    key={`m-${week.weekLabel}`}
                    className="schedule-cell-matchup"
                  >
                    {week.matches}
                  </td>
                ))}
              </tr>
              <tr className="schedule-thead-meta">
                <th scope="row" className="schedule-row-label">
                  Byes
                </th>
                {leagueSchedule.map((week) => (
                  <td
                    key={`b-${week.weekLabel}`}
                    className="schedule-cell-bye"
                  >
                    {week.byes || "—"}
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {times.map((time, idx) => (
                <tr key={`${playDay}-${idx}`}>
                  <th scope="row" className="schedule-cell-time">
                    {time}
                  </th>
                  {leagueSchedule.map((week) => {
                    const level = week.levels[idx];
                    const display =
                      playDay === "tuesday" ? level + 8 : level;
                    return (
                      <td
                        key={`${week.weekLabel}-${idx}`}
                        className="schedule-cell-level"
                      >
                        {display}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
