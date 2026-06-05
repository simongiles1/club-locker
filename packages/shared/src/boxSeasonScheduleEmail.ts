import { interpolateEmailTemplate } from "./emailTemplate.js";
import { bulkHoldSlotsForWeekday } from "./bulkSlotWindows.js";
import {
  boxNumberForScheduleSlot,
  MANAGED_BOX_NUMBER_MAX,
  REGULAR_SEASON_GRID_WEEKS,
} from "./leagueScheduleGrid.js";
import { OPEN_BOX_SEAT_LABEL } from "./boxRelativeRank.js";
import { getWeekMatchups } from "./rotation.js";

export type BoxScheduleSeatPlayer = {
  /** Seat 1–6 within the box. */
  seat: number;
  displayName: string;
};

export type BoxScheduleWeekSection = {
  week: number;
  matches: string[];
  /** Booked or scheduled pairings that no longer apply because a seat is vacant. */
  cancelledMatchups: string[];
  byeNames: string[];
};

export type BoxScheduleEmailContent = {
  boxNumber: number;
  managed: boolean;
  players: BoxScheduleSeatPlayer[];
  weeks: BoxScheduleWeekSection[];
  oneVsSixMatchLabel: string;
  playoffSemiFinalsLabel: string;
  playoffFinalsLabel: string;
};

export type BoxEmlSignatureInput = {
  signOffName?: string;
  signatureName?: string;
  signatureTitle?: string;
  signaturePhone?: string;
  signatureEmail?: string;
  signatureAddress?: string;
};

export type BoxEmlRenderInput = {
  seasonName: string;
  seasonStartDateLabel: string;
  content: BoxScheduleEmailContent;
} & BoxEmlSignatureInput;

const EMAIL_FONT =
  'font-family:Calibri,Arial,sans-serif;font-size:14px;line-height:1.55;color:#222;';

/** Season-start vs roster/booking change notification templates (each has 1–16 and 17+ variants). */
export type BoxEmlTemplatePurpose = "season_start" | "box_modification";

export const DEFAULT_BOX_EML_SUBJECT_TEMPLATE =
  "{{seasonName}} — Box {{boxNumber}} schedule";

export const DEFAULT_BOX_MODIFICATION_EML_SUBJECT_TEMPLATE =
  "{{seasonName}} — Box {{boxNumber}} schedule update";

const SECTION_HEADER_OPEN =
  `<hr style="border:none;border-top:1px solid #bbb;margin:18px 0 8px;">`;
const SECTION_HEADER_TITLE = (title: string) =>
  `<div style="${EMAIL_FONT}font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">${title}</div>`;
const SECTION_HEADER_CLOSE =
  `<hr style="border:none;border-top:1px solid #bbb;margin:8px 0 12px;">`;
const PARA = (inner: string) =>
  `<p style="${EMAIL_FONT}margin:0 0 0.35em;">${inner}</p>`;

/** Default body template — static copy is editable; placeholders are per-field data only. */
export const DEFAULT_BOX_EML_BODY_TEMPLATE = `<div style="${EMAIL_FONT}">
${PARA("Gents of Box {{boxNumber}},")}
${PARA(`You are scheduled to play in the <strong>{{seasonName}}</strong> starting <strong>{{seasonStartDateLabel}}</strong>. {{introScheduleNote}}`)}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Box {{boxNumber}} players")}${SECTION_HEADER_CLOSE}
${PARA("1. {{player1Name}}")}
${PARA("2. {{player2Name}}")}
${PARA("3. {{player3Name}}")}
${PARA("4. {{player4Name}}")}
${PARA("5. {{player5Name}}")}
${PARA("6. {{player6Name}}")}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 1")}${SECTION_HEADER_CLOSE}
${PARA("{{week1Match1}}")}
${PARA("{{week1Match2}}")}
{{week1ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 2")}${SECTION_HEADER_CLOSE}
${PARA("{{week2Match1}}")}
${PARA("{{week2Match2}}")}
{{week2ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 3")}${SECTION_HEADER_CLOSE}
${PARA("{{week3Match1}}")}
${PARA("{{week3Match2}}")}
{{week3ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 4")}${SECTION_HEADER_CLOSE}
${PARA("{{week4Match1}}")}
${PARA("{{week4Match2}}")}
{{week4ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 5")}${SECTION_HEADER_CLOSE}
${PARA("{{week5Match1}}")}
${PARA("{{week5Match2}}")}
{{week5ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 6")}${SECTION_HEADER_CLOSE}
${PARA("{{week6Match1}}")}
${PARA("{{week6Match2}}")}
{{week6ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 7")}${SECTION_HEADER_CLOSE}
${PARA("{{week7Match1}}")}
${PARA("{{week7Match2}}")}
{{week7ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("1v6 match — please arrange on your own time")}${SECTION_HEADER_CLOSE}
${PARA("{{oneVsSixMatch}}")}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Playoffs")}${SECTION_HEADER_CLOSE}
${PARA("Semi-Finals: {{playoffSemiFinalsLabel}}")}
${PARA("Finals: {{playoffFinalsLabel}}")}
${PARA("The top 4 players at the end of the regular season will advance to the playoffs.")}
<p style="${EMAIL_FONT}margin:1.25em 0 0.5em;">Any questions at all, please don&apos;t hesitate to get in touch.</p>
${PARA("{{signOffName}}")}
<div style="${EMAIL_FONT}margin-top:0.5em;">
<strong>{{signatureName}}</strong><br>
{{signatureTitle}}<br>
{{signaturePhone}}<br>
<a href="mailto:{{signatureEmail}}" style="color:#0563c1;">{{signatureEmail}}</a><br>
{{signatureAddress}}
</div>
</div>`;

