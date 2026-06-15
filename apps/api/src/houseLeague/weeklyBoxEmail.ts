import {
  buildBoxScheduleSeatPlayers,
  buildBoxWeeklyReminderContent,
  buildOutlookEmlFile,
  buildWeeklyBoxInterpolationVars,
  buildWeeklyMatchupInterpolationVars,
  formatWeekPlayDateLabel,
  formatWeeklyManagedBookingDetailLine,
  getWeekMatchups,
  livePlayerAtScheduleSeat,
  MANAGED_BOX_NUMBER_MAX,
  mergeUniqueEmailAddresses,
  renderWeeklyBoxBodyFromTemplate,
  renderWeeklyBoxEmailText,
  renderWeeklyBoxSubjectFromTemplate,
  renderWeeklyMatchupBodyFromTemplate,
  renderWeeklyMatchupSubjectFromTemplate,
  resolveTargetWeekForWednesday,
  scheduleMatchPairNeedsCourtBooking,
  seasonWeekPlayDatesWithRegistry,
  weeklyBoxEmlFilename,
  weeklyMatchupEmlFilename,
  WEEKLY_EMAIL_PER_BOX_MATCH_INDEX,
  type SeasonStartRosterPlayer,
  type WeeklyBookedMatchLine,
  type WeeklyEmailRecipientMode,
} from "@squash/shared";
import { and, asc, eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  houseLeagueBookedOccurrences,
  houseLeagueWeeklyBoxSends,
  players,
  seasonBookingHolds,
  statutoryHolidays,
} from "../db/schema.js";
import {
  createUssquashClient,
  type UssquashClient,
} from "../booking/clubLockerClient.js";
import {
  livePlayerDisplayName,
  normalizeLiveBoxLeaguePlayers,
  type LiveBoxLeaguePlayer,
} from "../booking/liveWeekPlan.js";
import type { EmailAdapter } from "../adapters/email.js";
import { stageAndMaybeSend } from "../automation/emailOutboxStage.js";
import type { StepRuntimeMode } from "../automation/executions.js";
import { inlineEmlTemplateAssets } from "./boxEmlAssets.js";
import { resolveSeasonMeta } from "./boxEmlFiles.js";
import { loadSeasonStartGroundTruthPlayers } from "./seasonStartRoster.js";
import { sanitizeRelativeRankOverridesForLiveSeason } from "./relativeRankOverrides.js";
import {
  getHouseLeagueWeeklyBoxEmailSettings,
  getHouseLeagueWeeklyEmailTemplateSettings,
  weeklyTemplatePairForManagedBox,
  type HouseLeagueWeeklyEmailTemplateSettings,
  type PartialHouseLeagueWeeklyEmailTemplateSettings,
} from "./weeklyBoxEmailTemplateSettings.js";

export type WeeklyBoxPreviewRow = {
  boxNumber: number;
  managed: boolean;
  subject: string;
  toAddresses: string[];
  missingEmailPlayers: string[];
  htmlBody: string;
  textBody: string;
  skippedReason?: string;
};

export type WeeklyEmailPreviewItem = {
  itemKey: string;
  recipientKind: "box" | "matchup";
  boxNumber: number;
  /** 0 for per-box; 1 or 2 for per-matchup. */
  matchIndex: number;
  label: string;
  managed: boolean;
  subject: string;
  toAddresses: string[];
  missingEmailPlayers: string[];
  htmlBody: string;
  textBody: string;
  skippedReason?: string;
};

export type WeeklyBoxEmailBundle = {
  seasonId: string;
  seasonName: string;
  startMondayISO: string;
  weekNumber: number;
  weekPlayDateLabel: string;
  recipientMode: WeeklyEmailRecipientMode;
  /** @deprecated Prefer items — kept for compatibility. */
  boxes: WeeklyBoxPreviewRow[];
  items: WeeklyEmailPreviewItem[];
  warnings: string[];
  managedWeekConverted: boolean;
};

function courtLabel(config: AppConfig, courtId: number): string {
  if (courtId === config.US_SQUASH_COURT_1_ID) return "Stadium";
  if (courtId === config.US_SQUASH_COURT_2_ID) return "Center";
  return `Court ${courtId}`;
}

