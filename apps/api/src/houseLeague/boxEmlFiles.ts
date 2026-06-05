import {
  boxEmlFilename,
  boxNumbersWithSeasonStartChanges,
  buildBoxScheduleSeatPlayers,
  buildOutlookEmlFile,
  buildBoxEmlInterpolationVars,
  buildBoxSeasonScheduleEmailContent,
  compareSeasonStartRosters,
  formatBoxModificationReasonClause,
  renderBoxEmlBodyFromTemplate,
  type SeasonStartRosterDiffResult,
  renderBoxEmlSubjectFromTemplate,
  renderBoxSeasonScheduleEmailText,
  type BoxEmlTemplatePurpose,
  type BoxScheduleSeatPlayer,
  type BoxRelativeRankIdentifiedPlayer,
} from "@squash/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { seasons } from "../db/schema.js";
import { eq } from "drizzle-orm";
import {
  createUssquashClient,
  normalizeJsonArray,
  type UssquashClient,
} from "../booking/clubLockerClient.js";
import {
  livePlayerDisplayName,
  normalizeLiveBoxLeaguePlayers,
  type LiveBoxLeaguePlayer,
} from "../booking/liveWeekPlan.js";
import {
  getHouseLeagueBoxEmlTemplateSettings,
  templatePairForManagedBox,
  type BoxEmlTemplatePair,
  type PartialHouseLeagueBoxEmlTemplateSettings,
} from "./boxEmlTemplateSettings.js";
import { inlineEmlTemplateAssets } from "./boxEmlAssets.js";
import {
  parseSeasonStartRosterPlayers,
  toSeasonStartDiffPlayers,
} from "./seasonStartRoster.js";

export type BoxEmlPreviewRow = {
  boxNumber: number;
  managed: boolean;
  filename: string;
  subject: string;
  toAddresses: string[];
  missingEmailPlayers: string[];
  htmlBody: string;
  textBody: string;
  interpolationVars: Record<string, string>;
};

export type BoxEmlBundle = {
  seasonId: string;
  seasonName: string;
  seasonStartDateLabel: string;
  startMondayISO: string;
  boxes: BoxEmlPreviewRow[];
  warnings: string[];
};

type ClubMemberRow = {
  ssmId: number;
  firstName: string;
  lastName: string;
  email: string | null;
};

function formatSeasonStartLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleString("en-US", { weekday: "short" });
  const month = date.toLocaleString("en-US", { month: "short" });
  return `${weekday}, ${d} ${month} ${y}`;
}

function normalizeClubMembers(data: unknown): ClubMemberRow[] {
  if (!Array.isArray(data)) return [];
  const out: ClubMemberRow[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const ssmId = Number(r.ssmId);
    if (!Number.isFinite(ssmId) || ssmId <= 0) continue;
    out.push({
      ssmId,
      firstName: typeof r.firstName === "string" ? r.firstName : "",
      lastName: typeof r.lastName === "string" ? r.lastName : "",
      email: typeof r.email === "string" ? r.email : null,
    });
  }
  return out;
}

function emailForPlayer(
  player: LiveBoxLeaguePlayer,
  emailBySsmId: Map<number, string>,
): string | null {
  const direct = emailBySsmId.get(player.id);
  if (direct) return direct;
  return null;
}

function seatPlayersForBox(
  boxNumber: number,
  roster: readonly LiveBoxLeaguePlayer[],
  groundTruthRoster?: readonly BoxRelativeRankIdentifiedPlayer[],
): BoxScheduleSeatPlayer[] {
  return buildBoxScheduleSeatPlayers({
    boxNumber,
    roster,
    displayName: (p) => livePlayerDisplayName(p as LiveBoxLeaguePlayer),
    groundTruthRoster,
  });
}

export async function resolveSeasonMeta(
  db: Db,
  client: UssquashClient,
  config: AppConfig,
  seasonId: string,
): Promise<
  | {
      seasonName: string;
      startMondayISO: string;
      seasonStartDateLabel: string;
      eventId: number;
    }
  | { error: string }
