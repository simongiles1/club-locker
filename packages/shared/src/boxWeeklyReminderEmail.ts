import {
  MANAGED_BOX_NUMBER_MAX,
  REGULAR_SEASON_GRID_WEEKS,
} from "./leagueScheduleGrid.js";
import { getWeekMatchups } from "./rotation.js";
import {
  seasonWeekPlayDates,
  seasonWeekPlayDatesWithRegistry,
  type StatHoliday,
} from "./holidaySchedule.js";
import type { BoxScheduleSeatPlayer } from "./boxSeasonScheduleEmail.js";
import {
  renderBoxEmlBodyFromTemplate,
  renderBoxEmlSubjectFromTemplate,
  type BoxEmlSignatureInput,
} from "./boxSeasonScheduleEmail.js";

export type WeeklyBookedMatchLine = {
  player1Name: string;
  player2Name: string;
  /** YYYY-MM-DD */
  playDate: string;
  /** e.g. 19:30-20:15 */
  slot: string;
  courtLabel: string;
};

export type BoxWeeklyReminderContent = {
  boxNumber: number;
  managed: boolean;
  weekNumber: number;
  players: BoxScheduleSeatPlayer[];
  matches: string[];
  byeNames: string[];
  weekPlayDateLabel: string;
};

export type BoxWeeklyEmlRenderInput = {
  seasonName: string;
  content: BoxWeeklyReminderContent;
} & BoxEmlSignatureInput;

const EMAIL_FONT =
  'font-family:Calibri,Arial,sans-serif;font-size:14px;line-height:1.55;color:#222;';

export const DEFAULT_WEEKLY_BOX_SUBJECT_TEMPLATE =
  "{{seasonName}} — Box {{boxNumber}} — Week {{weekNumber}} matchups";

export const DEFAULT_WEEKLY_BOX_MANAGED_BODY_TEMPLATE = `<div style="${EMAIL_FONT}">
<p style="${EMAIL_FONT}margin:0 0 0.35em;">Gents of Box {{boxNumber}},</p>
<p style="${EMAIL_FONT}margin:0 0 1em;">Your <strong>{{seasonName}}</strong> matchups for <strong>week {{weekNumber}}</strong> ({{weekPlayDateLabel}}) are below. Courts and times are already booked in Club Locker.</p>
<hr style="border:none;border-top:1px solid #bbb;margin:18px 0 8px;">
<div style="${EMAIL_FONT}font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Week {{weekNumber}}</div>
<hr style="border:none;border-top:1px solid #bbb;margin:8px 0 12px;">
<p style="${EMAIL_FONT}margin:0 0 0.35em;">{{weekMatch1}}</p>
<p style="${EMAIL_FONT}margin:0 0 0.35em;">{{weekMatch2}}</p>
{{weekByesBlock}}
<p style="${EMAIL_FONT}margin:1.25em 0 0.5em;">Any questions at all, please don&apos;t hesitate to get in touch.</p>
<p style="${EMAIL_FONT}margin:0 0 1.25em;">{{signOffName}}</p>
<div style="${EMAIL_FONT}margin-top:0.5em;">
<strong>{{signatureName}}</strong><br>
{{signatureTitle}}<br>
{{signaturePhone}}<br>
<a href="mailto:{{signatureEmail}}" style="color:#0563c1;">{{signatureEmail}}</a><br>
{{signatureAddress}}
</div>
</div>`;

export const DEFAULT_WEEKLY_BOX_UNMANAGED_BODY_TEMPLATE = `<div style="${EMAIL_FONT}">
<p style="${EMAIL_FONT}margin:0 0 0.35em;">Gents of Box {{boxNumber}},</p>
<p style="${EMAIL_FONT}margin:0 0 1em;">Your <strong>{{seasonName}}</strong> matchups for <strong>week {{weekNumber}}</strong> are below. Please arrange directly with your opponent and book your court through Club Locker (or through the front desk, 6am–10pm).</p>
<hr style="border:none;border-top:1px solid #bbb;margin:18px 0 8px;">
<div style="${EMAIL_FONT}font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Week {{weekNumber}}</div>
<hr style="border:none;border-top:1px solid #bbb;margin:8px 0 12px;">
<p style="${EMAIL_FONT}margin:0 0 0.35em;">{{weekMatch1}}</p>
<p style="${EMAIL_FONT}margin:0 0 0.35em;">{{weekMatch2}}</p>
{{weekByesBlock}}
<p style="${EMAIL_FONT}margin:1.25em 0 0.5em;">Any questions at all, please don&apos;t hesitate to get in touch.</p>
<p style="${EMAIL_FONT}margin:0 0 1.25em;">{{signOffName}}</p>
<div style="${EMAIL_FONT}margin-top:0.5em;">
<strong>{{signatureName}}</strong><br>
{{signatureTitle}}<br>
{{signaturePhone}}<br>
<a href="mailto:{{signatureEmail}}" style="color:#0563c1;">{{signatureEmail}}</a><br>
{{signatureAddress}}
</div>
</div>`;