function statHolidayRegistryFromDb(db: Db) {
  const rows = db
    .select()
    .from(statutoryHolidays)
    .orderBy(asc(statutoryHolidays.date))
    .all();
  return rows.map((r) => ({
    name: r.name,
    date: r.date,
    hours: {
      open: r.openTime,
      close: r.closeTime,
      closed: r.closed === 1,
    },
    kind: (r.closureKind === "event" ? "event" : "holiday") as "holiday" | "event",
  }));
}

function isWeekConverted(db: Db, seasonId: string, weekNumber: number): boolean {
  const hold = db
    .select()
    .from(seasonBookingHolds)
    .where(eq(seasonBookingHolds.seasonId, seasonId))
    .all()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!hold) return false;
  try {
    const converted = JSON.parse(hold.convertedWeeksJson) as number[];
    return converted.includes(weekNumber);
  } catch {
    return false;
  }
}

function hasOccurrencesForWeek(
  db: Db,
  seasonId: string,
  weekNumber: number,
): boolean {
  const row = db
    .select()
    .from(houseLeagueBookedOccurrences)
    .where(
      and(
        eq(houseLeagueBookedOccurrences.seasonId, seasonId),
        eq(houseLeagueBookedOccurrences.weekNumber, weekNumber),
      ),
    )
    .get();
  return row != null;
}

export function managedWeekReadyForWeeklyEmail(
  db: Db,
  seasonId: string,
  weekNumber: number,
): boolean {
  return (
    isWeekConverted(db, seasonId, weekNumber) &&
    hasOccurrencesForWeek(db, seasonId, weekNumber)
  );
}

type RosterContext = {
  roster: ReturnType<typeof normalizeLiveBoxLeaguePlayers>;
  emailBySsmId: Map<number, string>;
  playerNameById: Map<string, string>;
};

async function loadRosterContext(
  db: Db,
  config: AppConfig,
  eventId: number,
  client: UssquashClient,
): Promise<RosterContext | { error: string }> {
  const { status: rosterStatus, data: rosterData } =
    await client.listBoxLeaguePlayers(eventId);
  if (rosterStatus < 200 || rosterStatus >= 300) {
    return { error: `US Squash roster request failed (HTTP ${rosterStatus}).` };
  }
  const roster = normalizeLiveBoxLeaguePlayers(rosterData);
  if (roster.length === 0) {
    return { error: "US Squash box league roster is empty." };
  }

  const { status: membersStatus, data: membersData } =
    await client.listClubMembers(config.US_SQUASH_CLUB_ID);
  if (membersStatus < 200 || membersStatus >= 300) {
    return { error: `Club members request failed (HTTP ${membersStatus}).` };
  }

  const emailBySsmId = new Map<number, string>();
  if (Array.isArray(membersData)) {
    for (const raw of membersData) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const ssmId = Number(r.ssmId);
      const em = typeof r.email === "string" ? r.email.trim() : "";
      if (Number.isFinite(ssmId) && ssmId > 0 && em) {
        emailBySsmId.set(ssmId, em);
      }
    }
  }

  const playerNameById = new Map(
    db.select().from(players).all().map((p) => [p.id, p.displayName]),
  );

  return { roster, emailBySsmId, playerNameById };
}

function seatPlayersForBox(
  boxNumber: number,
  roster: RosterContext["roster"],
  groundTruthRoster?: readonly SeasonStartRosterPlayer[],
  seatOverrides?: ReadonlyMap<number, number>,
): { seat: number; displayName: string }[] {
  return buildBoxScheduleSeatPlayers({
    boxNumber,
    roster,
    displayName: (p) => livePlayerDisplayName(p as LiveBoxLeaguePlayer),
    groundTruthRoster,
    seatOverrides,
  });
}

function playerInBoxForSeat(
  boxNumber: number,
  seat: number,
  roster: RosterContext["roster"],
  groundTruthRoster?: readonly SeasonStartRosterPlayer[],
  seatOverrides?: ReadonlyMap<number, number>,
): LiveBoxLeaguePlayer | null {
  return livePlayerAtScheduleSeat(
    boxNumber,
    seat,
    roster,
    groundTruthRoster,
    seatOverrides,
  ) as LiveBoxLeaguePlayer | null;
}

function localPlayerIdByUssquashIdFromDb(db: Db): Map<number, string> {
  const out = new Map<number, string>();
  for (const row of db.select().from(players).all()) {
    const ussquashId = Number(row.externalId);
    if (Number.isFinite(ussquashId) && ussquashId > 0) {
      out.set(ussquashId, row.id);
    }
  }
  return out;
}

