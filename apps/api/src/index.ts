import "./load-env.js";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { and, eq, desc, asc, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assignManagedCourts,
  EMAIL_TEMPLATE_SCOPES,
  getWeekMatchups,
  interpolateEmailTemplate,
  suggestDraw,
  type PlayerSeed,
  rankBoxStandings,
  playoffSemis,
  topFourForPlayoffs,
} from "@squash/shared";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import {
  ensureCalendarSeasonRows,
  insertCalendarYearSeasons,
} from "./db/calendarSeasonsSeed.js";
import { ensureStatutoryHolidaysSeeded } from "./db/statutoryHolidaysSeed.js";
import {
  drawVersions,
  emailOutbox,
  emailTemplates,
  enrollments,
  feedbackTickets,
  leagueBoxes,
  leagueBoxPlayers,
  bookingProposals,
  playerBoxStats,
  players,
  registrationQueue,
  seasons,
  statutoryHolidays,
  syncRuns,
  weekPlans,
} from "./db/schema.js";
import {
  createClubLockerAdapter,
  upsertPlayersFromLocker,
} from "./adapters/club-locker.js";
import { createEmailAdapter } from "./adapters/email.js";
import {
  processRegistrationQueueItem,
} from "./services/registration.js";
import {
  executeBookingProposal,
  validateProposalForReview,
} from "./phase2/booking.js";
import { applyRatingAdjustments } from "./phase2/rating-feedback.js";
import {
  listAllCancellableBookings,
  listBookingHolds,
  listBookingRuns,
  listCancellableBookingsForWeek,
  listSeasonBookingHolds,
  previewBooking,
  previewSeasonBulk,
  removeSeasonBookingHold,
  runSeasonBulkBooking,
  runWeeklyConvert,
  cancelBookingCalendarItems,
} from "./booking/service.js";
import {
  createUssquashClient,
  normalizeJsonArray,
} from "./booking/clubLockerClient.js";
import { runSingleCourtMatchBooking } from "./booking/singleCourtMatch.js";
import { registerChampionshipRoutes } from "./championships/routes.js";
import {
  normalizeRoundDueDatesPayload,
  stringifyRoundDueDates,
  type ChampionshipRoundDueDatesMap,
} from "./championships/roundDueDates.js";
import { createAiAgent } from "./automation/aiAgent.js";
import { registerAutomationRoutes } from "./automation/routes.js";
import { ImapAutomationPoller } from "./automation/imapPoller.js";
import { runSchedulerTick } from "./automation/scheduler.js";
import { isSettingOn, seedAutomationSettings } from "./automation/settings.js";
import {
  getHouseLeagueEmailReminderSettings,
  patchHouseLeagueEmailReminderSettings,
  seedHouseLeagueEmailReminderSettings,
} from "./houseLeague/emailReminderSettings.js";
import { queueHouseLeagueReminderTestSend } from "./houseLeague/reminderTestSend.js";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
ensureStatutoryHolidaysSeeded(db);
const emailAdapter = createEmailAdapter(config.EMAIL_ADAPTER, {
  gmail:
    config.GMAIL_USER && config.GMAIL_APP_PASSWORD
      ? {
          user: config.GMAIL_USER,
          appPassword: config.GMAIL_APP_PASSWORD,
          fromName: config.GMAIL_FROM_NAME,
        }
      : undefined,
});
const aiAgent = createAiAgent(config);
seedAutomationSettings(db);
seedHouseLeagueEmailReminderSettings(db);
const imapPoller = new ImapAutomationPoller({ db, config, emailAdapter, aiAgent });

const mockLockerRoster: PlayerSeed[] = Array.from({ length: 24 }, (_, i) => ({
  id: `ext-${i + 1}`,
  displayName: `Player ${i + 1}`,
  rating: 5.2 - i * 0.08,
  priorBoxFinish: (i % 6) + 1,
}));

function lockerAdapter() {
  return createClubLockerAdapter(
    config.CLUB_LOCKER_ADAPTER,
    db,
    mockLockerRoster.map((p) => ({
      externalId: p.id,
      displayName: p.displayName,
      email: `player${p.id.replace("ext-", "")}@example.test`,
      rating: p.rating,
    })),
  );
}

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get("/health", async () => ({ ok: true }));

function statutoryHolidayRowToJson(row: typeof statutoryHolidays.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    date: row.date,
    hours: {
      open: row.openTime,
      close: row.closeTime,
      closed: row.closed === 1,
    },
  };
}

app.get("/api/statutory-holidays", async () => {
  const rows = db
    .select()
    .from(statutoryHolidays)
    .orderBy(asc(statutoryHolidays.date), asc(statutoryHolidays.name))
    .all();
  return rows.map(statutoryHolidayRowToJson);
});

const statutoryHolidayPostBody = z
  .object({
    name: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    open: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
    close: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
    closed: z.boolean(),
  })
  .superRefine((b, ctx) => {
    if (!b.closed && (!b.open || !b.close)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "When the club is not fully closed, open and close times (HH:MM) are required.",
        path: ["open"],
      });
    }
  });

app.post("/api/statutory-holidays", async (req, reply) => {
  const body = statutoryHolidayPostBody.parse(req.body);
  const clash = db
    .select({ id: statutoryHolidays.id })
    .from(statutoryHolidays)
    .where(eq(statutoryHolidays.date, body.date))
    .get();
  if (clash) {
    return reply.code(409).send({
      error: "Another statutory holiday is already stored on that date.",
    });
  }
  const id = crypto.randomUUID();
  db.insert(statutoryHolidays)
    .values({
      id,
      name: body.name.trim(),
      date: body.date,
      openTime: body.closed ? null : body.open,
      closeTime: body.closed ? null : body.close,
      closed: body.closed ? 1 : 0,
    })
    .run();
  const row = db.select().from(statutoryHolidays).where(eq(statutoryHolidays.id, id)).get();
  return row ? statutoryHolidayRowToJson(row) : null;
});