/** Default body for box roster / schedule change emails (managed 1–16 and self-managed 17+). */
export const DEFAULT_BOX_MODIFICATION_EML_BODY_TEMPLATE = `<div style="${EMAIL_FONT}">
${PARA("Gents of Box {{boxNumber}},")}
${PARA(`There have been changes to your box in the <strong>{{seasonName}}</strong>{{boxChangeReasonClause}}. {{introScheduleNote}}`)}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Box {{boxNumber}} players")}${SECTION_HEADER_CLOSE}
${PARA("1. {{player1Name}}")}
${PARA("2. {{player2Name}}")}
${PARA("3. {{player3Name}}")}
${PARA("4. {{player4Name}}")}
${PARA("5. {{player5Name}}")}
${PARA("6. {{player6Name}}")}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 1")}${SECTION_HEADER_CLOSE}
{{week1Match1Block}}
{{week1Match2Block}}
{{week1CancelledBlock}}
{{week1ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 2")}${SECTION_HEADER_CLOSE}
{{week2Match1Block}}
{{week2Match2Block}}
{{week2CancelledBlock}}
{{week2ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 3")}${SECTION_HEADER_CLOSE}
{{week3Match1Block}}
{{week3Match2Block}}
{{week3CancelledBlock}}
{{week3ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 4")}${SECTION_HEADER_CLOSE}
{{week4Match1Block}}
{{week4Match2Block}}
{{week4CancelledBlock}}
{{week4ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 5")}${SECTION_HEADER_CLOSE}
{{week5Match1Block}}
{{week5Match2Block}}
{{week5CancelledBlock}}
{{week5ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 6")}${SECTION_HEADER_CLOSE}
{{week6Match1Block}}
{{week6Match2Block}}
{{week6CancelledBlock}}
{{week6ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Week 7")}${SECTION_HEADER_CLOSE}
{{week7Match1Block}}
{{week7Match2Block}}
{{week7CancelledBlock}}
{{week7ByesBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("1v6 match — please arrange on your own time")}${SECTION_HEADER_CLOSE}
{{oneVsSixMatchBlock}}
${SECTION_HEADER_OPEN}${SECTION_HEADER_TITLE("Playoffs")}${SECTION_HEADER_CLOSE}
${PARA("Semi-Finals: {{playoffSemiFinalsLabel}}")}
${PARA("Finals: {{playoffFinalsLabel}}")}
${PARA("The top 4 players at the end of the regular season will advance to the playoffs.")}
<p style="${EMAIL_FONT}margin:1.25em 0 0.5em;">Any questions at all, please don&apos;t hesitate to get in touch.</p>
${PARA("{{signOffName}}")}
<div style="${EMAIL_FONT}margin-top:0.5em;">
<strong>{{signatureName}}</strong><br>
{{signatureTitle}}<br>
{{signaturePhone}}<br>
<a href="mailto:{{signatureEmail}}" style="color:#0563c1;">{{signatureEmail}}</a><br>
{{signatureAddress}}
</div>
</div>`;

