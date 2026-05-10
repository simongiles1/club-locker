import { and, eq, inArray } from "drizzle-orm";
import {
  buildBracket,
  divisionDisplayName,
  type BracketEntry,
  type ChampionshipDivision,
  entrantsAtBracketRoundStart,
  knockoutStageLabel,
} from "@squash/shared";
import type { Db } from "../db/client.js";
import {
  championshipDraws,
  championshipEntries,
  championshipMatches,
  championships,
  emailOutbox,
  players,
  seasons,
} from "../db/schema.js";
import { resolveDueDateForChampionshipRound } from "./roundDueDates.js";

export type ChampionshipRow = typeof championships.$inferSelect;
export type ChampionshipEntryRow = typeof championshipEntries.$inferSelect;
export type ChampionshipDrawRow = typeof championshipDraws.$inferSelect;
export type ChampionshipMatchRow = typeof championshipMatches.$inferSelect;
type PlayerRow = typeof players.$inferSelect;

export type EnrichedEntry = ChampionshipEntryRow & {
  playerName: string;
  playerEmail: string | null;
  partnerName: string | null;
  partnerEmail: string | null;
};

export type ChampionshipDetail = {
  championship: ChampionshipRow;
  entries: EnrichedEntry[];
  activeDraw: (ChampionshipDrawRow & { matches: ChampionshipMatchRow[] }) | null;
};

export type MatchAnnouncementDraft = {
  recipients: string[];
  subject: string;
  body: string;
  stageName: string;
  dueDate: string | null;
  topEntryId: string;
  bottomEntryId: string;
};

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export type ListChampionshipsFilter =
  | { seasonId: string }
  | { clubYear: number }
  | undefined;

/** List championships for one season row, or for every season row sharing a club-booking year. */
export function listChampionships(
  db: Db,
  filter?: ListChampionshipsFilter,
): ChampionshipRow[] {
  if (filter && "clubYear" in filter) {
    const seasonRows = db
      .select({ id: seasons.id })
      .from(seasons)
      .where(eq(seasons.clubYear, filter.clubYear))
      .all();
    const ids = seasonRows.map((r) => r.id).filter(Boolean);
    if (ids.length === 0) return [];
    return db
      .select()
      .from(championships)
      .where(inArray(championships.seasonId, ids))
      .all();
  }
  if (filter && "seasonId" in filter && filter.seasonId) {
    return db
      .select()
      .from(championships)
      .where(eq(championships.seasonId, filter.seasonId))
      .all();
  }
  return db.select().from(championships).all();
}