type BookedOccRow = (typeof houseLeagueBookedOccurrences)["$inferSelect"];

function bookedOccurrencesForBox(
  db: Db,
  seasonId: string,
  weekNumber: number,
  boxNumber: number,
): BookedOccRow[] {
  return db
    .select()
    .from(houseLeagueBookedOccurrences)
    .where(
      and(
        eq(houseLeagueBookedOccurrences.seasonId, seasonId),
        eq(houseLeagueBookedOccurrences.weekNumber, weekNumber),
        eq(houseLeagueBookedOccurrences.boxNumber, boxNumber),
      ),
    )
    .all();
}

function bookedMatchForSeatPair(
  occs: readonly BookedOccRow[],
  pair: [number, number],
  boxNumber: number,
  roster: RosterContext["roster"],
  groundTruthRoster: readonly SeasonStartRosterPlayer[] | undefined,
  playerNameById: Map<string, string>,
  localPlayerIds: Map<number, string>,
  config: AppConfig,
  seatOverrides?: ReadonlyMap<number, number>,
): WeeklyBookedMatchLine | undefined {
  const p1 = playerInBoxForSeat(
    boxNumber,
    pair[0],
    roster,
    groundTruthRoster,
    seatOverrides,
  );
  const p2 = playerInBoxForSeat(
    boxNumber,
    pair[1],
    roster,
    groundTruthRoster,
    seatOverrides,
  );
  if (!p1 || !p2) return undefined;
  const local1 = localPlayerIds.get(p1.id);
  const local2 = localPlayerIds.get(p2.id);
  if (!local1 || !local2) return undefined;
  const occ = occs.find(
    (o) =>
      (o.player1Id === local1 && o.player2Id === local2) ||
      (o.player1Id === local2 && o.player2Id === local1),
  );
  if (!occ) return undefined;
  return {
    player1Name: playerNameById.get(occ.player1Id) ?? livePlayerDisplayName(p1),
    player2Name: playerNameById.get(occ.player2Id) ?? livePlayerDisplayName(p2),
    playDate: occ.playDate,
    slot: occ.slot,
    courtLabel: courtLabel(config, occ.courtId),
  };
}

function collectEmailsForSeats(
  boxNumber: number,
  seats: [number, number],
  roster: RosterContext["roster"],
  emailBySsmId: Map<number, string>,
  groundTruthRoster?: readonly SeasonStartRosterPlayer[],
  seatOverrides?: ReadonlyMap<number, number>,
): { toAddresses: string[]; missingEmailPlayers: string[] } {
  const toAddresses: string[] = [];
  const missingEmailPlayers: string[] = [];
  const seenEmails = new Set<string>();
  for (const seat of seats) {
    const p = playerInBoxForSeat(
      boxNumber,
      seat,
      roster,
      groundTruthRoster,
      seatOverrides,
    );
    if (!p) {
      missingEmailPlayers.push(`Seat ${seat}`);
      continue;
    }
    const em = emailBySsmId.get(p.id)?.trim();
    const name = livePlayerDisplayName(p);
    if (!em) {
      missingEmailPlayers.push(name);
      continue;
    }
    const key = em.toLowerCase();
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);
    toAddresses.push(em);
  }
  return { toAddresses, missingEmailPlayers };
}

function collectBoxEmails(
  boxNumber: number,
  roster: RosterContext["roster"],
  emailBySsmId: Map<number, string>,
): { toAddresses: string[]; missingEmailPlayers: string[] } {
  const playersInBox = roster.filter((p) => p.level === boxNumber);
  const toAddresses: string[] = [];
  const missingEmailPlayers: string[] = [];
  const seenEmails = new Set<string>();
  for (const p of playersInBox) {
    const em = emailBySsmId.get(p.id)?.trim();
    if (!em) {
      missingEmailPlayers.push(livePlayerDisplayName(p));
      continue;
    }
    const key = em.toLowerCase();
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);
    toAddresses.push(em);
  }
  return { toAddresses, missingEmailPlayers };
}