export const BOX_EML_TEMPLATE_VARIABLE_DESCRIPTIONS: {
  key: string;
  description: string;
}[] = [
  { key: "boxNumber", description: "League box number for this email." },
  { key: "seasonName", description: "House league season title." },
  {
    key: "seasonStartDateLabel",
    description: "Formatted season start date (e.g. Mon, 1 Jun 2026).",
  },
  {
    key: "introScheduleNote",
    description:
      "Intro detail after the opening line (season start vs box-change templates use different default wording; managed boxes mention court bookings, 17+ boxes mention self-scheduling).",
  },
  {
    key: "boxChangeReasonClause",
    description:
      "Box-change emails only: roster change phrase before the period (e.g. ` due to Anthony Berg withdrawing`). Empty for season-start emails.",
  },
  { key: "player1Name", description: "Seat 1 player display name." },
  { key: "player2Name", description: "Seat 2 player display name." },
  { key: "player3Name", description: "Seat 3 player display name." },
  { key: "player4Name", description: "Seat 4 player display name." },
  { key: "player5Name", description: "Seat 5 player display name." },
  { key: "player6Name", description: "Seat 6 player display name." },
  {
    key: "week1Match1",
    description: "Week 1 court 1 / first pairing (includes date & time on managed boxes).",
  },
  { key: "week1Match2", description: "Week 1 court 2 / second pairing." },
  {
    key: "week1ByesBlock",
    description: "Week 1 BYE paragraph HTML, or empty when nobody is on bye.",
  },
  {
    key: "week1CancelledBlock",
    description:
      "Box-change emails: HTML paragraphs for booked matches cancelled by a vacant seat (weeks 2–7 use weekNCancelledBlock).",
  },
  {
    key: "week2Match1",
    description: "Week 2 first pairing (same pattern for weeks 2–7).",
  },
  { key: "week2Match2", description: "Week 2 second pairing." },
  { key: "week2ByesBlock", description: "Week 2 BYE paragraph HTML, or empty." },
  { key: "week3Match1", description: "Week 3 first pairing." },
  { key: "week3Match2", description: "Week 3 second pairing." },
  { key: "week3ByesBlock", description: "Week 3 BYE paragraph HTML, or empty." },
  { key: "week4Match1", description: "Week 4 first pairing." },
  { key: "week4Match2", description: "Week 4 second pairing." },
  { key: "week4ByesBlock", description: "Week 4 BYE paragraph HTML, or empty." },
  { key: "week5Match1", description: "Week 5 first pairing." },
  { key: "week5Match2", description: "Week 5 second pairing." },
  { key: "week5ByesBlock", description: "Week 5 BYE paragraph HTML, or empty." },
  { key: "week6Match1", description: "Week 6 first pairing." },
  { key: "week6Match2", description: "Week 6 second pairing." },
  { key: "week6ByesBlock", description: "Week 6 BYE paragraph HTML, or empty." },
  { key: "week7Match1", description: "Week 7 first pairing." },
  { key: "week7Match2", description: "Week 7 second pairing." },
  { key: "week7ByesBlock", description: "Week 7 BYE paragraph HTML, or empty." },
  {
    key: "oneVsSixMatch",
    description: "The 1v6 pairing players must arrange themselves.",
  },
  {
    key: "playoffSemiFinalsLabel",
    description: 'Semi-finals timing (e.g. "Week starting 18 May").',
  },
  {
    key: "playoffFinalsLabel",
    description: 'Finals date line (e.g. "25 May, followed by Buffet Dinner").',
  },
  { key: "signOffName", description: "Short sign-off name before the signature block." },
  { key: "signatureName", description: "Full name in the signature block." },
  { key: "signatureTitle", description: "Job title in the signature block." },
  { key: "signaturePhone", description: "Phone line in the signature block." },
  { key: "signatureEmail", description: "Email address in the signature block." },
  { key: "signatureAddress", description: "Mailing address in the signature block." },
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

function formatPlayDateLabel(iso: string, day: "mon" | "tue"): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = day === "mon" ? "Mon" : "Tue";
  const month = date.toLocaleString("en-US", { month: "short" });
  return `${weekday}, ${d} ${month} ${y}`;
}

function formatShortDayMonth(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const month = date.toLocaleString("en-US", { month: "short" });
  return `${d} ${month}`;
}