> {
  const season = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
  if (!season) return { error: "season_not_found" };

  let seasonName = season.name.trim();
  let startMondayISO = season.startMondayDate?.trim() ?? "";

  const eventId = season.houseLeagueEventId;
  if (eventId != null && eventId > 0) {
    const { status, data } = await client.listBoxLeaguesForClub(
      config.US_SQUASH_CLUB_ID,
    );
    if (status >= 200 && status < 300) {
      const events = normalizeJsonArray(data);
      const match = events.find((raw) => {
        const r = raw as Record<string, unknown>;
        return Number(r.eventId) === eventId;
      }) as Record<string, unknown> | undefined;
      if (match) {
        if (typeof match.eventName === "string" && match.eventName.trim()) {
          seasonName = match.eventName.trim();
        }
        if (
          typeof match.startDate === "string" &&
          match.startDate.trim() &&
          !startMondayISO
        ) {
          startMondayISO = match.startDate.trim().slice(0, 10);
        }
      }
    }
  }

  if (!startMondayISO) {
    return {
      error:
        "Season start Monday is not set. Set the start date on the booking season or link a house league event.",
    };
  }

  if (eventId == null || eventId <= 0) {
    return {
      error:
        "Link a US Squash house league event to this booking season (House League Setup).",
    };
  }

  return {
    seasonName,
    startMondayISO,
    seasonStartDateLabel: formatSeasonStartLabel(startMondayISO),
    eventId,
  };
}

export async function buildHouseLeagueBoxEmlBundle(
  db: Db,
  config: AppConfig,
  seasonId: string,
  templateOverride?: PartialHouseLeagueBoxEmlTemplateSettings,
  client?: UssquashClient,
  templatePurpose: BoxEmlTemplatePurpose = "season_start",
): Promise<BoxEmlBundle | { error: string }> {
  const ussquash = client ?? createUssquashClient(config);
  const meta = await resolveSeasonMeta(db, ussquash, config, seasonId);
  if ("error" in meta) return meta;

  const season = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
  const groundTruthRoster =
    templatePurpose === "box_modification" && season
      ? toSeasonStartDiffPlayers(
          parseSeasonStartRosterPlayers(season.seasonStartRosterJson),
        )
      : undefined;

  const savedTemplates = getHouseLeagueBoxEmlTemplateSettings(db, templatePurpose);

  function resolveTemplatePair(managed: boolean): BoxEmlTemplatePair {
    const saved = templatePairForManagedBox(savedTemplates, managed);
    const variant = managed ? "managed" : "unmanaged";
    const override = templateOverride?.[variant];
    return {
      bodyTemplate:
        override?.bodyTemplate?.trim() || saved.bodyTemplate,
      subjectTemplate:
        override?.subjectTemplate?.trim() || saved.subjectTemplate,
    };
  }

  const { status: rosterStatus, data: rosterData } =
    await ussquash.listBoxLeaguePlayers(meta.eventId);
  if (rosterStatus < 200 || rosterStatus >= 300) {
    return { error: `US Squash roster request failed (HTTP ${rosterStatus}).` };
  }
  const roster = normalizeLiveBoxLeaguePlayers(rosterData);
  if (roster.length === 0) {
    return { error: "US Squash box league roster is empty." };
  }

  const { status: membersStatus, data: membersData } =
    await ussquash.listClubMembers(config.US_SQUASH_CLUB_ID);
  if (membersStatus < 200 || membersStatus >= 300) {
    return { error: `Club members request failed (HTTP ${membersStatus}).` };
  }
  const members = normalizeClubMembers(membersData);
  const emailBySsmId = new Map<number, string>();
  for (const m of members) {
    const em = m.email?.trim();
    if (em) emailBySsmId.set(m.ssmId, em);
  }

  const fromName = config.GMAIL_FROM_NAME?.trim() || "Martin";
  const fromEmail = config.GMAIL_USER?.trim() || "director@example.test";
  const signOffName = fromName || "Martin";
  const warnings: string[] = [];
  const boxes: BoxEmlPreviewRow[] = [];

  let boxNumbers = [...new Set(roster.map((p) => p.level))]
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  let seasonStartDiff: SeasonStartRosterDiffResult | null = null;

  if (templatePurpose === "box_modification") {
    if (!groundTruthRoster?.length) {
      warnings.push(
        "Save a season-start roster to preview and export box-change emails.",
      );
      boxNumbers = [];
    } else {
      seasonStartDiff = compareSeasonStartRosters(
        groundTruthRoster,
        roster.map((p) => ({
          id: p.id,
          level: p.level,
          playerCurrentRank: p.playerCurrentRank,
          firstName: p.firstName,
          lastName: p.lastName,
        })),
      );
      boxNumbers = boxNumbersWithSeasonStartChanges(seasonStartDiff);
      if (boxNumbers.length === 0) {
        warnings.push(
          "No roster changes vs season-start ground truth — no box-change emails to send.",
        );
      }
    }
  }

  for (const boxNumber of boxNumbers) {
    const seatPlayers = seatPlayersForBox(
      boxNumber,
      roster,
      groundTruthRoster,
    );
    if (seatPlayers.length === 0) {
      warnings.push(`Box ${boxNumber}: no roster players found.`);
      continue;
    }

    const playersInBox = roster.filter((p) => p.level === boxNumber);
    const toAddresses: string[] = [];
    const missingEmailPlayers: string[] = [];
    const seenEmails = new Set<string>();

    for (const p of playersInBox) {
      const em = emailForPlayer(p, emailBySsmId);
      if (!em) {
        missingEmailPlayers.push(livePlayerDisplayName(p));
        continue;
      }
      const key = em.toLowerCase();
      if (seenEmails.has(key)) continue;
      seenEmails.add(key);
      toAddresses.push(em);
    }

    if (toAddresses.length === 0) {
      warnings.push(`Box ${boxNumber}: no player emails found in Club Locker.`);
    }
    if (missingEmailPlayers.length > 0) {
      warnings.push(
        `Box ${boxNumber}: missing email for ${missingEmailPlayers.join(", ")}.`,
      );
    }

    const content = buildBoxSeasonScheduleEmailContent(
      boxNumber,
      seatPlayers,
      meta.startMondayISO,
    );
    const renderInput = {
      seasonName: meta.seasonName,
      seasonStartDateLabel: meta.seasonStartDateLabel,
      content,
      signOffName,
      signatureName: fromName,
      signatureEmail: fromEmail,
    };
    const interpolationVars = buildBoxEmlInterpolationVars(
      renderInput,
      templatePurpose,
      seasonStartDiff
        ? {
            boxChangeReasonClause: formatBoxModificationReasonClause(
              boxNumber,
              seasonStartDiff,
            ),
          }
        : {},
    );
    const { bodyTemplate, subjectTemplate } = resolveTemplatePair(content.managed);
    const htmlBody = inlineEmlTemplateAssets(
      db,
      renderBoxEmlBodyFromTemplate(bodyTemplate, interpolationVars),
    );
    const subject = renderBoxEmlSubjectFromTemplate(subjectTemplate, interpolationVars);
    const textBody = renderBoxSeasonScheduleEmailText(renderInput);

    boxes.push({
      boxNumber,
      managed: content.managed,
      filename: boxEmlFilename(boxNumber),
      subject,
      toAddresses,
      missingEmailPlayers,
      htmlBody,
      textBody,
      interpolationVars,
    });
  }

  return {
    seasonId,
    seasonName: meta.seasonName,
    seasonStartDateLabel: meta.seasonStartDateLabel,
    startMondayISO: meta.startMondayISO,
    boxes,
    warnings,
  };
}