function bookedMatchesForBox(
  db: Db,
  config: AppConfig,
  seasonId: string,
  weekNumber: number,
  boxNumber: number,
  roster: RosterContext["roster"],
  groundTruthRoster: readonly SeasonStartRosterPlayer[] | undefined,
  playerNameById: Map<string, string>,
  localPlayerIds: Map<number, string>,
  seatOverrides?: ReadonlyMap<number, number>,
): WeeklyBookedMatchLine[] {
  const occs = bookedOccurrencesForBox(db, seasonId, weekNumber, boxNumber);
  const mu = getWeekMatchups(weekNumber);
  const out: WeeklyBookedMatchLine[] = [];
  for (const pair of mu.matches) {
    if (
      !scheduleMatchPairNeedsCourtBooking(
        boxNumber,
        pair,
        roster,
        groundTruthRoster,
        seatOverrides,
      )
    ) {
      continue;
    }
    const line = bookedMatchForSeatPair(
      occs,
      pair,
      boxNumber,
      roster,
      groundTruthRoster,
      playerNameById,
      localPlayerIds,
      config,
      seatOverrides,
    );
    if (line) out.push(line);
  }
  return out;
}

function boxRowToPreviewItem(row: WeeklyBoxPreviewRow): WeeklyEmailPreviewItem {
  return {
    itemKey: `box-${row.boxNumber}`,
    recipientKind: "box",
    boxNumber: row.boxNumber,
    matchIndex: WEEKLY_EMAIL_PER_BOX_MATCH_INDEX,
    label: `Box ${row.boxNumber}`,
    managed: row.managed,
    subject: row.subject,
    toAddresses: row.toAddresses,
    missingEmailPlayers: row.missingEmailPlayers,
    htmlBody: row.htmlBody,
    textBody: row.textBody,
    skippedReason: row.skippedReason,
  };
}