function formatTimeWindow(begin: string, end: string): string {
  const fmt = (hhmm: string) => {
    const [hRaw, mRaw] = hhmm.split(":");
    const h = Number(hRaw);
    const m = Number(mRaw);
    const suffix = h >= 12 ? "pm" : "am";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
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

function isVacantSeat(
  players: readonly BoxScheduleSeatPlayer[],
  seat: number,
): boolean {
  const row = players.find((p) => p.seat === seat);
  return row?.displayName?.trim() === OPEN_BOX_SEAT_LABEL;
}

function boxHasVacantSeats(players: readonly BoxScheduleSeatPlayer[]): boolean {
  return players.some((p) => p.displayName.trim() === OPEN_BOX_SEAT_LABEL);
}

export type CancelledMatchBookingDetail = {
  dateLabel: string;
  court: string;
  timeLabel: string;
};

/** Wording for a booked week match that cannot proceed after a roster change. */
export function formatCancelledMatchupNotice(
  playerName: string,
  booking: CancelledMatchBookingDetail | null,
): string {
  if (booking) {
    return (
      `${playerName} was scheduled for ${booking.dateLabel} on ${booking.court} (${booking.timeLabel}), ` +
      `but that match has been cancelled following the roster change.`
    );
  }
  return (
    `${playerName} was scheduled for this week's box match, ` +
    `but that matchup has been cancelled following the roster change.`
  );
}

function pairTouchesVacantSeat(
  players: readonly BoxScheduleSeatPlayer[],
  pair: [number, number],
): boolean {
  return isVacantSeat(players, pair[0]) || isVacantSeat(players, pair[1]);
}

function formatMatchLabel(
  players: readonly BoxScheduleSeatPlayer[],
  pair: [number, number],
): string {
  const [a, b] = pair;
  return `${playerNameForSeat(players, a)} vs ${playerNameForSeat(players, b)}`;
}

function slotForBoxInWeek(
  boxNumber: number,
  week: number,
): { day: "mon" | "tue"; slotIdx: number } | null {
  for (const day of ["mon", "tue"] as const) {
    for (let slotIdx = 0; slotIdx < 8; slotIdx++) {
      if (boxNumberForScheduleSlot(week, day, slotIdx) === boxNumber) {
        return { day, slotIdx };
      }
    }
  }
  return null;
}

function courtLabelForIndex(court: 1 | 2): string {
  return court === 1 ? "Stadium" : "Center";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSectionHeader(title: string): string {
  return (
    `<hr style="border:none;border-top:1px solid #bbb;margin:18px 0 8px;">` +
    `<div style="${EMAIL_FONT}font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">${escapeHtml(title)}</div>` +
    `<hr style="border:none;border-top:1px solid #bbb;margin:8px 0 12px;">`
  );
}

function renderLine(text: string): string {
  return `<p style="${EMAIL_FONT}margin:0 0 0.35em;">${escapeHtml(text)}</p>`;
}

export function renderBoxEmlIntroParagraph(
  content: BoxScheduleEmailContent,
  input: Pick<BoxEmlRenderInput, "seasonName" | "seasonStartDateLabel">,
): string {
  if (content.managed) {
    return (
      `<p style="${EMAIL_FONT}margin:0 0 1em;">` +
      `You are scheduled to play in the <strong>${escapeHtml(input.seasonName)}</strong> starting <strong>${escapeHtml(input.seasonStartDateLabel)}</strong>. ` +
      `Below is your regular-season schedule with booked court times.</p>`
    );
  }
  return (
    `<p style="${EMAIL_FONT}margin:0 0 1em;">` +
    `You are scheduled to play in the <strong>${escapeHtml(input.seasonName)}</strong> starting <strong>${escapeHtml(input.seasonStartDateLabel)}</strong>. ` +
    `Below are your matchups for the regular season. Please arrange directly with your opponent and book your court through Club Locker.</p>`
  );
}

export function renderBoxEmlPlayerListSection(content: BoxScheduleEmailContent): string {
  const box = content.boxNumber;
  const parts = [renderSectionHeader(`Box ${box} players`)];
  for (const p of content.players) {
    parts.push(renderLine(`${p.seat}. ${p.displayName}`));
  }
  return parts.join("");
}

export function renderBoxEmlWeeklyScheduleSection(
  content: BoxScheduleEmailContent,
): string {
  const parts: string[] = [];
  for (const week of content.weeks) {
    parts.push(renderSectionHeader(`Week ${week.week}`));
    for (const match of week.matches) {
      parts.push(renderLine(match));
    }
    for (const line of week.cancelledMatchups) {
      parts.push(renderLine(line));
    }
    if (week.byeNames.length > 0) {
      parts.push(renderLine(`BYE: ${week.byeNames.join(", ")}`));
    }
  }
  return parts.join("");
}

export function renderBoxEmlOneVsSixSection(content: BoxScheduleEmailContent): string {
  return (
    renderSectionHeader("1v6 match — please arrange on your own time") +
    renderLine(content.oneVsSixMatchLabel)
  );
}

export function renderBoxEmlPlayoffsSection(content: BoxScheduleEmailContent): string {
  return (
    renderSectionHeader("Playoffs") +
    renderLine(`Semi-Finals: ${content.playoffSemiFinalsLabel}`) +
    renderLine(`Finals: ${content.playoffFinalsLabel}`) +
    renderLine(
      "The top 4 players at the end of the regular season will advance to the playoffs.",
    )
  );
}

export function renderBoxEmlSignatureBlock(input: BoxEmlSignatureInput): string {
  const signOff = input.signOffName?.trim() || "Martin";
  const name = input.signatureName?.trim() || signOff;
  const title = input.signatureTitle?.trim() || "Head Squash Pro";
  const phone = input.signaturePhone?.trim() || "B 416-862-1077 x 3146";
  const email = input.signatureEmail?.trim() || "mheath@thecambridgeclub.com";
  const address =
    input.signatureAddress?.trim() ||
    "100 Richmond St. West, 11th Fl. Toronto, ON M5H 3K6";

  return (
    `<p style="${EMAIL_FONT}margin:1.25em 0 0.5em;">Any questions at all, please don&apos;t hesitate to get in touch.</p>` +
    `<p style="${EMAIL_FONT}margin:0 0 1.25em;">${escapeHtml(signOff)}</p>` +
    `<div style="${EMAIL_FONT}margin-top:0.5em;">` +
    `<strong>${escapeHtml(name)}</strong><br>` +
    `${escapeHtml(title)}<br>` +
    `${escapeHtml(phone)}<br>` +
    `<a href="mailto:${escapeHtml(email)}" style="color:#0563c1;">${escapeHtml(email)}</a><br>` +
    `${escapeHtml(address)}` +
    `</div>`
  );
}

/**
 * Build the per-box schedule sections used in house-league season opener EML files.
 * Managed boxes (1–16) append booked date, court, and time to each match line.
 */
function bookingDetailForManagedMatch(
  boxNumber: number,
  week: number,
  startMondayISO: string,
  matchIdx: number,
): CancelledMatchBookingDetail | null {
  const slot = slotForBoxInWeek(boxNumber, week);
  if (!slot) return null;
  const slots = bulkHoldSlotsForWeekday(slot.day);
  const slotRow = slots[slot.slotIdx];
  if (!slotRow) return null;
  const weekMonday = addCalendarDays(startMondayISO, (week - 1) * 7);
  const weekTuesday = addCalendarDays(weekMonday, 1);
  const playIso = slot.day === "mon" ? weekMonday : weekTuesday;
  return {
    dateLabel: formatPlayDateLabel(playIso, slot.day),
    court: courtLabelForIndex((matchIdx === 0 ? 1 : 2) as 1 | 2),
    timeLabel: formatTimeWindow(slotRow.begin, slotRow.end),
  };
}

function appendWeekPairing(
  sortedPlayers: readonly BoxScheduleSeatPlayer[],
  pair: [number, number],
  matchIdx: number,
  managed: boolean,
  boxNumber: number,
  week: number,
  startMondayISO: string,
  matches: string[],
  cancelledMatchups: string[],
  splitVacantMatchups: boolean,
): void {
  const booking =
    managed && boxNumber <= MANAGED_BOX_NUMBER_MAX
      ? bookingDetailForManagedMatch(boxNumber, week, startMondayISO, matchIdx)
      : null;

  if (splitVacantMatchups && pairTouchesVacantSeat(sortedPlayers, pair)) {
    // Only managed boxes have Club Locker court bookings to cancel.
    if (managed) {
      for (const seat of pair) {
        if (isVacantSeat(sortedPlayers, seat)) continue;
        cancelledMatchups.push(
          formatCancelledMatchupNotice(
            playerNameForSeat(sortedPlayers, seat),
            booking,
          ),
        );
      }
    }
    return;
  }

  if (managed && booking) {
    matches.push(
      `${formatMatchLabel(sortedPlayers, pair)} — ${booking.dateLabel}, ${booking.court}, ${booking.timeLabel}`,
    );
  } else {
    matches.push(formatMatchLabel(sortedPlayers, pair));
  }
}

export function buildBoxSeasonScheduleEmailContent(
  boxNumber: number,
  players: readonly BoxScheduleSeatPlayer[],
  startMondayISO: string,
): BoxScheduleEmailContent {
  const managed = boxNumber <= MANAGED_BOX_NUMBER_MAX;
  const sortedPlayers = [...players].sort((a, b) => a.seat - b.seat);
  const splitVacantMatchups = boxHasVacantSeats(sortedPlayers);
  const weeks: BoxScheduleWeekSection[] = [];

  for (let week = 1; week <= REGULAR_SEASON_GRID_WEEKS; week++) {
    const mu = getWeekMatchups(week);
    const matches: string[] = [];
    const cancelledMatchups: string[] = [];
    const byeNames = mu.byes
      .map((seat) => playerNameForSeat(sortedPlayers, seat))
      .filter(
        (name, idx) =>
          !splitVacantMatchups || !isVacantSeat(sortedPlayers, mu.byes[idx]!),
      );

    mu.matches.forEach((pair, matchIdx) => {
      appendWeekPairing(
        sortedPlayers,
        pair,
        matchIdx,
        managed,
        boxNumber,
        week,
        startMondayISO,
        matches,
        cancelledMatchups,
        splitVacantMatchups,
      );
    });

    weeks.push({ week, matches, cancelledMatchups, byeNames });
  }

  const semiMonday = addCalendarDays(startMondayISO, REGULAR_SEASON_GRID_WEEKS * 7);
  const finalsMonday = addCalendarDays(semiMonday, 7);

  let oneVsSixMatchLabel = formatMatchLabel(sortedPlayers, [1, 6]);
  if (
    managed &&
    splitVacantMatchups &&
    pairTouchesVacantSeat(sortedPlayers, [1, 6])
  ) {
    const notices: string[] = [];
    for (const seat of [1, 6] as const) {
      if (isVacantSeat(sortedPlayers, seat)) continue;
      notices.push(
        formatCancelledMatchupNotice(
          playerNameForSeat(sortedPlayers, seat),
          null,
        ),
      );
    }
    oneVsSixMatchLabel = notices.join(" ");
  }

  return {
    boxNumber,
    managed,
    players: sortedPlayers,
    weeks,
    oneVsSixMatchLabel,
    playoffSemiFinalsLabel: `Week starting ${formatShortDayMonth(semiMonday)}`,
    playoffFinalsLabel: `${formatShortDayMonth(finalsMonday)}, followed by Buffet Dinner`,
  };
}

function byeBlockHtml(byeNames: string[]): string {
  if (byeNames.length === 0) return "";
  return renderLine(`BYE: ${byeNames.join(", ")}`);
}

function cancelledMatchupsBlockHtml(cancelledMatchups: string[]): string {
  if (cancelledMatchups.length === 0) return "";
  return cancelledMatchups.map((line) => renderLine(line)).join("");
}

/** Match line paragraph HTML, or empty when there is no second pairing / line. */
function optionalMatchLineBlockHtml(line: string): string {
  const text = line.trim();
  if (!text) return "";
  return renderLine(text);
}

function playerNameVar(
  players: readonly BoxScheduleSeatPlayer[],
  seat: number,
): string {
  return playerNameForSeat(players, seat);
}

function introScheduleNoteForPurpose(
  managed: boolean,
  purpose: BoxEmlTemplatePurpose,
): string {
  if (purpose === "box_modification") {
    return managed
      ? "The roster and court bookings for your box have been updated. Below is your revised regular-season schedule with booked court times."
      : "The roster for your box has been updated. Below is your revised match schedule for the regular season. Please arrange directly with your opponent and book your court through Club Locker.";
  }
  return managed
    ? "Below is your regular-season schedule with booked court times."
    : "Below are your matchups for the regular season. Please arrange directly with your opponent and book your court through Club Locker.";
}

export type BuildBoxEmlInterpolationVarsOptions = {
  /** e.g. ` due to Anthony Berg withdrawing` — box-change templates only. */
  boxChangeReasonClause?: string;
};

export function buildBoxEmlInterpolationVars(
  input: BoxEmlRenderInput,
  purpose: BoxEmlTemplatePurpose = "season_start",
  options: BuildBoxEmlInterpolationVarsOptions = {},
): Record<string, string> {
  const { content } = input;
  const signOff = input.signOffName?.trim() || "Martin";
  const signatureName = input.signatureName?.trim() || signOff;
  const signatureTitle = input.signatureTitle?.trim() || "Head Squash Pro";
  const signaturePhone = input.signaturePhone?.trim() || "B 416-862-1077 x 3146";
  const signatureEmail = input.signatureEmail?.trim() || "mheath@thecambridgeclub.com";
  const signatureAddress =
    input.signatureAddress?.trim() ||
    "100 Richmond St. West, 11th Fl. Toronto, ON M5H 3K6";

  const introScheduleNote = introScheduleNoteForPurpose(content.managed, purpose);

  const vars: Record<string, string> = {
    boxNumber: String(content.boxNumber),
    seasonName: input.seasonName,
    seasonStartDateLabel: input.seasonStartDateLabel,
    boxChangeReasonClause: options.boxChangeReasonClause ?? "",
    introScheduleNote,
    player1Name: playerNameVar(content.players, 1),
    player2Name: playerNameVar(content.players, 2),
    player3Name: playerNameVar(content.players, 3),
    player4Name: playerNameVar(content.players, 4),
    player5Name: playerNameVar(content.players, 5),
    player6Name: playerNameVar(content.players, 6),
    oneVsSixMatch: content.oneVsSixMatchLabel,
    playoffSemiFinalsLabel: content.playoffSemiFinalsLabel,
    playoffFinalsLabel: content.playoffFinalsLabel,
    signOffName: signOff,
    signatureName,
    signatureTitle,
    signaturePhone,
    signatureEmail,
    signatureAddress,
  };

  for (const week of content.weeks) {
    const n = week.week;
    const match1 = week.matches[0] ?? "";
    const match2 = week.matches[1] ?? "";
    vars[`week${n}Match1`] = match1;
    vars[`week${n}Match2`] = match2;
    vars[`week${n}Match1Block`] = optionalMatchLineBlockHtml(match1);
    vars[`week${n}Match2Block`] = optionalMatchLineBlockHtml(match2);
    vars[`week${n}CancelledBlock`] = cancelledMatchupsBlockHtml(
      week.cancelledMatchups,
    );
    vars[`week${n}ByesBlock`] = byeBlockHtml(week.byeNames);
  }

  vars.oneVsSixMatchBlock = optionalMatchLineBlockHtml(content.oneVsSixMatchLabel);

  // Legacy blob placeholders — kept so older saved templates still render.
  vars.introParagraph = renderBoxEmlIntroParagraph(content, input);
  vars.playerListSection = renderBoxEmlPlayerListSection(content);
  vars.weeklyScheduleSection = renderBoxEmlWeeklyScheduleSection(content);
  vars.oneVsSixSection = renderBoxEmlOneVsSixSection(content);
  vars.playoffsSection = renderBoxEmlPlayoffsSection(content);
  vars.signatureBlock = renderBoxEmlSignatureBlock(input);

  return vars;
}

export function renderBoxEmlBodyFromTemplate(
  bodyTemplate: string,
  vars: Record<string, string>,
): string {
  return interpolateEmailTemplate(bodyTemplate, vars);
}

export function renderBoxEmlSubjectFromTemplate(
  subjectTemplate: string,
  vars: Record<string, string>,
): string {
  return interpolateEmailTemplate(subjectTemplate, vars).trim();
}

export function renderBoxSeasonScheduleEmailHtml(input: BoxEmlRenderInput): string {
  const vars = buildBoxEmlInterpolationVars(input);
  return renderBoxEmlBodyFromTemplate(DEFAULT_BOX_EML_BODY_TEMPLATE, vars);
}

export function renderBoxSeasonScheduleEmailText(input: BoxEmlRenderInput): string {
  const signOff = input.signOffName?.trim() || "Martin";
  const name = input.signatureName?.trim() || signOff;
  const title = input.signatureTitle?.trim() || "Head Squash Pro";
  const phone = input.signaturePhone?.trim() || "B 416-862-1077 x 3146";
  const email = input.signatureEmail?.trim() || "mheath@thecambridgeclub.com";
  const address =
    input.signatureAddress?.trim() ||
    "100 Richmond St. West, 11th Fl. Toronto, ON M5H 3K6";
  const box = input.content.boxNumber;
  const lines: string[] = [`Gents of Box ${box},`, ""];

  if (input.content.managed) {
    lines.push(
      `You are scheduled to play in the ${input.seasonName} starting ${input.seasonStartDateLabel}. Below is your regular-season schedule with booked court times.`,
      "",
    );
  } else {
    lines.push(
      `You are scheduled to play in the ${input.seasonName} starting ${input.seasonStartDateLabel}. Below are your matchups for the regular season. Please arrange directly with your opponent and book your court through Club Locker.`,
      "",
    );
  }

  lines.push("------------------------------", `BOX ${box} PLAYERS`, "------------------------------");
  for (const p of input.content.players) {
    lines.push(`${p.seat}. ${p.displayName}`);
  }

  for (const week of input.content.weeks) {
    lines.push("", "------------------------------", `WEEK ${week.week}`, "------------------------------");
    for (const match of week.matches) {
      lines.push(match);
    }
    for (const line of week.cancelledMatchups) {
      lines.push(line);
    }
    if (week.byeNames.length > 0) {
      lines.push(`BYE: ${week.byeNames.join(", ")}`);
    }
  }

  lines.push(
    "",
    "------------------------------",
    "1v6 MATCH - Please arrange on your own time",
    "------------------------------",
    input.content.oneVsSixMatchLabel,
    "",
    "------------------------------",
    "PLAYOFFS",
    "------------------------------",
    `Semi-Finals: ${input.content.playoffSemiFinalsLabel}`,
    `Finals: ${input.content.playoffFinalsLabel}`,
    "The top 4 players at the end of the regular season will advance to the playoffs.",
    "",
    "Any questions at all, please don't hesitate to get in touch.",
    "",
    signOff,
    "",
    name,
    title,
    phone,
    email,
    address,
  );

  return lines.join("\r\n");
}

const MATCH_PARA_PLACEHOLDER_RE =
  /<p style="[^"]*margin:0 0 0\.35em;">\s*(\{\{week[1-7]Match[12]\}\}|\{\{oneVsSixMatch\}\})\s*<\/p>/g;

function upgradeBoxModificationMatchParagraphs(body: string): string {
  return body.replace(MATCH_PARA_PLACEHOLDER_RE, (_full, token: string) => {
    if (token === "{{oneVsSixMatch}}") return "{{oneVsSixMatchBlock}}";
    return token.replace("}}", "Block}}");
  });
}

/** Inject placeholders into saved box-change templates from before they existed. */
export function upgradeBoxModificationEmlBodyTemplate(body: string): string | null {
  let updated: string | null = null;
  let next = body;

  if (
    !next.includes("{{boxChangeReasonClause}}") &&
    next.includes(
      "There have been changes to your box in the <strong>{{seasonName}}</strong>.",
    )
  ) {
    next = next.replace(
      "There have been changes to your box in the <strong>{{seasonName}}</strong>.",
      "There have been changes to your box in the <strong>{{seasonName}}</strong>{{boxChangeReasonClause}}.",
    );
    updated = next;
  }

  const withBlocks = upgradeBoxModificationMatchParagraphs(next);
  if (withBlocks !== next) {
    next = withBlocks;
    updated = next;
  }

  for (let w = 1; w <= REGULAR_SEASON_GRID_WEEKS; w++) {
    const token = `{{week${w}CancelledBlock}}`;
    if (next.includes(token)) continue;
    const anchor = `{{week${w}ByesBlock}}`;
    if (!next.includes(anchor)) continue;
    next = next.replace(anchor, `${token}\n${anchor}`);
    updated = next;
  }

  return updated;
}

/** One-time upgrade from old blob-placeholder templates to the expanded default. */
export function upgradeLegacyBoxEmlBodyTemplate(body: string): string | null {
  const t = body.trim();
  if (
    t.includes("{{introParagraph}}") &&
    t.includes("{{signatureBlock}}") &&
    !t.includes("{{week1Match1}}")
  ) {
    return DEFAULT_BOX_EML_BODY_TEMPLATE;
  }
  return null;
}

export function boxEmlFilename(boxNumber: number): string {
  return `box-${String(boxNumber).padStart(2, "0")}.eml`;
}