export const WEEKLY_BOX_TEMPLATE_VARIABLE_DESCRIPTIONS: {
  key: string;
  description: string;
}[] = [
  { key: "boxNumber", description: "League box number." },
  { key: "seasonName", description: "House league season title." },
  { key: "weekNumber", description: "Regular-season week (1–7)." },
  {
    key: "weekPlayDateLabel",
    description: "Human-readable play-week range (managed boxes).",
  },
  { key: "weekMatch1", description: "First pairing line for this week." },
  { key: "weekMatch2", description: "Second pairing line for this week." },
  {
    key: "weekByesBlock",
    description: "BYE paragraph HTML, or empty when nobody is on bye.",
  },
  { key: "player1Name", description: "Seat 1 player (optional in weekly template)." },
  { key: "signOffName", description: "Short sign-off before signature block." },
  { key: "signatureName", description: "Full name in signature block." },
  { key: "signatureTitle", description: "Job title in signature block." },
  { key: "signaturePhone", description: "Phone in signature block." },
  { key: "signatureEmail", description: "Email in signature block." },
  { key: "signatureAddress", description: "Address in signature block." },
];

function addCalendarDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + delta);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function calendarDaysBetween(startIso: string, endIso: string): number {
  const [y1, m1, d1] = startIso.split("-").map(Number);
  const [y2, m2, d2] = endIso.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/** YYYY-MM-DD in the server's local timezone. */
export function calendarDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatShortPlayDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleString("en-US", { weekday: "short" });
  const month = date.toLocaleString("en-US", { month: "short" });
  return `${weekday}, ${d} ${month} ${y}`;
}

function formatSlotLabel(slot: string): string {
  const [begin, end] = slot.split("-");
  if (!begin || !end) return slot;
  const fmt = (hhmm: string) => {
    const [hRaw, mRaw] = hhmm.split(":");
    const h = Number(hRaw);
    const m = Number(mRaw);
    const suffix = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m === 0
      ? `${h12}${suffix}`
      : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
  };
  return `${fmt(begin)}–${fmt(end)}`;
}

function playerNameForSeat(
  players: readonly BoxScheduleSeatPlayer[],
  seat: number,
): string {
  const row = players.find((p) => p.seat === seat);
  return row?.displayName?.trim() || `Player ${seat}`;
}

function formatPairingLabel(
  players: readonly BoxScheduleSeatPlayer[],
  pair: [number, number],
): string {
  return `${playerNameForSeat(players, pair[0])} vs ${playerNameForSeat(players, pair[1])}`;
}

function byeBlockHtml(byeNames: string[]): string {
  if (byeNames.length === 0) return "";
  return `<p style="${EMAIL_FONT}margin:0 0 0.35em;">BYE: ${byeNames.join(", ")}</p>`;
}

/**
 * Monday of the Mon/Tue play block announced on a Wednesday send (next calendar Monday).
 */
export function playMondayForWednesdayAnnouncement(now: Date): string {
  const todayIso = calendarDateLocal(now);
  const dow = now.getDay();
  let daysUntilMonday = (1 - dow + 7) % 7;
  if (daysUntilMonday === 0) daysUntilMonday = 7;
  return addCalendarDays(todayIso, daysUntilMonday);
}

export function isWednesdayLocal(now: Date): boolean {
  return now.getDay() === 3;
}

export type TargetWeekResolution = {
  weekNumber: number;
  playMonday: string;
  firstPlayDate: string;
  secondPlayDate: string;
  shiftedByHoliday: boolean;
  holidayName?: string;
};

/**
 * Map a Wednesday (or forced) send date to the regular-season week number and play dates.
 */