export async function buildWeeklyBoxEmailBundle(
  db: Db,
  config: AppConfig,
  seasonId: string,
  weekNumber: number,
  templateOverride?: PartialHouseLeagueWeeklyEmailTemplateSettings,
  client?: UssquashClient,
): Promise<WeeklyBoxEmailBundle | { error: string }> {
  const ussquash = client ?? createUssquashClient(config);
  const meta = await resolveSeasonMeta(db, ussquash, config, seasonId);
  if ("error" in meta) return meta;

  const rosterCtx = await loadRosterContext(db, config, meta.eventId, ussquash);
  if ("error" in rosterCtx) return rosterCtx;

  const seatOverrides = sanitizeRelativeRankOverridesForLiveSeason(
    db,
    seasonId,
    rosterCtx.roster,
  );

  const groundTruthPlayers = loadSeasonStartGroundTruthPlayers(db, seasonId);
  const groundTruthRoster =
    groundTruthPlayers.length > 0 ? groundTruthPlayers : undefined;
  const localPlayerIds = localPlayerIdByUssquashIdFromDb(db);

  const holidays = statHolidayRegistryFromDb(db);
  const playDates = seasonWeekPlayDatesWithRegistry(
    meta.startMondayISO,
    weekNumber,
    holidays,
  );
  const weekPlayDateLabel = formatWeekPlayDateLabel(
    playDates.firstPlayDate,
    playDates.secondPlayDate,
    playDates.shiftedByHoliday,
  );

  const managedReady = managedWeekReadyForWeeklyEmail(db, seasonId, weekNumber);
  const delivery = getHouseLeagueWeeklyBoxEmailSettings(db, config);
  const recipientMode = delivery.recipientMode;
  const savedTemplates = delivery.templates;

  function resolveTemplatePair(managed: boolean, mode: WeeklyEmailRecipientMode) {
    const saved = weeklyTemplatePairForManagedBox(savedTemplates, mode, managed);
    const group = mode === "per_matchup" ? "perMatchup" : "perBox";
    const variant = managed ? "managed" : "unmanaged";
    const override = templateOverride?.[group]?.[variant];
    return {
      bodyTemplate: override?.bodyTemplate?.trim() || saved.bodyTemplate,
      subjectTemplate: override?.subjectTemplate?.trim() || saved.subjectTemplate,
    };
  }

  const fromName = config.GMAIL_FROM_NAME?.trim() || "Martin";
  const fromEmail = config.GMAIL_USER?.trim() || "director@example.test";
  const signOffName = fromName || "Martin";
  const warnings: string[] = [];
  const boxes: WeeklyBoxPreviewRow[] = [];
  const items: WeeklyEmailPreviewItem[] = [];

  const boxNumbers = [...new Set(rosterCtx.roster.map((p) => p.level))]
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  if (!managedReady) {
    warnings.push(
      `Week ${weekNumber} managed boxes skipped: week not converted or no booked occurrences in Club Locker.`,
    );
  }

  for (const boxNumber of boxNumbers) {
    const mu = getWeekMatchups(weekNumber);
    const managed = boxNumber <= MANAGED_BOX_NUMBER_MAX;
    const playersInBox = rosterCtx.roster.filter((p) => p.level === boxNumber);
    if (playersInBox.length === 0) {
      warnings.push(`Box ${boxNumber}: no roster players found.`);
      continue;
    }

    const seatPlayers = seatPlayersForBox(
      boxNumber,
      rosterCtx.roster,
      groundTruthRoster,
      seatOverrides,
    );

    const { toAddresses, missingEmailPlayers } = collectBoxEmails(
      boxNumber,
      rosterCtx.roster,
      rosterCtx.emailBySsmId,
    );

    if (toAddresses.length === 0) {
      warnings.push(`Box ${boxNumber}: no player emails found in Club Locker.`);
    }
    if (missingEmailPlayers.length > 0) {
      warnings.push(
        `Box ${boxNumber}: missing email for ${missingEmailPlayers.join(", ")}.`,
      );
    }

    const matchupsNeedingBooking = mu.matches.filter((pair) =>
      scheduleMatchPairNeedsCourtBooking(
        boxNumber,
        pair,
        rosterCtx.roster,
        groundTruthRoster,
        seatOverrides,
      ),
    );

    let skippedReason: string | undefined;
    let bookedMatches: WeeklyBookedMatchLine[] | undefined;
    const boxOccs =
      managed && managedReady
        ? bookedOccurrencesForBox(db, seasonId, weekNumber, boxNumber)
        : [];

    if (managed) {
      if (!managedReady) {
        skippedReason = "week_not_converted";
      } else {
        bookedMatches = bookedMatchesForBox(
          db,
          config,
          seasonId,
          weekNumber,
          boxNumber,
          rosterCtx.roster,
          groundTruthRoster,
          rosterCtx.playerNameById,
          localPlayerIds,
          seatOverrides,
        );
        const missingBooking = matchupsNeedingBooking.some(
          (pair) =>
            !bookedMatchForSeatPair(
              boxOccs,
              pair,
              boxNumber,
              rosterCtx.roster,
              groundTruthRoster,
              rosterCtx.playerNameById,
              localPlayerIds,
              config,
              seatOverrides,
            ),
        );
        if (matchupsNeedingBooking.length > 0 && missingBooking) {
          skippedReason = "incomplete_bookings";
          warnings.push(
            `Box ${boxNumber}: expected ${matchupsNeedingBooking.length} booked match(es) with both players, found ${bookedMatches.length}.`,
          );
        }
      }
    }

    let boxRow: WeeklyBoxPreviewRow;
    let content: ReturnType<typeof buildBoxWeeklyReminderContent> | undefined;

    if (skippedReason && recipientMode !== "per_matchup") {
      boxRow = {
        boxNumber,
        managed,
        subject: "",
        toAddresses,
        missingEmailPlayers,
        htmlBody: "",
        textBody: "",
        skippedReason,
      };
      boxes.push(boxRow);
      if (recipientMode === "per_box") {
        items.push(boxRowToPreviewItem(boxRow));
      }
    } else {
      content = buildBoxWeeklyReminderContent({
        boxNumber,
        weekNumber,
        players: seatPlayers,
        bookedMatches,
        weekPlayDateLabel: managed ? weekPlayDateLabel : "",
      });

      const renderInput = {
        seasonName: meta.seasonName,
        content,
        signOffName,
        signatureName: fromName,
        signatureEmail: fromEmail,
      };
      const vars = buildWeeklyBoxInterpolationVars(renderInput);
      const { bodyTemplate, subjectTemplate } = resolveTemplatePair(managed, "per_box");
      const htmlBody = inlineEmlTemplateAssets(
        db,
        renderWeeklyBoxBodyFromTemplate(bodyTemplate, vars),
      );
      const subject = renderWeeklyBoxSubjectFromTemplate(subjectTemplate, vars);
      const textBody = renderWeeklyBoxEmailText(renderInput);

      boxRow = {
        boxNumber,
        managed,
        subject,
        toAddresses,
        missingEmailPlayers,
        htmlBody,
        textBody,
        skippedReason,
      };
      boxes.push(boxRow);

      if (recipientMode === "per_box") {
        items.push(boxRowToPreviewItem(boxRow));
      }
    }

    if (recipientMode !== "per_matchup") {
      continue;
    }

    for (let matchIndex = 1; matchIndex <= mu.matches.length; matchIndex++) {
      const pair = mu.matches[matchIndex - 1]!;

      if (
        !scheduleMatchPairNeedsCourtBooking(
          boxNumber,
          pair,
          rosterCtx.roster,
          groundTruthRoster,
          seatOverrides,
        )
      ) {
        continue;
      }

      const p1 = playerInBoxForSeat(
        boxNumber,
        pair[0],
        rosterCtx.roster,
        groundTruthRoster,
        seatOverrides,
      );
      const p2 = playerInBoxForSeat(
        boxNumber,
        pair[1],
        rosterCtx.roster,
        groundTruthRoster,
        seatOverrides,
      );
      if (!p1 || !p2) {
        continue;
      }

      const p1Name = livePlayerDisplayName(p1);
      const p2Name = livePlayerDisplayName(p2);
      const matchupShortLabel = `${p1Name} vs ${p2Name}`;

      if (skippedReason === "week_not_converted") {
        items.push({
          itemKey: `box-${boxNumber}-m${matchIndex}`,
          recipientKind: "matchup",
          boxNumber,
          matchIndex,
          label: `Box ${boxNumber} — ${matchupShortLabel}`,
          managed,
          subject: "",
          toAddresses: [],
          missingEmailPlayers,
          htmlBody: "",
          textBody: "",
          skippedReason,
        });
        continue;
      }

      const bookedMatch = managed
        ? bookedMatchForSeatPair(
            boxOccs,
            pair,
            boxNumber,
            rosterCtx.roster,
            groundTruthRoster,
            rosterCtx.playerNameById,
            localPlayerIds,
            config,
            seatOverrides,
          )
        : undefined;

      if (managed && !bookedMatch) {
        items.push({
          itemKey: `box-${boxNumber}-m${matchIndex}`,
          recipientKind: "matchup",
          boxNumber,
          matchIndex,
          label: `Box ${boxNumber} — ${matchupShortLabel}`,
          managed,
          subject: "",
          toAddresses: [],
          missingEmailPlayers,
          htmlBody: "",
          textBody: "",
          skippedReason: "incomplete_bookings",
        });
        continue;
      }

      const matchupLine =
        managed && bookedMatch
          ? formatWeeklyManagedBookingDetailLine(bookedMatch)
          : (content?.matches[matchIndex - 1] ?? "");

      const { toAddresses: matchTo, missingEmailPlayers: matchMissing } =
        collectEmailsForSeats(
          boxNumber,
          pair,
          rosterCtx.roster,
          rosterCtx.emailBySsmId,
          groundTruthRoster,
          seatOverrides,
        );
      if (matchTo.length === 0) {
        warnings.push(`Box ${boxNumber} match ${matchIndex}: no player emails found.`);
      }
      if (matchMissing.length > 0) {
        warnings.push(
          `Box ${boxNumber} match ${matchIndex}: missing email for ${matchMissing.join(", ")}.`,
        );
      }
      const matchupRenderInput = {
        seasonName: meta.seasonName,
        content: {
          boxNumber,
          managed,
          weekNumber,
          matchIndex,
          matchupLine,
          matchupShortLabel,
          player1Name: p1Name,
          player2Name: p2Name,
          weekPlayDateLabel: managed ? weekPlayDateLabel : "",
        },
        signOffName,
        signatureName: fromName,
        signatureEmail: fromEmail,
      };
      const mvars = buildWeeklyMatchupInterpolationVars(matchupRenderInput);
      const { bodyTemplate: mBody, subjectTemplate: mSub } = resolveTemplatePair(
        managed,
        "per_matchup",
      );
      const mHtml = inlineEmlTemplateAssets(
        db,
        renderWeeklyMatchupBodyFromTemplate(mBody, mvars),
      );
      const mSubject = renderWeeklyMatchupSubjectFromTemplate(mSub, mvars);
      items.push({
        itemKey: `box-${boxNumber}-m${matchIndex}`,
        recipientKind: "matchup",
        boxNumber,
        matchIndex,
        label: `Box ${boxNumber} — ${matchupShortLabel}`,
        managed,
        subject: mSubject,
        toAddresses: matchTo,
        missingEmailPlayers: matchMissing,
        htmlBody: mHtml,
        textBody: `${p1Name} vs ${p2Name}\n${matchupLine}`,
        skippedReason: matchTo.length === 0 ? "no_recipient_emails" : undefined,
      });
    }
  }

  return {
    seasonId,
    seasonName: meta.seasonName,
    startMondayISO: meta.startMondayISO,
    weekNumber,
    weekPlayDateLabel,
    recipientMode,
    boxes,
    items,
    warnings,
    managedWeekConverted: managedReady,
  };
}