app.delete("/api/statutory-holidays/:id", async (req, reply) => {
  const { id: paramId } = req.params as { id: string };
  const id = z.string().uuid().safeParse(paramId);
  if (!id.success) {
    return reply.code(400).send({ error: "Invalid id" });
  }
  const res = db
    .delete(statutoryHolidays)
    .where(eq(statutoryHolidays.id, id.data))
    .run();
  if (res.changes === 0) {
    return reply.code(404).send({ error: "Not found" });
  }
  return { ok: true as const };
});

const FEEDBACK_SCREENSHOT_MAX_BYTES = 3 * 1024 * 1024;

const feedbackTicketPostBody = z.preprocess((raw: unknown) => {
  if (!raw || typeof raw !== "object") return raw;
  const o = { ...(raw as Record<string, unknown>) };
  const sb = o.screenshotBase64;
  if (typeof sb === "string" && sb.trimStart().startsWith("data:")) {
    const m = sb.match(/^data:([^;]+);base64,(.+)$/);
    if (m) {
      if (o.screenshotMime == null || o.screenshotMime === "") {
        o.screenshotMime = m[1];
      }
      o.screenshotBase64 = m[2]!.replace(/\s/g, "");
    }
  }
  return o;
}, z
  .object({
    kind: z.enum(["bug", "feature"]),
    description: z.string().trim().min(1).max(20_000),
    screenshotMime: z.string().optional().nullable(),
    screenshotBase64: z.string().optional().nullable(),
  })
  .superRefine((data, ctx) => {
    const mime = data.screenshotMime?.trim() || null;
    const b64 = data.screenshotBase64?.trim() || null;
    if (!mime && !b64) return;
    if (!mime || !b64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Screenshot requires both MIME type and base64 data.",
        path: ["screenshotBase64"],
      });
      return;
    }
    if (!/^image\/(png|jpe?g|gif|webp)$/i.test(mime)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Screenshot must be PNG, JPEG, GIF, or WebP.",
        path: ["screenshotMime"],
      });
      return;
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid base64 image data.",
        path: ["screenshotBase64"],
      });
      return;
    }
    if (buf.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Empty image data.",
        path: ["screenshotBase64"],
      });
      return;
    }
    if (buf.length > FEEDBACK_SCREENSHOT_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Screenshot too large (max ${FEEDBACK_SCREENSHOT_MAX_BYTES / (1024 * 1024)}MB).`,
        path: ["screenshotBase64"],
      });
    }
  }));

function feedbackTicketRowToJson(row: typeof feedbackTickets.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    description: row.description,
    screenshot:
      row.screenshotMime && row.screenshotBase64
        ? { mime: row.screenshotMime, base64: row.screenshotBase64 }
        : null,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}

app.get("/api/feedback-tickets", async () => {
  const rows = db
    .select()
    .from(feedbackTickets)
    .orderBy(
      desc(sql`${feedbackTickets.completedAt} IS NULL`),
      desc(feedbackTickets.createdAt),
    )
    .all();
  return rows.map(feedbackTicketRowToJson);
});

app.post(
  "/api/feedback-tickets",
  { bodyLimit: 8 * 1024 * 1024 },
  async (req, reply) => {
    const parsed = feedbackTicketPostBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid body",
        details: parsed.error.flatten(),
      });
    }
    const body = parsed.data;
    const mime = body.screenshotMime?.trim() || null;
    const b64 = body.screenshotBase64?.trim() || null;
    const id = crypto.randomUUID();
    db.insert(feedbackTickets)
      .values({
        id,
        kind: body.kind,
        description: body.description.trim(),
        screenshotMime: mime && b64 ? mime : null,
        screenshotBase64: mime && b64 ? b64 : null,
      })
      .run();
    const row = db
      .select()
      .from(feedbackTickets)
      .where(eq(feedbackTickets.id, id))
      .get();
    return row ? feedbackTicketRowToJson(row) : null;
  },
);

const feedbackTicketPatchBody = z.object({
  completed: z.boolean(),
});

app.patch("/api/feedback-tickets/:id", async (req, reply) => {
  const { id: paramId } = req.params as { id: string };
  const idParse = z.string().uuid().safeParse(paramId);
  if (!idParse.success) {
    return reply.code(400).send({ error: "Invalid id" });
  }
  const parsed = feedbackTicketPatchBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "Invalid body",
      details: parsed.error.flatten(),
    });
  }
  const { completed } = parsed.data;
  const completedAt = completed
    ? new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
    : null;
  const res = db
    .update(feedbackTickets)
    .set({ completedAt })
    .where(eq(feedbackTickets.id, idParse.data))
    .run();
  if (res.changes === 0) {
    return reply.code(404).send({ error: "Not found" });
  }
  const row = db
    .select()
    .from(feedbackTickets)
    .where(eq(feedbackTickets.id, idParse.data))
    .get();
  return row ? feedbackTicketRowToJson(row) : null;
});

app.delete("/api/feedback-tickets/:id", async (req, reply) => {
  const { id: paramId } = req.params as { id: string };
  const idParse = z.string().uuid().safeParse(paramId);
  if (!idParse.success) {
    return reply.code(400).send({ error: "Invalid id" });
  }
  const res = db
    .delete(feedbackTickets)
    .where(eq(feedbackTickets.id, idParse.data))
    .run();
  if (res.changes === 0) {
    return reply.code(404).send({ error: "Not found" });
  }
  return { ok: true as const };
});

registerChampionshipRoutes(app, db);
registerAutomationRoutes(app, {
  db,
  config,
  emailAdapter,
  aiAgent,
  poller: imapPoller,
});

function todayIsoLocalDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Non-secret US Squash wiring; used by the Members UI to explain mock vs live. */
app.get("/api/us-squash-status", async () => ({
  mode: config.US_SQUASH_MODE,
  clubId: config.US_SQUASH_CLUB_ID,
  bearerConfigured: Boolean(config.US_SQUASH_BEARER_TOKEN),
  sessionCookieConfigured: Boolean(config.US_SQUASH_SESSION_COOKIE),
}));

const singleCourtMatchBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slotBegin: z.string().regex(/^\d{1,2}:\d{2}$/),
  slotEnd: z.string().regex(/^\d{1,2}:\d{2}$/),
  courtSide: z.enum(["stadium", "center"]),
  player1SsmId: z.coerce.number().int().positive(),
  player2SsmId: z.coerce.number().int().positive(),
  player1Name: z.string().min(1),
  player2Name: z.string().min(1),
});

app.post("/api/booking/single-court-match", async (req, reply) => {
  const body = singleCourtMatchBody.safeParse(req.body ?? {});
  if (!body.success) {
    return reply.code(400).send({
      ok: false,
      message: "Invalid request",
      detail: body.error.flatten(),
    });
  }
  if (body.data.player1SsmId === body.data.player2SsmId) {
    return reply.code(400).send({
      ok: false,
      message: "Choose two different players.",
    });
  }
  try {
    const inbound = body.data;
    const result = await runSingleCourtMatchBooking(config, {
      date: inbound.date,
      slotBegin: inbound.slotBegin,
      slotEnd: inbound.slotEnd,
      courtSide: inbound.courtSide,
      player1SsmId: inbound.player1SsmId,
      player2SsmId: inbound.player2SsmId,
      player1Name: inbound.player1Name,
      player2Name: inbound.player2Name,
    });
    const payload = {
      ...result,
      debugInboundBody: inbound,
      debugOutboundClubLockerBody: result.outboundClubLockerBody,
    };
    const code =
      result.ok ? 200
      : result.status >= 400 && result.status < 600 ? result.status
      : 502;
    if (!result.ok) {
      return reply.code(code).send(payload);
    }
    return payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ ok: false, status: 500, data: null, message });
  }
});

app.get("/api/club-members", async (_req, reply) => {
  try {
    const client = createUssquashClient(config);
    const { status, data } = await client.listClubMembers(
      config.US_SQUASH_CLUB_ID,
    );
    if (status < 200 || status >= 300) {
      return reply.code(status).send(data);
    }
    if (!Array.isArray(data)) {
      return reply.code(502).send({
        error: "Unexpected club members response shape",
        detail: data,
      });
    }
    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: message });
  }
});

app.get("/api/houseleague/events", async (_req, reply) => {
  try {
    const client = createUssquashClient(config);
    const { status, data } = await client.listBoxLeaguesForClub(
      config.US_SQUASH_CLUB_ID,
    );
    if (status < 200 || status >= 300) {
      return reply.code(status).send(data);
    }
    const rows = normalizeJsonArray(data);
    return rows;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: message });
  }
});

app.get("/api/houseleague/events/:eventId/players", async (req, reply) => {
  try {
    const { eventId } = req.params as { eventId: string };
    const idNum = Number(eventId);
    if (!Number.isFinite(idNum) || idNum <= 0) {
      return reply.code(400).send({ error: "invalid_event_id" });
    }
    const client = createUssquashClient(config);
    const { status, data } = await client.listBoxLeaguePlayers(idNum);
    if (status < 200 || status >= 300) {
      return reply.code(status).send(data);
    }
    const rows = normalizeJsonArray(data);
    return rows;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: message });
  }
});

const houseleagueMoveBody = z.object({
  level: z.number().int().min(0),
});

app.put("/api/houseleague/events/:eventId/players/:playerId", async (req, reply) => {
  try {
    const { eventId, playerId } = req.params as {
      eventId: string;
      playerId: string;
    };
    const eventNum = Number(eventId);
    const playerNum = Number(playerId);
    if (!Number.isFinite(eventNum) || eventNum <= 0) {
      return reply.code(400).send({ error: "invalid_event_id" });
    }
    if (!Number.isFinite(playerNum) || playerNum <= 0) {
      return reply.code(400).send({ error: "invalid_player_id" });
    }
    const parsed = houseleagueMoveBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_body",
        detail: parsed.error.flatten(),
      });
    }
    const client = createUssquashClient(config);
    const { status, data } = await client.updateBoxLeaguePlayerLevel(
      eventNum,
      playerNum,
      parsed.data.level,
    );
    if (status < 200 || status >= 300) {
      return reply.code(status).send(data);
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: message });
  }
});

app.get("/api/players", async () => {
  return db.select().from(players).all();
});

const playerBody = z.object({
  displayName: z.string(),
  email: z.string().email().optional(),
  rating: z.number().optional(),
  externalId: z.string().optional(),
});

app.post("/api/players", async (req) => {
  const body = playerBody.parse(req.body);
  const id = crypto.randomUUID();
  db.insert(players)
    .values({
      id,
      displayName: body.displayName,
      email: body.email,
      rating: String(body.rating ?? 3.0),
      externalId: body.externalId,
    })
    .run();
  return db.select().from(players).where(eq(players.id, id)).get();
});

/** Upsert a roster player from US Squash club member data (matches Members tab list). */
const clubMemberPlayerBody = z.object({
  ssmId: z.number().int().positive(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  ratingSingles: z.number().nullable().optional(),
});

app.post("/api/players/from-club-member", async (req, reply) => {
  const body = clubMemberPlayerBody.parse(req.body);
  const externalId = String(body.ssmId);
  const existing = db
    .select()
    .from(players)
    .where(eq(players.externalId, externalId))
    .get();
  if (existing) return existing;

  const id = crypto.randomUUID();
  const displayName =
    `${body.firstName} ${body.lastName}`.trim() ||
    body.email.trim() ||
    `Member ${body.ssmId}`;
  const emailNorm = body.email.trim() || null;
  const rating =
    body.ratingSingles != null && Number.isFinite(body.ratingSingles)
      ? String(body.ratingSingles)
      : "3.0";

  db.insert(players)
    .values({
      id,
      externalId,
      displayName,
      email: emailNorm,
      rating,
    })
    .run();

  const row = db.select().from(players).where(eq(players.id, id)).get();
  if (!row)
    return reply.code(500).send({ error: "player_insert_failed" });
  return row;
});

app.get("/api/seasons", async () => {
  ensureCalendarSeasonRows(db);
  return db
    .select()
    .from(seasons)
    .orderBy(
      desc(seasons.clubYear),
      sql`CASE calendar_segment
        WHEN 'winter' THEN 0
        WHEN 'spring' THEN 1
        WHEN 'summer' THEN 2
        WHEN 'fall' THEN 3
        ELSE 4 END`,
    )
    .all();
});

const championshipSeasonRoundDatesPatch = z.object({
  rounds: z.record(z.union([z.string(), z.null()])),
});

app.patch(
  "/api/seasons/:seasonId/championship-round-dates",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const body = championshipSeasonRoundDatesPatch.parse(req.body ?? {});
    const row = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
    if (!row)
      return reply.code(404).send({ error: "season_not_found" });
    const normalized = normalizeRoundDueDatesPayload(
      body.rounds as ChampionshipRoundDueDatesMap,
    );
    const json = stringifyRoundDueDates(normalized);
    db.update(seasons)
      .set({ championshipRoundDueDatesJson: json ?? null })
      .where(eq(seasons.id, seasonId))
      .run();
    return db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
  },
);

const seasonBody = z
  .object({
    name: z.string().optional(),
    clubYear: z.coerce.number().int().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    status: z.string().optional(),
  })
  .refine(
    (b) => b.clubYear != null || (b.name != null && b.name.length > 0),
    {
      message:
        "Provide clubYear (inserts four calendar seasons for that year) or name (single row)",
    },
  );

app.post("/api/seasons", async (req) => {
  const body = seasonBody.parse(req.body);
  if (body.clubYear != null) {
    insertCalendarYearSeasons(db, body.clubYear, body.status ?? "registration");
    return db
      .select()
      .from(seasons)
      .where(eq(seasons.clubYear, body.clubYear))
      .orderBy(
        sql`CASE calendar_segment
          WHEN 'winter' THEN 0
          WHEN 'spring' THEN 1
          WHEN 'summer' THEN 2
          WHEN 'fall' THEN 3
          ELSE 4 END`,
      )
      .all();
  }
  const id = crypto.randomUUID();
  db.insert(seasons)
    .values({
      id,
      name: body.name!,
      startDate: body.startDate,
      endDate: body.endDate,
      status: body.status ?? "registration",
    })
    .run();
  return db.select().from(seasons).where(eq(seasons.id, id)).get();
});

app.post("/api/seasons/:seasonId/sync", async (req) => {
  const { seasonId } = req.params as { seasonId: string };
  const season = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
  if (!season) return { error: "season_not_found" };
  const runId = crypto.randomUUID();
  try {
    const adapter = lockerAdapter();
    const remote = await adapter.pullPlayers();
    const n = upsertPlayersFromLocker(db, remote);
    db.insert(syncRuns)
      .values({
        id: runId,
        source: "club_locker",
        status: "ok",
        detail: JSON.stringify({ upserted: n }),
      })
      .run();
    return { ok: true, upserted: n, syncRunId: runId };
  } catch (e) {
    db.insert(syncRuns)
      .values({
        id: runId,
        source: "club_locker",
        status: "error",
        detail: String(e),
      })
      .run();
    return { ok: false, error: String(e), syncRunId: runId };
  }
});

app.get("/api/sync-runs", async () => {
  return db.select().from(syncRuns).orderBy(desc(syncRuns.createdAt)).limit(50).all();
});

/* Registration queue */
app.get("/api/registration-queue", async () => {
  return db.select().from(registrationQueue).orderBy(desc(registrationQueue.createdAt)).all();
});

const regBody = z.object({
  kind: z.enum(["opt_in", "opt_out"]),
  fromEmail: z.string().email(),
  subject: z.string().optional(),
  body: z.string().optional(),
  parsedName: z.string().optional(),
});

app.post("/api/registration-queue", async (req) => {
  const body = regBody.parse(req.body);
  const id = crypto.randomUUID();
  db.insert(registrationQueue)
    .values({
      id,
      kind: body.kind,
      fromEmail: body.fromEmail,
      subject: body.subject,
      body: body.body,
      parsedName: body.parsedName,
      status: "pending",
    })
    .run();
  processRegistrationQueueItem(db, id);
  return db.select().from(registrationQueue).where(eq(registrationQueue.id, id)).get();
});

app.post("/api/registration-queue/:id/process", async (req) => {
  const { id } = req.params as { id: string };
  return processRegistrationQueueItem(db, id);
});

app.get("/api/seasons/:seasonId/enrollments", async (req) => {
  const { seasonId } = req.params as { seasonId: string };
  return db.select().from(enrollments).where(eq(enrollments.seasonId, seasonId)).all();
});

const applyEnrollmentBody = z.object({ seasonId: z.string() });

app.post("/api/registration-queue/:id/apply-enrollment", async (req) => {
  const { id } = req.params as { id: string };
  const body = applyEnrollmentBody.parse(req.body);
  const row = db.select().from(registrationQueue).where(eq(registrationQueue.id, id)).get();
  if (!row?.matchedPlayerId) return { error: "not_matched" };
  const eid = crypto.randomUUID();
  db.insert(enrollments)
    .values({
      id: eid,
      seasonId: body.seasonId,
      playerId: row.matchedPlayerId,
      status: row.kind === "opt_out" ? "withdrawn" : "enrolled",
    })
    .run();
  db.update(registrationQueue)
    .set({ status: "applied" })
    .where(eq(registrationQueue.id, id))
    .run();
  return { ok: true, enrollmentId: eid };
});

/** Prior-season roster for director review (stub: all players in DB). */
app.get("/api/seasons/:seasonId/re-enrollment-candidates", async () => {
  const roster = db.select().from(players).all();
  return {
    note: "Stub: replace with prior-season box membership from Club Locker sync",
    candidates: roster.map((p) => ({ playerId: p.id, displayName: p.displayName })),
  };
});

/* Draw */
app.post("/api/seasons/:seasonId/draw/suggest", async (req) => {
  const { seasonId } = req.params as { seasonId: string };
  const roster = db.select().from(players).all();
  const seeds: PlayerSeed[] = roster.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    rating: Number(p.rating),
  }));
  const boxes = suggestDraw(seeds);
  const id = crypto.randomUUID();
  db.insert(drawVersions)
    .values({
      id,
      seasonId,
      status: "draft",
      boxesJson: JSON.stringify(boxes),
    })
    .run();
  return { drawVersionId: id, boxes };
});

const approveDrawBody = z.object({
  drawVersionId: z.string(),
  boxesJson: z.string().optional(),
});

app.post("/api/seasons/:seasonId/draw/approve", async (req) => {
  const { seasonId } = req.params as { seasonId: string };
  const body = approveDrawBody.parse(req.body);
  const dv = db
    .select()
    .from(drawVersions)
    .where(eq(drawVersions.id, body.drawVersionId))
    .get();
  if (!dv || dv.seasonId !== seasonId) return { error: "draw_not_found" };
  const boxes = JSON.parse(body.boxesJson ?? dv.boxesJson) as {
    boxNumber: number;
    playerIds: string[];
  }[];
  db.delete(leagueBoxes).where(eq(leagueBoxes.seasonId, seasonId)).run();
  for (const box of boxes) {
    const bid = crypto.randomUUID();
    db.insert(leagueBoxes)
      .values({
        id: bid,
        seasonId,
        boxNumber: box.boxNumber,
      })
      .run();
    let seat = 1;
    for (const pid of box.playerIds) {
      const lbpId = crypto.randomUUID();
      db.insert(leagueBoxPlayers)
        .values({
          id: lbpId,
          boxId: bid,
          playerId: pid,
          seat,
        })
        .run();
      seat++;
    }
  }
  db.update(drawVersions)
    .set({ status: "approved" })
    .where(eq(drawVersions.id, body.drawVersionId))
    .run();
  return { ok: true, boxes };
});

/* Weekly */
app.post("/api/seasons/:seasonId/weeks/:week/generate", async (req) => {
  const { seasonId, week } = req.params as { seasonId: string; week: string };
  const w = Number(week);
  const boxes = db.select().from(leagueBoxes).where(eq(leagueBoxes.seasonId, seasonId)).all();
  const payload: Record<string, unknown> = { week: w, boxes: [] as unknown[] };
  for (const box of boxes) {
    const seats = db
      .select()
      .from(leagueBoxPlayers)
      .where(eq(leagueBoxPlayers.boxId, box.id))
      .all();
    const bySeat = Object.fromEntries(seats.map((s) => [s.seat, s.playerId])) as Record<
      number,
      string
    >;
    const mu = getWeekMatchups(w);
    const resolve = (seat: number) => bySeat[seat];
    const matchesWithPlayers = mu.matches.map(
      (m) =>
        [resolve(m[0]), resolve(m[1])] as [string | undefined, string | undefined],
    );
    const managed = box.boxNumber <= 16;
    const courtPreview = managed
      ? assignManagedCourts(mu.matches)
      : [];
    (payload.boxes as unknown[]).push({
      boxId: box.id,
      boxNumber: box.boxNumber,
      managed,
      matchups: matchesWithPlayers,
      bySeatNumbers: mu.byes,
      courtPreview,
    });
  }
  const id = crypto.randomUUID();
  db.insert(weekPlans)
    .values({
      id,
      seasonId,
      weekNumber: w,
      payloadJson: JSON.stringify(payload),
      status: "draft",
    })
    .run();
  return { weekPlanId: id, payload };
});

const emailTemplateScopeSchema = z.enum(EMAIL_TEMPLATE_SCOPES);

/* Email templates (director-authored `{{variables}}`) */
app.get("/api/email-templates", async (req, reply) => {
  const rawQ =
    typeof req.query === "object" && req.query !== null
      ? (req.query as { scope?: unknown }).scope
      : undefined;
  const rawScope =
    typeof rawQ === "string"
      ? rawQ
      : Array.isArray(rawQ) && typeof rawQ[0] === "string"
        ? rawQ[0]
        : undefined;

  if (rawScope !== undefined && rawScope !== "") {
    const scopeParsed = emailTemplateScopeSchema.safeParse(rawScope);
    if (!scopeParsed.success) {
      return reply.code(400).send({ error: "invalid_scope" });
    }
    return db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.scope, scopeParsed.data))
      .orderBy(asc(emailTemplates.name))
      .all();
  }
  return db.select().from(emailTemplates).orderBy(asc(emailTemplates.name)).all();
});

const createEmailTemplateBody = z.object({
  name: z.string().min(1),
  subjectTemplate: z.string().min(1),
  bodyTemplate: z.string().min(1),
  scope: emailTemplateScopeSchema,
});

app.post("/api/email-templates", async (req) => {
  const body = createEmailTemplateBody.parse(req.body);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.insert(emailTemplates)
    .values({
      id,
      name: body.name.trim(),
      scope: body.scope,
      subjectTemplate: body.subjectTemplate,
      bodyTemplate: body.bodyTemplate,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return db.select().from(emailTemplates).where(eq(emailTemplates.id, id)).get();
});

const patchEmailTemplateBody = z.object({
  name: z.string().min(1).optional(),
  subjectTemplate: z.string().min(1).optional(),
  bodyTemplate: z.string().min(1).optional(),
  scope: emailTemplateScopeSchema.optional(),
});

app.patch("/api/email-templates/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const row = db.select().from(emailTemplates).where(eq(emailTemplates.id, id)).get();
  if (!row) return reply.code(404).send({ error: "not_found" });
  const body = patchEmailTemplateBody.parse(req.body ?? {});
  if (
    !body.name &&
    body.subjectTemplate == null &&
    body.bodyTemplate == null &&
    body.scope == null
  ) {
    return reply.code(400).send({ error: "nothing_to_patch" });
  }
  db.update(emailTemplates)
    .set({
      ...(body.name != null ? { name: body.name.trim() } : {}),
      ...(body.subjectTemplate != null ? { subjectTemplate: body.subjectTemplate } : {}),
      ...(body.bodyTemplate != null ? { bodyTemplate: body.bodyTemplate } : {}),
      ...(body.scope != null ? { scope: body.scope } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(emailTemplates.id, id))
    .run();
  return db.select().from(emailTemplates).where(eq(emailTemplates.id, id)).get();
});

app.delete("/api/email-templates/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const existing = db.select().from(emailTemplates).where(eq(emailTemplates.id, id)).get();
  if (!existing) return reply.code(404).send({ error: "not_found" });
  db.delete(emailTemplates).where(eq(emailTemplates.id, id)).run();
  return { ok: true };
});

const patchHouseLeagueRemindersBody = z.object({
  enabled: z.boolean().optional(),
  daysBefore: z.number().int().min(0).max(14).optional(),
  templateId: z.string().nullable().optional(),
});

app.get("/api/house-league/email-reminders", async () =>
  getHouseLeagueEmailReminderSettings(db),
);

app.patch("/api/house-league/email-reminders", async (req, reply) => {
  const body = patchHouseLeagueRemindersBody.parse(req.body ?? {});
  try {
    return patchHouseLeagueEmailReminderSettings(db, body);
  } catch (e) {
    if (e instanceof Error && e.message === "invalid_template") {
      return reply.code(400).send({ error: "invalid_template" });
    }
    throw e;
  }
});

app.post("/api/house-league/email-reminders/test-send", async (req, reply) => {
  const res = queueHouseLeagueReminderTestSend(db, req.body ?? {});
  if (!res.ok) {
    const code = res.error === "player_not_found" ? 404 : 400;
    return reply.code(code).send({ error: res.error });
  }
  return { ok: true, id: res.id, scheduledSendAt: res.scheduledSendAt };
});

/* Email outbox */
app.get("/api/email-outbox", async () => {
  return db.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt)).limit(100).all();
});

app.post("/api/seasons/:seasonId/weeks/:week/email-self-managed", async (req) => {
  const { seasonId, week } = req.params as { seasonId: string; week: string };
  const w = Number(week);
  const plan = db
    .select()
    .from(weekPlans)
    .where(eq(weekPlans.seasonId, seasonId))
    .all()
    .filter((p) => p.weekNumber === w)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!plan) return { error: "week_plan_missing" };
  const payload = JSON.parse(plan.payloadJson) as {
    boxes: {
      boxNumber: number;
      managed: boolean;
      matchups: [string, string][];
    }[];
  };
  const created: string[] = [];
  const allPlayers = db.select().from(players).all();
  const nameOf = (id: string) => allPlayers.find((p) => p.id === id)?.displayName ?? id;
  for (const b of payload.boxes) {
    if (b.managed) continue;
    const boxRow = db
      .select()
      .from(leagueBoxes)
      .where(
        and(eq(leagueBoxes.seasonId, seasonId), eq(leagueBoxes.boxNumber, b.boxNumber)),
      )
      .get();
    if (!boxRow) continue;
    const seatRows = db
      .select()
      .from(leagueBoxPlayers)
      .where(eq(leagueBoxPlayers.boxId, boxRow.id))
      .all();
    const ids = seatRows.map((r) => r.playerId);
    const addrs = allPlayers.filter((p) => ids.includes(p.id) && p.email);
    const to = addrs.map((p) => p.email).filter(Boolean).join(", ");
    const subject = `House league week ${w} — Box ${b.boxNumber} matchups`;
    const bodyText = `Your matchups this week:\n${b.matchups.map((m) => `- ${nameOf(m[0])} vs ${nameOf(m[1])}`).join("\n")}\nPlease arrange time and book a court in Club Locker.`;
    const eid = crypto.randomUUID();
    db.insert(emailOutbox)
      .values({
        id: eid,
        kind: "weekly_box",
        seasonId,
        status: "draft",
        toAddress: to || "unknown@example.test",
        subject,
        body: bodyText,
        metaJson: JSON.stringify({ boxNumber: b.boxNumber, week: w }),
      })
      .run();
    created.push(eid);
  }
  return { created };
});

app.post("/api/email-outbox/:id/approve", async (req) => {
  const { id } = req.params as { id: string };
  db.update(emailOutbox).set({ status: "approved" }).where(eq(emailOutbox.id, id)).run();
  return { ok: true };
});

app.post("/api/email-outbox/:id/send", async (req) => {
  const { id } = req.params as { id: string };
  const row = db.select().from(emailOutbox).where(eq(emailOutbox.id, id)).get();
  if (!row) return { error: "not_found" };
  if (row.status !== "approved") return { error: "not_approved" };
  const res = await emailAdapter.send({
    to: row.toAddress,
    subject: row.subject,
    body: row.body,
    meta: row.metaJson ? JSON.parse(row.metaJson) : undefined,
  });
  if (!res.ok) {
    return { ok: false, error: res.error };
  }
  db.update(emailOutbox).set({ status: "sent" }).where(eq(emailOutbox.id, id)).run();
  return { ok: true };
});

/** Send a one-off test message to roster players’ emails (director-controlled recipients). */
app.post("/api/emails/test-send", async (req, reply) => {
  const body = z
    .object({
      playerIds: z.array(z.string().min(1)).min(1),
      subject: z.string().optional().default("[Test] Director email"),
      body: z.string().min(1, "Body is required"),
      /** Client placeholders (championship matchup, {{matchRound}}, etc.). Server fills `playerName`, `playerName2`–`4`, and `date`. */
      substitutionVars: z.record(z.string()).optional(),
    })
    .parse(req.body);
  const uniqueIds = [...new Set(body.playerIds)];
  const rows: { id: string; email: string; displayName: string }[] = [];
  for (const pid of uniqueIds) {
    const player = db.select().from(players).where(eq(players.id, pid)).get();
    if (!player)
      return reply.code(404).send({ error: "player_not_found", playerId: pid });
    const to = player.email?.trim();
    if (!to)
      return reply
        .code(400)
        .send({ error: "player_has_no_email", playerId: pid });
    rows.push({ id: player.id, email: to, displayName: player.displayName });
  }

  const subjectTpl = body.subject.trim() || "[Test] Director email";

  /** One send per listed player; `playerName` / `playerName2`–`4` derived from the request order. */
  const baseVars = body.substitutionVars ?? {};

  let lastError: string | undefined;
  for (const r of rows) {
    const others = rows
      .filter((x) => x.id !== r.id)
      .map((x) => x.displayName)
      .slice(0, 3);
    const vars: Record<string, string> = {
      ...baseVars,
      playerName: r.displayName,
      playerName2: others[0] ?? "",
      playerName3: others[1] ?? "",
      playerName4: others[2] ?? "",
      date: todayIsoLocalDate(),
    };
    const subjectResolved = interpolateEmailTemplate(subjectTpl, vars);
    const bodyResolved = interpolateEmailTemplate(body.body, vars);
    const sendRes = await emailAdapter.send({
      to: r.email,
      subject: subjectResolved,
      body: bodyResolved,
      meta: {
        kind: "director_test_email",
        playerIds: rows.map((r) => r.id),
      },
    });
    if (!sendRes.ok) {
      lastError = sendRes.error;
      break;
    }
  }
  if (lastError) {
    return reply.code(502).send({ ok: false, error: lastError });
  }

  return { ok: true, sent: rows.length };
});

/* Playoffs */
app.post("/api/seasons/:seasonId/playoffs/preview", async (req) => {
  const { seasonId } = req.params as { seasonId: string };
  const boxes = db.select().from(leagueBoxes).where(eq(leagueBoxes.seasonId, seasonId)).all();
  const out: unknown[] = [];
  for (const box of boxes) {
    const stats = db
      .select()
      .from(playerBoxStats)
      .where(eq(playerBoxStats.boxId, box.id))
      .all();
    const ranked =
      stats.length > 0
        ? topFourForPlayoffs(rankBoxStandings(stats.map((s) => ({
            playerId: s.playerId,
            wins: s.wins,
            losses: s.losses,
          }))))
        : [];
    const semis = ranked.length === 4 ? playoffSemis(ranked as [string, string, string, string]) : null;
    out.push({ boxNumber: box.boxNumber, ranked, semis });
  }
  return { boxes: out };
});

const statBody = z.object({
  playerId: z.string(),
  wins: z.number().int(),
  losses: z.number().int(),
});

app.post("/api/seasons/:seasonId/boxes/:boxId/stats", async (req) => {
  const { seasonId, boxId } = req.params as { seasonId: string; boxId: string };
  const body = statBody.parse(req.body);
  const id = crypto.randomUUID();
  db.insert(playerBoxStats)
    .values({
      id,
      seasonId,
      boxId,
      playerId: body.playerId,
      wins: body.wins,
      losses: body.losses,
    })
    .run();
  return { ok: true };
});

/* Court booking (US Squash / Club Locker) */
app.get(
  "/api/seasons/:seasonId/booking/weeks/:week/preview",
  async (req) => {
    const { seasonId, week } = req.params as { seasonId: string; week: string };
    const q = z
      .object({
        mondayDate: z.string().min(1),
        tuesdayDate: z.string().min(1),
      })
      .parse(req.query);
    const w = Number(week);
    return previewBooking(db, config, seasonId, w, q.mondayDate, q.tuesdayDate);
  },
);

app.get(
  "/api/seasons/:seasonId/booking/season-bulk/preview",
  async (req) => {
    const { seasonId } = req.params as { seasonId: string };
    const q = z
      .object({
        startMondayDate: z.string().min(1),
        seasonWeeks: z.coerce.number().int().min(1).optional(),
      })
      .parse(req.query);
    return previewSeasonBulk(db, config, {
      seasonId,
      startMondayDate: q.startMondayDate,
      seasonWeeks: q.seasonWeeks ?? config.LEAGUE_SEASON_WEEKS,
    });
  },
);

app.post(
  "/api/seasons/:seasonId/booking/season-bulk",
  async (req) => {
    const { seasonId } = req.params as { seasonId: string };
    const body = z
      .object({
        startMondayDate: z.string().min(1),
        seasonWeeks: z.coerce.number().int().min(1).optional(),
        confirm: z.boolean(),
      })
      .parse(req.body);
    return runSeasonBulkBooking(db, config, { seasonId, ...body });
  },
);

app.post("/api/seasons/:seasonId/booking/convert", async (req) => {
  const { seasonId } = req.params as { seasonId: string };
  const body = z
    .object({
      week: z.coerce.number().int().min(1),
      holdId: z.string().optional(),
      confirm: z.boolean(),
      notifyOnDelete: z.boolean().default(true),
    })
    .parse(req.body);
  return runWeeklyConvert(db, config, { seasonId, ...body });
});

app.get(
  "/api/seasons/:seasonId/booking/cancellable",
  async (req) => {
    const { seasonId } = req.params as { seasonId: string };
    const q = z
      .object({
        startMondayDate: z.string().min(1),
      })
      .parse(req.query);
    return listAllCancellableBookings(db, config, seasonId, q.startMondayDate);
  },
);

app.get(
  "/api/seasons/:seasonId/booking/weeks/:week/cancellable",
  async (req) => {
    const { seasonId, week } = req.params as { seasonId: string; week: string };
    const q = z
      .object({
        startMondayDate: z.string().min(1),
      })
      .parse(req.query);
    return listCancellableBookingsForWeek(
      db,
      config,
      seasonId,
      q.startMondayDate,
      Number(week),
    );
  },
);

app.post("/api/seasons/:seasonId/booking/cancel-calendar", async (req) => {
  const { seasonId } = req.params as { seasonId: string };
  const body = z
    .object({
      startMondayDate: z.string().min(1),
      notifyUsers: z.boolean().optional().default(true),
      items: z
        .array(
          z.discriminatedUnion("kind", [
            z.object({
              kind: z.literal("bulk"),
              week: z.coerce.number().int().min(1),
              date: z.string().min(1),
              begin: z.string().min(1),
              end: z.string().min(1),
              courtSide: z.enum(["stadium", "center"]).optional(),
            }),
            z.object({
              kind: z.literal("match"),
              week: z.coerce.number().int().min(1),
              date: z.string().min(1),
              begin: z.string().min(1),
              end: z.string().min(1),
            }),
          ]),
        )
        .min(1),
    })
    .parse(req.body);
  return cancelBookingCalendarItems(db, config, { seasonId, ...body });
});

app.get("/api/seasons/:seasonId/booking/holds", async (req) => {
  const { seasonId } = req.params as { seasonId: string };
  return listBookingHolds(db, seasonId);
});

app.get(
  "/api/seasons/:seasonId/booking/season-holds",
  async (req) => {
    const { seasonId } = req.params as { seasonId: string };
    return listSeasonBookingHolds(db, seasonId);
  },
);

app.delete(
  "/api/seasons/:seasonId/booking/season-holds/:holdId",
  async (req) => {
    const { seasonId, holdId } = req.params as {
      seasonId: string;
      holdId: string;
    };
    return removeSeasonBookingHold(db, seasonId, holdId);
  },
);

app.get("/api/seasons/:seasonId/booking/runs", async (req) => {
  const { seasonId } = req.params as { seasonId: string };
  return listBookingRuns(db, seasonId, 30);
});

/* Phase 2 endpoints */
app.post("/api/phase2/booking-proposals", async (req) => {
  const schema = z.object({
    seasonId: z.string(),
    weekNumber: z.number(),
    payload: z.object({
      weekNumber: z.number(),
      assignments: z.array(
        z.object({
          boxNumber: z.number(),
          match: z.tuple([z.number(), z.number()]),
          court: z.number(),
          slotLabel: z.string(),
        }),
      ),
    }),
  });
  const body = schema.parse(req.body);
  const issues = validateProposalForReview(body.payload);
  const id = crypto.randomUUID();
  db.insert(bookingProposals)
    .values({
      id,
      seasonId: body.seasonId,
      weekNumber: body.weekNumber,
      status: issues.length ? "draft" : "draft",
      payloadJson: JSON.stringify({ ...body.payload, issues }),
    })
    .run();
  return { id, issues };
});

app.post("/api/phase2/booking-proposals/:id/execute", async (req) => {
  const { id } = req.params as { id: string };
  return executeBookingProposal(id);
});

app.post("/api/phase2/rating-adjustments", async (req) => {
  const schema = z.array(
    z.object({
      playerId: z.string(),
      suggestedDelta: z.number(),
      reason: z.string(),
    }),
  );
  const body = schema.parse(req.body);
  return applyRatingAdjustments(body);
});

let schedulerTimer: NodeJS.Timeout | null = null;
async function startAutomationWorkers() {
  try {
    await imapPoller.start();
  } catch (err) {
    console.warn("[automation] imap poller failed to start:", err);
  }
  schedulerTimer = setInterval(() => {
    if (isSettingOn(db, "automation.scheduler_paused")) return;
    void runSchedulerTick(db, config, emailAdapter, { kind: "cron" }).catch(
      (err) => {
        console.warn("[automation] scheduler tick failed:", err);
      },
    );
  }, config.AUTOMATION_TICK_INTERVAL_MS);
}

app.addHook("onClose", async () => {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  await imapPoller.stop();
});

await app.listen({ port: config.PORT, host: "0.0.0.0" });
await startAutomationWorkers();
console.log(`API listening on http://localhost:${config.PORT}`);