export function resolveTargetWeekForWednesday(
  now: Date,
  startMondayISO: string,
  holidays: readonly StatHoliday[] = [],
): TargetWeekResolution | null {
  const playMonday = playMondayForWednesdayAnnouncement(now);
  const dayOffset = calendarDaysBetween(startMondayISO, playMonday);
  if (dayOffset < 0) return null;
  const weekNumber = Math.floor(dayOffset / 7) + 1;
  if (weekNumber < 1 || weekNumber > REGULAR_SEASON_GRID_WEEKS) return null;

  const playDates =
    holidays.length > 0
      ? seasonWeekPlayDatesWithRegistry(startMondayISO, weekNumber, holidays)
      : seasonWeekPlayDates(startMondayISO, weekNumber);

  return {
    weekNumber,
    playMonday,
    firstPlayDate: playDates.firstPlayDate,
    secondPlayDate: playDates.secondPlayDate,
    shiftedByHoliday: playDates.shiftedByHoliday,
    holidayName: playDates.holidayName,
  };
}

export function formatWeekPlayDateLabel(
  firstPlayDate: string,
  secondPlayDate: string,
  shiftedByHoliday: boolean,
): string {
  if (shiftedByHoliday) {
    return `${formatShortPlayDate(firstPlayDate)} & ${formatShortPlayDate(secondPlayDate)}`;
  }
  return `${formatShortPlayDate(firstPlayDate)} & ${formatShortPlayDate(secondPlayDate)}`;
}

export function firstNameFromDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return name;
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

export function formatWeeklyManagedMatchLine(line: WeeklyBookedMatchLine): string {
  const dateLabel = formatShortPlayDate(line.playDate);
  const timeLabel = formatSlotLabel(line.slot);
  return `${line.player1Name} vs ${line.player2Name} — ${dateLabel}, ${line.courtLabel}, ${timeLabel}`;
}

/** Booking detail only (date, court, time) — used in per-matchup emails. */
export function formatWeeklyManagedBookingDetailLine(
  line: WeeklyBookedMatchLine,
): string {
  const dateLabel = formatShortPlayDate(line.playDate);
  const timeLabel = formatSlotLabel(line.slot);
  return `${dateLabel}, ${line.courtLabel}, ${timeLabel}`;
}

export function buildBoxWeeklyReminderContent(args: {
  boxNumber: number;
  weekNumber: number;
  players: readonly BoxScheduleSeatPlayer[];
  bookedMatches?: readonly WeeklyBookedMatchLine[];
  weekPlayDateLabel: string;
}): BoxWeeklyReminderContent {
  const managed = args.boxNumber <= MANAGED_BOX_NUMBER_MAX;
  const sortedPlayers = [...args.players].sort((a, b) => a.seat - b.seat);
  const mu = getWeekMatchups(args.weekNumber);
  const byeNames = mu.byes.map((seat) => playerNameForSeat(sortedPlayers, seat));

  let matches: string[];
  if (managed && args.bookedMatches && args.bookedMatches.length > 0) {
    matches = args.bookedMatches.map((m) => formatWeeklyManagedMatchLine(m));
  } else if (managed) {
    matches = [];
  } else {
    matches = mu.matches.map((pair) => formatPairingLabel(sortedPlayers, pair));
  }

  return {
    boxNumber: args.boxNumber,
    managed,
    weekNumber: args.weekNumber,
    players: sortedPlayers,
    matches,
    byeNames,
    weekPlayDateLabel: args.weekPlayDateLabel,
  };
}

export function buildWeeklyBoxInterpolationVars(
  input: BoxWeeklyEmlRenderInput,
): Record<string, string> {
  const { content } = input;
  const signOff = input.signOffName?.trim() || "Martin";
  const signatureName = input.signatureName?.trim() || signOff;
  const signatureTitle = input.signatureTitle?.trim() || "Head Squash Pro";
  const signaturePhone = input.signaturePhone?.trim() || "B 416-862-1077 x 3146";
  const signatureEmail =
    input.signatureEmail?.trim() || "mheath@thecambridgeclub.com";
  const signatureAddress =
    input.signatureAddress?.trim() ||
    "100 Richmond St. West, 11th Fl. Toronto, ON M5H 3K6";

  const vars: Record<string, string> = {
    boxNumber: String(content.boxNumber),
    seasonName: input.seasonName,
    weekNumber: String(content.weekNumber),
    weekPlayDateLabel: content.weekPlayDateLabel,
    weekMatch1: content.matches[0] ?? "",
    weekMatch2: content.matches[1] ?? "",
    weekByesBlock: byeBlockHtml(content.byeNames),
    player1Name: playerNameForSeat(content.players, 1),
    player2Name: playerNameForSeat(content.players, 2),
    player3Name: playerNameForSeat(content.players, 3),
    player4Name: playerNameForSeat(content.players, 4),
    player5Name: playerNameForSeat(content.players, 5),
    player6Name: playerNameForSeat(content.players, 6),
    signOffName: signOff,
    signatureName,
    signatureTitle,
    signaturePhone,
    signatureEmail,
    signatureAddress,
  };

  return vars;
}