export function resolveWeeklyTargetWeek(
  db: Db,
  startMondayISO: string,
  now: Date = new Date(),
): { weekNumber: number; weekPlayDateLabel: string } | null {
  const holidays = statHolidayRegistryFromDb(db);
  const target = resolveTargetWeekForWednesday(now, startMondayISO, holidays);
  if (!target) return null;
  return {
    weekNumber: target.weekNumber,
    weekPlayDateLabel: formatWeekPlayDateLabel(
      target.firstPlayDate,
      target.secondPlayDate,
      target.shiftedByHoliday,
    ),
  };
}

export function weeklyEmlFileForItem(
  item: WeeklyEmailPreviewItem,
  weekNumber: number,
  fromName: string,
  fromEmail: string,
): { filename: string; content: string } | { error: string } {
  if (item.skippedReason || !item.htmlBody.trim() || !item.subject.trim()) {
    return { error: "item_not_ready_for_eml" };
  }
  const toAddresses = mergeUniqueEmailAddresses(item.toAddresses);
  if (toAddresses.length === 0) {
    return { error: "no_recipients" };
  }
  if (!fromEmail.trim()) {
    return { error: "from_email_required" };
  }
  const filename =
    item.recipientKind === "matchup"
      ? weeklyMatchupEmlFilename(item.boxNumber, weekNumber, item.matchIndex)
      : weeklyBoxEmlFilename(item.boxNumber, weekNumber);
  return {
    filename,
    content: buildOutlookEmlFile({
      fromName,
      fromEmail: fromEmail.trim(),
      toAddresses,
      subject: item.subject,
      htmlBody: item.htmlBody,
    }),
  };
}