export function boxEmlFileContent(
  bundle: BoxEmlBundle,
  box: BoxEmlPreviewRow,
  config: AppConfig,
): string {
  const fromName = config.GMAIL_FROM_NAME?.trim() || "Martin";
  const fromEmail = config.GMAIL_USER?.trim() || "director@example.test";
  return buildOutlookEmlFile({
    fromName,
    fromEmail,
    toAddresses: box.toAddresses.length > 0 ? box.toAddresses : ["unknown@example.test"],
    subject: box.subject,
    htmlBody: box.htmlBody,
  });
}

function zipBufferFromBundle(
  bundle: BoxEmlBundle,
  config: AppConfig,
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

    for (const box of bundle.boxes) {
      archive.append(boxEmlFileContent(bundle, box, config), {
        name: box.filename,
      });
    }

    await archive.finalize();
    await done;

    const safeName = bundle.seasonName
      .replace(/[^\w\s-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60);
    const filename = `${safeName || "house-league"}-box-eml.zip`;

    return { buffer: Buffer.concat(chunks), filename };
  })();
}

export async function buildHouseLeagueBoxEmlZipBuffer(
  db: Db,
  config: AppConfig,
  seasonId: string,
  templateOverride?: PartialHouseLeagueBoxEmlTemplateSettings,
  templatePurpose: BoxEmlTemplatePurpose = "season_start",
): Promise<{ buffer: Buffer; filename: string } | { error: string }> {
  const bundle = await buildHouseLeagueBoxEmlBundle(
    db,
    config,
    seasonId,
    templateOverride,
    undefined,
    templatePurpose,
  );
  if ("error" in bundle) return bundle;
  if (bundle.boxes.length === 0) {
    return { error: "No box EML files to export." };
  }

  return zipBufferFromBundle(bundle, config);
}