export function renderWeeklyBoxBodyFromTemplate(
  bodyTemplate: string,
  vars: Record<string, string>,
): string {
  return renderBoxEmlBodyFromTemplate(bodyTemplate, vars);
}

export function renderWeeklyBoxSubjectFromTemplate(
  subjectTemplate: string,
  vars: Record<string, string>,
): string {
  return renderBoxEmlSubjectFromTemplate(subjectTemplate, vars);
}

export function renderWeeklyBoxEmailHtml(
  bodyTemplate: string,
  input: BoxWeeklyEmlRenderInput,
): string {
  const vars = buildWeeklyBoxInterpolationVars(input);
  return renderWeeklyBoxBodyFromTemplate(bodyTemplate, vars);
}

export function renderWeeklyBoxEmailText(input: BoxWeeklyEmlRenderInput): string {
  const { content } = input;
  const lines: string[] = [
    `Gents of Box ${content.boxNumber},`,
    "",
    `${input.seasonName} — week ${content.weekNumber}`,
    content.weekPlayDateLabel ? `Play dates: ${content.weekPlayDateLabel}` : "",
    "",
    `WEEK ${content.weekNumber}`,
  ];
  for (const m of content.matches) lines.push(m);
  if (content.byeNames.length > 0) {
    lines.push(`BYE: ${content.byeNames.join(", ")}`);
  }
  lines.push("", "Any questions at all, please don't hesitate to get in touch.", signOffLine(input));
  return lines.filter((l) => l !== undefined).join("\n");
}

function signOffLine(input: BoxWeeklyEmlRenderInput): string {
  const signOff = input.signOffName?.trim() || "Martin";
  const name = input.signatureName?.trim() || signOff;
  return `${signOff}\n${name}`;
}

export const DEFAULT_WEEKLY_MATCHUP_SUBJECT_TEMPLATE =
  "{{seasonName}} — Box {{boxNumber}} week {{weekNumber}} — {{matchupShortLabel}}";

export const DEFAULT_WEEKLY_MATCHUP_MANAGED_BODY_TEMPLATE = `<div style="${EMAIL_FONT}">
<p style="${EMAIL_FONT}margin:0 0 0.35em;">{{player1Name}} &amp; {{player2Name}},</p>
<p style="${EMAIL_FONT}margin:0 0 1em;">Your <strong>{{seasonName}}</strong> match for <strong>week {{weekNumber}}</strong> in <strong>Box {{boxNumber}}</strong> is booked:</p>
<p style="${EMAIL_FONT}margin:0 0 1em;"><strong>{{matchupLine}}</strong></p>
<p style="${EMAIL_FONT}margin:1.25em 0 0.5em;">Any questions at all, please don&apos;t hesitate to get in touch.</p>
<p style="${EMAIL_FONT}margin:0 0 1.25em;">{{signOffName}}</p>
<div style="${EMAIL_FONT}margin-top:0.5em;">
<strong>{{signatureName}}</strong><br>
{{signatureTitle}}<br>
{{signaturePhone}}<br>
<a href="mailto:{{signatureEmail}}" style="color:#0563c1;">{{signatureEmail}}</a><br>
{{signatureAddress}}
</div>
</div>`;

