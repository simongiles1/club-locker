import {
  compareSeasonStartRosters,
  type SeasonStartRosterDiffResult,
  type SeasonStartRosterPlayer,
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
import { fetchLiveBoxLeagueRosterForSeason } from "../booking/service.js";

export function parseSeasonStartRosterPlayers(raw: string | null | undefined): unknown[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function loadSeasonStartGroundTruthPlayers(
  db: Db,
  seasonId: string,
): SeasonStartRosterPlayer[] {
  const season = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
  if (!season) return [];
  return toSeasonStartDiffPlayers(
    parseSeasonStartRosterPlayers(season.seasonStartRosterJson),
  );
}

export function toSeasonStartDiffPlayers(data: unknown[]): SeasonStartRosterPlayer[] {
  const out: SeasonStartRosterPlayer[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = Number(r.id);
    const level = Number(r.level);
    const playerCurrentRank = Number(r.playerCurrentRank);
    if (
      !Number.isFinite(id) ||
      id <= 0 ||
      !Number.isFinite(level) ||
      !Number.isFinite(playerCurrentRank)
    ) {
      continue;
    }
    out.push({
      id,
      level,
      playerCurrentRank,
      firstName: typeof r.firstName === "string" ? r.firstName : "",
      lastName: typeof r.lastName === "string" ? r.lastName : "",
    });
  }
  return out;
}

export async function computeSeasonStartRosterDiff(
  db: Db,
  config: AppConfig,
  seasonId: string,
  client: UssquashClient = createUssquashClient(config),
): Promise<SeasonStartRosterDiffResult | { error: string }> {
  const season = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
  if (!season) return { error: "season_not_found" };

  const groundTruth = toSeasonStartDiffPlayers(
    parseSeasonStartRosterPlayers(season.seasonStartRosterJson),
  );

  if (groundTruth.length === 0) {
    return compareSeasonStartRosters([], []);
  }

  const liveResult = await fetchLiveBoxLeagueRosterForSeason(
    db,
    config,
    seasonId,
    client,
  );
  if ("error" in liveResult) return liveResult;

  const live = liveResult.roster.map((p) => ({
    id: p.id,
    level: p.level,
    playerCurrentRank: p.playerCurrentRank,
    firstName: p.firstName,
    lastName: p.lastName,
  }));

  return compareSeasonStartRosters(groundTruth, live);
}

export async function seedSeasonStartRosterFromLive(
  db: Db,
  config: AppConfig,
  seasonId: string,
  client: UssquashClient = createUssquashClient(config),
): Promise<
  | { ok: true; players: unknown[]; savedAt: string; playerCount: number }
  | { error: string }
> {
  const season = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
  if (!season) return { error: "season_not_found" };

  const eventId = season.houseLeagueEventId;
  if (eventId == null || eventId <= 0) {
    return {
      error:
        "Link a US Squash house league event to this booking season (House League Setup), then try again.",
    };
  }

  const { status, data } = await client.listBoxLeaguePlayers(eventId);
  if (status < 200 || status >= 300) {
    return { error: `US Squash roster request failed (HTTP ${status}).` };
  }

  const players = normalizeJsonArray(data);
  const savedAt = new Date().toISOString();

  db.update(seasons)
    .set({
      seasonStartRosterJson: JSON.stringify(players),
      seasonStartRosterSavedAt: savedAt,
    })
    .where(eq(seasons.id, seasonId))
    .run();

  return { ok: true, players, savedAt, playerCount: players.length };
}