export function getChampionshipDetail(
  db: Db,
  championshipId: string,
): ChampionshipDetail | null {
  const c = db
    .select()
    .from(championships)
    .where(eq(championships.id, championshipId))
    .get();
  if (!c) return null;

  const rawEntries = db
    .select()
    .from(championshipEntries)
    .where(eq(championshipEntries.championshipId, championshipId))
    .all();
  const playerIds = new Set<string>();
  for (const e of rawEntries) {
    playerIds.add(e.playerId);
    if (e.partnerPlayerId) playerIds.add(e.partnerPlayerId);
  }
  const playerRows: PlayerRow[] =
    playerIds.size === 0
      ? []
      : db.select().from(players).all().filter((p) => playerIds.has(p.id));
  const playerById = new Map(playerRows.map((p) => [p.id, p]));
  const entries: EnrichedEntry[] = rawEntries
    .map((e) => {
      const main = playerById.get(e.playerId);
      const partner = e.partnerPlayerId
        ? playerById.get(e.partnerPlayerId) ?? null
        : null;
      return {
        ...e,
        playerName: main?.displayName ?? "(unknown)",
        playerEmail: main?.email ?? null,
        partnerName: partner?.displayName ?? null,
        partnerEmail: partner?.email ?? null,
      };
    })
    .sort((a, b) => {
      const sa = a.seed ?? Number.POSITIVE_INFINITY;
      const sb = b.seed ?? Number.POSITIVE_INFINITY;
      if (sa !== sb) return sa - sb;
      return a.playerName.localeCompare(b.playerName);
    });

  const draws = db
    .select()
    .from(championshipDraws)
    .where(eq(championshipDraws.championshipId, championshipId))
    .all()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const active = draws[0] ?? null;
  const matches = active
    ? db
        .select()
        .from(championshipMatches)
        .where(eq(championshipMatches.drawId, active.id))
        .all()
        .sort(
          (a, b) =>
            a.round - b.round || a.matchIndex - b.matchIndex,
        )
    : [];

  return {
    championship: c,
    entries,
    activeDraw: active ? { ...active, matches } : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* -------------------------------------------------------------------------- */

export function createChampionship(
  db: Db,
  args: {
    seasonId?: string | null;
    division: ChampionshipDivision;
    name?: string;
    roundOneDueDate?: string | null;
  },
): ChampionshipRow {
  const id = crypto.randomUUID();
  const name = args.name ?? divisionDisplayName(args.division);
  db.insert(championships)
    .values({
      id,
      seasonId: args.seasonId ?? null,
      format: args.division.format,
      divisionKind: args.division.kind,
      divisionLabel: args.division.label,
      name,
      status: "registration",
      roundOneDueDate: args.roundOneDueDate ?? null,
    })
    .run();
  return db.select().from(championships).where(eq(championships.id, id)).get()!;
}

export function deleteChampionship(db: Db, championshipId: string): void {
  db.delete(championships).where(eq(championships.id, championshipId)).run();
}

export function addEntry(
  db: Db,
  championshipId: string,
  args: {
    playerId: string;
    partnerPlayerId?: string | null;
    seed?: number | null;
  },
): ChampionshipEntryRow {
  const champ = db
    .select()
    .from(championships)
    .where(eq(championships.id, championshipId))
    .get();
  if (!champ) throw new Error("championship_not_found");

  const partnerId = args.partnerPlayerId ?? null;
  if (champ.format === "doubles") {
    if (!partnerId) throw new Error("doubles_requires_partner");
    if (partnerId === args.playerId) {
      throw new Error("doubles_partner_must_differ_from_primary");
    }
  }

  const id = crypto.randomUUID();
  if (
    args.seed != null &&
    args.seed > 0 &&
    db
      .select()
      .from(championshipEntries)
      .where(
        and(
          eq(championshipEntries.championshipId, championshipId),
          eq(championshipEntries.seed, args.seed),
        ),
      )
      .get()
  ) {
    throw new Error(`Seed ${args.seed} is already taken in this division`);
  }
  db.insert(championshipEntries)
    .values({
      id,
      championshipId,
      playerId: args.playerId,
      partnerPlayerId: champ.format === "doubles" ? partnerId : null,
      seed: args.seed ?? null,
    })
    .run();
  return db
    .select()
    .from(championshipEntries)
    .where(eq(championshipEntries.id, id))
    .get()!;
}

export function updateEntry(
  db: Db,
  entryId: string,
  patch: { seed?: number | null; partnerPlayerId?: string | null },
): ChampionshipEntryRow | null {
  const existing = db
    .select()
    .from(championshipEntries)
    .where(eq(championshipEntries.id, entryId))
    .get();
  if (!existing) return null;
  if (patch.seed != null && patch.seed > 0) {
    const conflict = db
      .select()
      .from(championshipEntries)
      .where(
        and(
          eq(championshipEntries.championshipId, existing.championshipId),
          eq(championshipEntries.seed, patch.seed),
        ),
      )
      .get();
    if (conflict && conflict.id !== entryId) {
      throw new Error(`Seed ${patch.seed} is already taken in this division`);
    }
  }
  db.update(championshipEntries)
    .set({
      seed: patch.seed === undefined ? existing.seed : patch.seed,
      partnerPlayerId:
        patch.partnerPlayerId === undefined
          ? existing.partnerPlayerId
          : patch.partnerPlayerId,
    })
    .where(eq(championshipEntries.id, entryId))
    .run();
  return db
    .select()
    .from(championshipEntries)
    .where(eq(championshipEntries.id, entryId))
    .get()!;
}

export function removeEntry(db: Db, entryId: string): void {
  db.delete(championshipEntries)
    .where(eq(championshipEntries.id, entryId))
    .run();
}

/* -------------------------------------------------------------------------- */
/* Draw generation                                                            */
/* -------------------------------------------------------------------------- */

export function generateDraw(
  db: Db,
  championshipId: string,
): ChampionshipDetail {
  const detail = getChampionshipDetail(db, championshipId);
  if (!detail) throw new Error("championship_not_found");
  if (detail.entries.length < 2) {
    throw new Error("Need at least 2 entries to generate a bracket");
  }

  const bracketEntries: BracketEntry[] = detail.entries.map((e) => ({
    entryId: e.id,
    displayName: e.playerName + (e.partnerName ? ` / ${e.partnerName}` : ""),
    seed: e.seed ?? null,
  }));
  const bracket = buildBracket(bracketEntries);

  // Replace any existing draw + matches for this championship.
  db.delete(championshipDraws)
    .where(eq(championshipDraws.championshipId, championshipId))
    .run();

  const drawId = crypto.randomUUID();
  db.insert(championshipDraws)
    .values({
      id: drawId,
      championshipId,
      status: "draft",
      size: bracket.size,
      snapshotJson: JSON.stringify(bracket),
    })
    .run();

  // Round 1 matches: real entries + bye markers.
  for (const m of bracket.firstRound) {
    db.insert(championshipMatches)
      .values({
        id: crypto.randomUUID(),
        championshipId,
        drawId,
        round: 1,
        matchIndex: m.matchIndex,
        topEntryId:
          m.topSlot && m.topSlot.kind === "entry" ? m.topSlot.entryId : null,
        topIsBye: m.topSlot?.kind === "bye" ? 1 : 0,
        bottomEntryId:
          m.bottomSlot && m.bottomSlot.kind === "entry"
            ? m.bottomSlot.entryId
            : null,
        bottomIsBye: m.bottomSlot?.kind === "bye" ? 1 : 0,
      })
      .run();
  }

  // Empty placeholder matches for later rounds.
  let prevMatches = bracket.firstRound.length;
  for (let r = 2; r <= bracket.rounds; r++) {
    const count = prevMatches / 2;
    for (let i = 0; i < count; i++) {
      db.insert(championshipMatches)
        .values({
          id: crypto.randomUUID(),
          championshipId,
          drawId,
          round: r,
          matchIndex: i,
          topEntryId: null,
          topIsBye: 0,
          bottomEntryId: null,
          bottomIsBye: 0,
        })
        .run();
    }
    prevMatches = count;
  }

  db.update(championships)
    .set({ status: "drawn" })
    .where(eq(championships.id, championshipId))
    .run();

  return getChampionshipDetail(db, championshipId)!;
}

export function publishDraw(db: Db, championshipId: string): ChampionshipDetail {
  const detail = getChampionshipDetail(db, championshipId);
  if (!detail || !detail.activeDraw) throw new Error("draw_not_found");
  db.update(championshipDraws)
    .set({ status: "published" })
    .where(eq(championshipDraws.id, detail.activeDraw.id))
    .run();
  db.update(championships)
    .set({ status: "published" })
    .where(eq(championships.id, championshipId))
    .run();
  return getChampionshipDetail(db, championshipId)!;
}

export function updateMatch(
  db: Db,
  matchId: string,
  patch: {
    topEntryId?: string | null;
    bottomEntryId?: string | null;
    winnerEntryId?: string | null;
    scheduledAt?: string | null;
  },
): ChampionshipMatchRow | null {
  const existing = db
    .select()
    .from(championshipMatches)
    .where(eq(championshipMatches.id, matchId))
    .get();
  if (!existing) return null;
  const set: Partial<typeof championshipMatches.$inferInsert> = {};
  if (patch.topEntryId !== undefined) {
    set.topEntryId = patch.topEntryId;
    set.topIsBye = 0;
  }
  if (patch.bottomEntryId !== undefined) {
    set.bottomEntryId = patch.bottomEntryId;
    set.bottomIsBye = 0;
  }
  if (patch.winnerEntryId !== undefined) {
    set.winnerEntryId = patch.winnerEntryId;
    set.completedAt = patch.winnerEntryId
      ? new Date().toISOString()
      : null;
  }
  if (patch.scheduledAt !== undefined) {
    set.scheduledAt = patch.scheduledAt;
  }

  db.update(championshipMatches)
    .set(set)
    .where(eq(championshipMatches.id, matchId))
    .run();

  // Auto-advance winner into next round slot if winner was set.
  if (patch.winnerEntryId !== undefined && patch.winnerEntryId) {
    advanceWinner(db, matchId, patch.winnerEntryId);
  }
  return db
    .select()
    .from(championshipMatches)
    .where(eq(championshipMatches.id, matchId))
    .get()!;
}

function advanceWinner(db: Db, matchId: string, winnerEntryId: string): void {
  const m = db
    .select()
    .from(championshipMatches)
    .where(eq(championshipMatches.id, matchId))
    .get();
  if (!m) return;
  const next = db
    .select()
    .from(championshipMatches)
    .where(
      and(
        eq(championshipMatches.drawId, m.drawId),
        eq(championshipMatches.round, m.round + 1),
        eq(championshipMatches.matchIndex, Math.floor(m.matchIndex / 2)),
      ),
    )
    .get();
  if (!next) return;
  const goesTop = m.matchIndex % 2 === 0;
  db.update(championshipMatches)
    .set(
      goesTop
        ? { topEntryId: winnerEntryId, topIsBye: 0 }
        : { bottomEntryId: winnerEntryId, bottomIsBye: 0 },
    )
    .where(eq(championshipMatches.id, next.id))
    .run();
}

/* -------------------------------------------------------------------------- */
/* Email staging                                                              */
/* -------------------------------------------------------------------------- */

export function stageRoundOneMatchEmails(
  db: Db,
  championshipId: string,
  args: { round?: number } = {},
): { created: string[]; skipped: { matchId: string; reason: string }[] } {
  const detail = getChampionshipDetail(db, championshipId);
  if (!detail) throw new Error("championship_not_found");
  const round = args.round ?? 1;
  let seasonRoundJson: string | null | undefined;
  const sid = detail.championship.seasonId ?? null;
  if (sid) {
    const sRow = db
      .select()
      .from(seasons)
      .where(eq(seasons.id, sid))
      .get();
    seasonRoundJson = sRow?.championshipRoundDueDatesJson ?? undefined;
  }
  const due = resolveDueDateForChampionshipRound(
    seasonRoundJson,
    detail.activeDraw?.size ?? null,
    round,
    detail.championship.roundOneDueDate,
  );

  const created: string[] = [];
  const skipped: { matchId: string; reason: string }[] = [];

  if (!detail.activeDraw) {
    throw new Error("no_active_draw");
  }
  const matches = detail.activeDraw.matches.filter((m) => m.round === round);
  const entryById = new Map(detail.entries.map((e) => [e.id, e]));

  const entrantsStart = entrantsAtBracketRoundStart(
    detail.activeDraw.size,
    round,
  );
  const stageName = knockoutStageLabel(entrantsStart);

  for (const m of matches) {
    const draft = buildMatchAnnouncementDraft({
      detail,
      match: m,
      round,
      dueDate: due,
      stageName,
    });
    if ("reason" in draft) {
      skipped.push({ matchId: m.id, reason: draft.reason });
      continue;
    }

    const id = crypto.randomUUID();
    db.insert(emailOutbox)
      .values({
        id,
        kind: "championship_match",
        seasonId: detail.championship.seasonId ?? null,
        status: "draft",
        toAddress: draft.recipients.join(", "),
        subject: draft.subject,
        body: draft.body,
        metaJson: JSON.stringify({
          championshipId,
          matchId: m.id,
          round,
          topEntryId: draft.topEntryId,
          bottomEntryId: draft.bottomEntryId,
          dueDate: draft.dueDate,
        }),
      })
      .run();
    created.push(id);
  }

  return { created, skipped };
}

export function buildMatchAnnouncementDraft(args: {
  detail: ChampionshipDetail;
  match: ChampionshipMatchRow;
  round: number;
  dueDate: string | null;
  stageName?: string;
}): MatchAnnouncementDraft | { reason: string } {
  const { detail, match, round, dueDate } = args;
  if (match.topIsBye || match.bottomIsBye) {
    return { reason: "bye_match" };
  }
  const entryById = new Map(detail.entries.map((e) => [e.id, e]));
  const top = match.topEntryId ? entryById.get(match.topEntryId) : null;
  const bottom = match.bottomEntryId ? entryById.get(match.bottomEntryId) : null;
  if (!top || !bottom) {
    return { reason: "missing_entry" };
  }
  const recipients: string[] = [];
  if (top.playerEmail) recipients.push(top.playerEmail);
  if (top.partnerEmail) recipients.push(top.partnerEmail);
  if (bottom.playerEmail) recipients.push(bottom.playerEmail);
  if (bottom.partnerEmail) recipients.push(bottom.partnerEmail);
  if (recipients.length === 0) {
    return { reason: "no_emails_on_file" };
  }
  const topLabel = top.playerName + (top.partnerName ? ` & ${top.partnerName}` : "");
  const bottomLabel =
    bottom.playerName + (bottom.partnerName ? ` & ${bottom.partnerName}` : "");
  const entrantsStart = entrantsAtBracketRoundStart(
    detail.activeDraw?.size ?? 2,
    round,
  );
  const stageName = args.stageName ?? knockoutStageLabel(entrantsStart);
  const dueLine = dueDate
    ? `Please complete this match by ${dueDate}.`
    : "Please coordinate a time and complete the match as soon as possible.";
  const subject = `${detail.championship.name} — match: ${topLabel} vs ${bottomLabel}`;
  const body = [
    `Hi ${topLabel} and ${bottomLabel},`,
    "",
    `You're scheduled to play in the ${detail.championship.name} (${stageName}).`,
    "",
    `Matchup: ${topLabel} vs ${bottomLabel}`,
    dueLine,
    "",
    "Reply-all to this email to coordinate a time.",
    "",
    "Thanks!",
  ].join("\n");
  return {
    recipients,
    subject,
    body,
    stageName,
    dueDate,
    topEntryId: top.id,
    bottomEntryId: bottom.id,
  };
}