/** @deprecated Use weeklyEmlFileForItem */
export function weeklyBoxEmlFileForRow(
  box: WeeklyBoxPreviewRow,
  weekNumber: number,
  fromName: string,
  fromEmail: string,
): ReturnType<typeof weeklyEmlFileForItem> {
  return weeklyEmlFileForItem(boxRowToPreviewItem(box), weekNumber, fromName, fromEmail);
}

function zipBufferFromWeeklyEmlFiles(
  bundle: WeeklyBoxEmailBundle,
  files: { filename: string; content: string }[],
): Promise<{ buffer: Buffer; filename: string }> {
  return (async () => {
    type ZipArchiveCtor = new (options?: {
      zlib?: { level?: number };
    }) => import("archiver").Archiver;
    const { ZipArchive } = (await import("archiver")) as unknown as {
      ZipArchive: ZipArchiveCtor;
    };
    const { PassThrough } = await import("node:stream");

    const archive = new ZipArchive({ zlib: { level: 9 } });
    const stream = new PassThrough();
    const chunks: Buffer[] = [];

    const done = new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve());
      stream.on("error", reject);
      archive.on("error", reject);
    });

    archive.pipe(stream);

    for (const file of files) {
      archive.append(file.content, { name: file.filename });
    }

    await archive.finalize();
    await done;

    const safeName = bundle.seasonName
      .replace(/[^\w\s-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60);
    const filename = `${safeName || "house-league"}-week-${bundle.weekNumber}-weekly-eml.zip`;

    return { buffer: Buffer.concat(chunks), filename };
  })();
}