export const DEFAULT_WEEKLY_MATCHUP_UNMANAGED_BODY_TEMPLATE = `<div style="${EMAIL_FONT}">
<p style="${EMAIL_FONT}margin:0 0 0.35em;">{{player1Name}} &amp; {{player2Name}},</p>
<p style="${EMAIL_FONT}margin:0 0 1em;">You are scheduled to play each other in <strong>Box {{boxNumber}}</strong> for <strong>week {{weekNumber}}</strong> of the <strong>{{seasonName}}</strong>:</p>
<p style="${EMAIL_FONT}margin:0 0 1em;"><strong>{{matchupLine}}</strong></p>
<p style="${EMAIL_FONT}margin:0 0 1em;">Please arrange your court time and book through Club Locker (or the front desk, 6am–10pm).</p>
<p style="${EMAIL_FONT}margin:1.25em 0 0.5em;">Any questions at all, please don&apos;t hesitate to get in touch.</p>
<p style="${EMAIL_FONT}margin:0 0 1.25em;">{{signOffName}}</p>
<div style="${EMAIL_FONT}margin-top:0.5em;">
<strong>{{signatureName}}</strong><br>
{{signatureTitle}}<br>
{{signaturePhone}}<br>
<a href="mailto:{{signatureEmail}}" style="color:#0563c1;">{{signatureEmail}}</a><br>
{{signatureAddress}}
</div>
</div>`;

export const WEEKLY_MATCHUP_TEMPLATE_VARIABLE_DESCRIPTIONS: {
  key: string;
  description: string;
}[] = [
  { key: "boxNumber", description: "League box number." },
  { key: "seasonName", description: "House league season title." },
  { key: "weekNumber", description: "Regular-season week (1–7)." },
  { key: "weekPlayDateLabel", description: "Play-week date label (managed)." },
  {
    key: "matchupLine",
    description: "Booking detail for this match (date, court, time).",
  },
  { key: "matchupShortLabel", description: "Short label for subject (e.g. P1 vs P2)." },
  { key: "player1Name", description: "First name of the first player in this pairing." },
  { key: "player2Name", description: "First name of the second player in this pairing." },
  { key: "signOffName", description: "Short sign-off before signature block." },
  { key: "signatureName", description: "Full name in signature block." },
  { key: "signatureTitle", description: "Job title in signature block." },
  { key: "signaturePhone", description: "Phone in signature block." },
  { key: "signatureEmail", description: "Email in signature block." },
  { key: "signatureAddress", description: "Address in signature block." },
];

export type BoxWeeklyMatchupReminderContent = {
  boxNumber: number;
  managed: boolean;
  weekNumber: number;
  matchIndex: number;
  matchupLine: string;
  matchupShortLabel: string;
  player1Name: string;
  player2Name: string;
  weekPlayDateLabel: string;
};

export type BoxWeeklyMatchupRenderInput = {
  seasonName: string;
  content: BoxWeeklyMatchupReminderContent;
} & BoxEmlSignatureInput;

export function buildWeeklyMatchupInterpolationVars(
  input: BoxWeeklyMatchupRenderInput,
): Record<string, string> {
  const { content } = input;
  const signOff = input.signOffName?.trim() || "Martin";
  const signatureName = input.signatureName?.trim() || signOff;
  const signatureTitle = input.signatureTitle?.trim() || "Head Squash Pro";
  const signaturePhone = input.signaturePhone?.trim() || "B 416-862-1077 x 3146";
  const signatureEmail =
    input.signatureEmail?.trim() || "mheath@thecambridgeclub.com";
  const signatureAddress =
    input.signatureAddress?.trim() ||
    "100 Richmond St. West, 11th Fl. Toronto, ON M5H 3K6";

  return {
    boxNumber: String(content.boxNumber),
    seasonName: input.seasonName,
    weekNumber: String(content.weekNumber),
    weekPlayDateLabel: content.weekPlayDateLabel,
    matchupLine: content.matchupLine,
    matchupShortLabel: content.matchupShortLabel,
    player1Name: firstNameFromDisplayName(content.player1Name),
    player2Name: firstNameFromDisplayName(content.player2Name),
    signOffName: signOff,
    signatureName,
    signatureTitle,
    signaturePhone,
    signatureEmail,
    signatureAddress,
  };
}

export function renderWeeklyMatchupBodyFromTemplate(
  bodyTemplate: string,
  vars: Record<string, string>,
): string {
  return renderBoxEmlBodyFromTemplate(bodyTemplate, vars);
}

export function renderWeeklyMatchupSubjectFromTemplate(
  subjectTemplate: string,
  vars: Record<string, string>,
): string {
  return renderBoxEmlSubjectFromTemplate(subjectTemplate, vars);
}