export async function buildWeeklyBoxEmlZipBuffer(
  db: Db,
  config: AppConfig,
  seasonId: string,
  weekNumber: number,
  options?: {
    templateOverride?: PartialHouseLeagueWeeklyEmailTemplateSettings;
    fromEmail?: string;
    fromName?: string;
  },
): Promise<{ buffer: Buffer; filename: string } | { error: string }> {
  const bundle = await buildWeeklyBoxEmailBundle(
    db,
    config,
    seasonId,
    weekNumber,
    options?.templateOverride,
  );
  if ("error" in bundle) return bundle;

  const delivery = getHouseLeagueWeeklyBoxEmailSettings(db, config);
  const fromEmail = options?.fromEmail?.trim() || delivery.fromEmail;
  const fromName =
    options?.fromName !== undefined ? options.fromName.trim() : delivery.fromName;

  if (!fromEmail.trim()) {
    return { error: "from_email_required" };
  }

  const files: { filename: string; content: string }[] = [];
  for (const item of bundle.items) {
    const eml = weeklyEmlFileForItem(item, weekNumber, fromName, fromEmail);
    if ("error" in eml) continue;
    files.push(eml);
  }

  if (files.length === 0) {
    return { error: "No weekly EML files to export." };
  }

  return zipBufferFromWeeklyEmlFiles(bundle, files);
}

export async function stageWeeklyBoxEmails(
  db: Db,
  config: AppConfig,
  emailAdapter: EmailAdapter,
  options: {
    seasonId: string;
    weekNumber: number;
    autoSend: boolean;
    mode: StepRuntimeMode;
    dryRun?: boolean;
    force?: boolean;
    boxNumbers?: number[];
  },
): Promise<{ staged: number; sent: number; skipped: number; warnings: string[] }> {
  const result = { staged: 0, sent: 0, skipped: 0, warnings: [] as string[] };
  const bundle = await buildWeeklyBoxEmailBundle(
    db,
    config,
    options.seasonId,
    options.weekNumber,
  );
  if ("error" in bundle) {
    result.warnings.push(bundle.error);
    return result;
  }
  result.warnings.push(...bundle.warnings);

  const filter = options.boxNumbers
    ? new Set(options.boxNumbers)
    : null;

  const sendItems = filter
    ? bundle.items.filter((item) => filter.has(item.boxNumber))
    : bundle.items;

  for (const item of sendItems) {
    if (item.skippedReason) {
      result.skipped += 1;
      continue;
    }
    if (item.toAddresses.length === 0) {
      result.skipped += 1;
      continue;
    }

    const existing = db
      .select()
      .from(houseLeagueWeeklyBoxSends)
      .where(
        and(
          eq(houseLeagueWeeklyBoxSends.seasonId, options.seasonId),
          eq(houseLeagueWeeklyBoxSends.weekNumber, options.weekNumber),
          eq(houseLeagueWeeklyBoxSends.boxNumber, item.boxNumber),
          eq(houseLeagueWeeklyBoxSends.matchIndex, item.matchIndex),
        ),
      )
      .get();
    if (existing && !options.force) {
      result.skipped += 1;
      continue;
    }

    if (options.dryRun) {
      result.staged += 1;
      continue;
    }

    const toAddress = mergeUniqueEmailAddresses(item.toAddresses).join(", ");
    if (!toAddress) {
      result.skipped += 1;
      continue;
    }

    const outcome = await stageAndMaybeSend(db, emailAdapter, options.autoSend, {
      kind: "weekly_box",
      seasonId: options.seasonId,
      toAddress,
      subject: item.subject,
      body: item.htmlBody,
      meta: {
        boxNumber: item.boxNumber,
        weekNumber: options.weekNumber,
        matchIndex: item.matchIndex,
        recipientKind: item.recipientKind,
        managed: item.managed,
        purpose: "house_league_weekly_box",
      },
    });

    if (options.mode !== "replay") {
      if (existing) {
        db.delete(houseLeagueWeeklyBoxSends)
          .where(eq(houseLeagueWeeklyBoxSends.id, existing.id))
          .run();
      }
      db.insert(houseLeagueWeeklyBoxSends)
        .values({
          id: crypto.randomUUID(),
          seasonId: options.seasonId,
          weekNumber: options.weekNumber,
          boxNumber: item.boxNumber,
          matchIndex: item.matchIndex,
          outboxId: outcome.outboxId,
          sentAt: new Date().toISOString(),
        })
        .run();
    }

    result.staged += 1;
    if (outcome.sent) result.sent += 1;
  }

  return result;
}
