import "./load-env.js";
import cors from "@fastify/cors";
import Fastify, { type FastifyReply } from "fastify";
import { and, eq, desc, asc, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assignManagedCourts,
  bookingCalendarClubYearSegmentForMondayISO,
  BOOKING_CALENDAR_SEASONS,
  EMAIL_TEMPLATE_SCOPES,
  getWeekMatchups,
  interpolateEmailTemplate,
  isBookingCalendarSegmentLocallyActive,
  isUsSquashBoxLeagueRosterLocallyEditable,
  suggestDraw,
  type PlayerSeed,
  type BookingCalendarSeason,
  rankBoxStandings,
  playoffSemis,
  topFourForPlayoffs,
  parseRelativeRankOverridesJson,
  pruneRelativeRankOverrides,
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
  runRebookPlayDay,
  runStadiumIdMapTestBooking,
  runBookSlotBothCourtsNoBulkCancel,
  cancelBookingCalendarItems,
  markWeekBookingDisplayLocal,
  markSlotBookingDisplayLocal,
} from "./booking/service.js";
import {
  createUssquashClient,
  normalizeJsonArray,
  pingClubLockerAuth,
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
import {
  isSettingOn,
  seedAutomationSettings,
  shouldAutoSendForCurrentMode,
} from "./automation/settings.js";
import {
  getHouseLeagueEmailReminderSettings,
  patchHouseLeagueEmailReminderSettings,
  seedHouseLeagueEmailReminderSettings,
} from "./houseLeague/emailReminderSettings.js";
import { queueHouseLeagueReminderTestSend } from "./houseLeague/reminderTestSend.js";
import {
  buildHouseLeagueBoxEmlBundle,
  buildHouseLeagueBoxEmlZipBuffer,
} from "./houseLeague/boxEmlFiles.js";
import {
  getHouseLeagueBoxEmlTemplateSettings,
  patchHouseLeagueBoxEmlTemplateSettings,
  seedAllHouseLeagueBoxEmlTemplateSettings,
} from "./houseLeague/boxEmlTemplateSettings.js";
import {
  boxEmlAssetPublicUrl,
  createBoxEmlTemplateAssetFromDataUrl,
  getBoxEmlTemplateAsset,
} from "./houseLeague/boxEmlAssets.js";
import {
  buildWeeklyBoxEmailBundle,
  buildWeeklyBoxEmlZipBuffer,
  resolveWeeklyTargetWeek,
  stageWeeklyBoxEmails,
  weeklyEmlFileForItem,
} from "./houseLeague/weeklyBoxEmail.js";
import {
  applyHouseLeagueRosterBookingUpdates,
  applyHouseLeagueRosterCourtSlot,
  applyHouseLeagueRosterEmailUpdates,
  computeHouseLeagueRosterImpact,
} from "./houseLeague/rosterImpact.js";
import {
  computeSeasonStartRosterDiff,
  parseSeasonStartRosterPlayers,
  seedSeasonStartRosterFromLive,
} from "./houseLeague/seasonStartRoster.js";
import {
  loadRelativeRankOverridesForSeason,
  saveRelativeRankOverridesForSeason,
  sanitizeRelativeRankOverridesForLiveSeason,
} from "./houseLeague/relativeRankOverrides.js";
import { normalizeLiveBoxLeaguePlayers } from "./booking/liveWeekPlan.js";
import {
  getHouseLeagueWeeklyBoxEmailSettings,
  patchHouseLeagueWeeklyBoxEmailSettings,
  seedHouseLeagueWeeklyBoxEmailSettings,
} from "./houseLeague/weeklyBoxEmailTemplateSettings.js";
import {
  listInboundForArea,
  listOutboundForArea,
} from "./emails/listForUi.js";

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
seedAllHouseLeagueBoxEmlTemplateSettings(db);
seedHouseLeagueWeeklyBoxEmailSettings(db);
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
  const kind = row.closureKind === "event" ? "event" : "holiday";
  return {
    id: row.id,
    name: row.name,
    date: row.date,
    kind,
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

const statutoryHolidayClosureKindZ = z.enum(["holiday", "event"]);

const statutoryHolidayPostBody = z
  .object({
    name: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    open: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
    close: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
    closed: z.boolean(),
    kind: statutoryHolidayClosureKindZ.optional().default("holiday"),
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
      error: "Another closure is already stored on that date.",
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
      closureKind: body.kind,
    })
    .run();
  const row = db.select().from(statutoryHolidays).where(eq(statutoryHolidays.id, id)).get();
  return row ? statutoryHolidayRowToJson(row) : null;
});

const statutoryHolidayPatchBody = z.object({
  kind: statutoryHolidayClosureKindZ,
});

app.patch("/api/statutory-holidays/:id", async (req, reply) => {
  const { id: paramId } = req.params as { id: string };
  const idParsed = z.string().uuid().safeParse(paramId);
  if (!idParsed.success) {
    return reply.code(400).send({ error: "Invalid id" });
  }
  const body = statutoryHolidayPatchBody.parse(req.body);
  const res = db
    .update(statutoryHolidays)
    .set({ closureKind: body.kind })
    .where(eq(statutoryHolidays.id, idParsed.data))
    .run();
  if (res.changes === 0) {
    return reply.code(404).send({ error: "Not found" });
  }
  const row = db
    .select()
    .from(statutoryHolidays)
    .where(eq(statutoryHolidays.id, idParsed.data))
    .get();
  return row ? statutoryHolidayRowToJson(row) : null;
});

app.put("/api/statutory-holidays/:id", async (req, reply) => {
  const { id: paramId } = req.params as { id: string };
  const idParsed = z.string().uuid().safeParse(paramId);
  if (!idParsed.success) {
    return reply.code(400).send({ error: "Invalid id" });
  }
  const body = statutoryHolidayPostBody.parse(req.body);
  const clash = db
    .select({ id: statutoryHolidays.id })
    .from(statutoryHolidays)
    .where(eq(statutoryHolidays.date, body.date))
    .get();
  if (clash && clash.id !== idParsed.data) {
    return reply.code(409).send({
      error: "Another closure is already stored on that date.",
    });
  }
  const res = db
    .update(statutoryHolidays)
    .set({
      name: body.name.trim(),
      date: body.date,
      openTime: body.closed ? null : body.open,
      closeTime: body.closed ? null : body.close,
      closed: body.closed ? 1 : 0,
      closureKind: body.kind,
    })
    .where(eq(statutoryHolidays.id, idParsed.data))
    .run();
  if (res.changes === 0) {
    return reply.code(404).send({ error: "Not found" });
  }
  const row = db
    .select()
    .from(statutoryHolidays)
    .where(eq(statutoryHolidays.id, idParsed.data))
    .get();
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

/** Minimal Club Locker credential probe for the web UI (no upstream payload returned). */
app.get("/api/club-locker-health", async (_req, reply) => {
  const result = await pingClubLockerAuth(config);
  if (result.ok) {
    return { ok: true as const };
  }
  const message =
    result.reason === "missing_token"
      ? "US_SQUASH_BEARER_TOKEN is not configured on the server."
      : result.reason === "unauthorized"
        ? "Club Locker rejected the bearer token — update US_SQUASH_BEARER_TOKEN (and US_SQUASH_SESSION_COOKIE if required) in the server environment."
        : "Could not reach Club Locker with the current credentials.";
  const code = result.reason === "missing_token" ? 503 : 502;
  return reply.code(code).send({ ok: false as const, message });
});

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

function houseLeagueMutationSeasonIdFromQuery(query: unknown): string | null {
  if (!query || typeof query !== "object") return null;
  const raw = (query as Record<string, unknown>).seasonId;
  if (typeof raw !== "string") return null;
  const id = z.string().uuid().safeParse(raw);
  return id.success ? id.data : null;
}

function bookingSeasonRowAllowsLiveHouseLeagueRosterWrites(
  row: typeof seasons.$inferSelect,
): boolean {
  const seg = row.calendarSegment;
  const cy = row.clubYear;
  if (
    seg == null ||
    cy == null ||
    !(BOOKING_CALENDAR_SEASONS as readonly string[]).includes(seg)
  ) {
    return false;
  }
  return isBookingCalendarSegmentLocallyActive({
    segment: seg as BookingCalendarSeason,
    clubYear: cy,
    explicitSeasonEndDate: row.endDate,
  });
}

/**
 * Resolved from US Squash box league metadata when possible; avoids treating the league read-only
 * just because booking-segment Mondays differ from the advertised house league calendar.
 */
async function usSquashHouseLeagueEventRosterGate(
  eventNum: number,
): Promise<"open" | "closed" | "unknown"> {
  try {
    const client = createUssquashClient(config);
    const { status, data } = await client.listBoxLeaguesForClub(
      config.US_SQUASH_CLUB_ID,
    );
    if (status < 200 || status >= 300) return "unknown";
    const rows = normalizeJsonArray(data);
    const match = rows.find((raw) => {
      const r = raw as Record<string, unknown>;
      const id = Number(r.eventId);
      return Number.isFinite(id) && id === eventNum;
    }) as Record<string, unknown> | undefined;
    const endISO = match?.endDate;
    if (typeof endISO !== "string" || endISO.trim() === "") return "unknown";
    const startISO =
      typeof match?.startDate === "string" ? match.startDate : undefined;
    return isUsSquashBoxLeagueRosterLocallyEditable({
      eventEndISO: endISO,
      eventStartISO: startISO,
      enforceStart: false,
    })
      ? "open"
      : "closed";
  } catch {
    return "unknown";
  }
}

async function rosterWritableForBookingSeasonHouseLeagueMutation(
  row: typeof seasons.$inferSelect,
  eventNum: number,
): Promise<boolean> {
  if (
    row.houseLeagueEventId != null &&
    row.houseLeagueEventId !== eventNum
  ) {
    return false;
  }
  const gate = await usSquashHouseLeagueEventRosterGate(eventNum);
  if (gate === "open") return true;
  if (gate === "closed") return false;
  return bookingSeasonRowAllowsLiveHouseLeagueRosterWrites(row);
}

/** Returns true when the request should stop (error already sent). */
async function blockUnlessBookingSeasonAllowsHouseLeagueRosterWrites(
  reply: FastifyReply,
  query: unknown,
  eventNum: number,
): Promise<boolean> {
  const seasonIdStr = houseLeagueMutationSeasonIdFromQuery(query);
  if (!seasonIdStr) {
    void reply.code(400).send({ error: "season_id_required" });
    return true;
  }
  const row = db.select().from(seasons).where(eq(seasons.id, seasonIdStr)).get();
  if (!row) {
    void reply.code(404).send({ error: "season_not_found" });
    return true;
  }
  if (
    row.houseLeagueEventId != null &&
    row.houseLeagueEventId !== eventNum
  ) {
    void reply.code(400).send({ error: "season_event_mismatch" });
    return true;
  }
  const ok = await rosterWritableForBookingSeasonHouseLeagueMutation(row, eventNum);
  if (!ok) {
    void reply.code(403).send({ error: "house_league_roster_not_editable" });
    return true;
  }
  return false;
}

/** Returns true when the request should stop (error already sent). */
async function blockUnlessSeasonHouseLeagueRosterWritable(
  reply: FastifyReply,
  seasonId: string,
): Promise<boolean> {
  const row = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
  if (!row) {
    void reply.code(404).send({ error: "season_not_found" });
    return true;
  }
  const eventId = row.houseLeagueEventId;
  if (eventId == null || eventId <= 0) {
    void reply.code(400).send({ error: "house_league_event_not_linked" });
    return true;
  }
  const ok = await rosterWritableForBookingSeasonHouseLeagueMutation(row, eventId);
  if (!ok) {
    void reply.code(403).send({ error: "house_league_roster_not_editable" });
    return true;
  }
  return false;
}

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
    if (
      await blockUnlessBookingSeasonAllowsHouseLeagueRosterWrites(
        reply,
        req.query,
        eventNum,
      )
    ) {
      return;
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

const houseleagueAddRegisteredPlayerBody = z.object({
  level: z.number().int().min(0),
  playerId: z.number().int().positive(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  rating: z.number().finite().optional(),
});

app.post("/api/houseleague/events/:eventId/players", async (req, reply) => {
  try {
    const { eventId } = req.params as { eventId: string };
    const eventNum = Number(eventId);
    if (!Number.isFinite(eventNum) || eventNum <= 0) {
      return reply.code(400).send({ error: "invalid_event_id" });
    }
    if (
      await blockUnlessBookingSeasonAllowsHouseLeagueRosterWrites(
        reply,
        req.query,
        eventNum,
      )
    ) {
      return;
    }
    const body = houseleagueAddRegisteredPlayerBody.parse(req.body);
    const client = createUssquashClient(config);
    const { status, data } = await client.addBoxLeaguePlayer(eventNum, {
      level: body.level,
      id: body.playerId,
      firstName: body.firstName,
      lastName: body.lastName,
      rating: body.rating,
    });
    if (status < 200 || status >= 300) {
      return reply.code(status).send(data);
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({
        error: "invalid_body",
        detail: err.flatten(),
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: message });
  }
});

app.delete("/api/houseleague/events/:eventId/players/:playerId", async (req, reply) => {
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
    if (
      await blockUnlessBookingSeasonAllowsHouseLeagueRosterWrites(
        reply,
        req.query,
        eventNum,
      )
    ) {
      return;
    }
    const client = createUssquashClient(config);
    const { status, data } = await client.deleteBoxLeaguePlayer(
      eventNum,
      playerNum,
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

const patchHouseLeagueEventBody = z.object({
  houseLeagueEventId: z.union([z.number().int().positive(), z.null()]),
});

app.patch(
  "/api/seasons/:seasonId/house-league-event",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const body = patchHouseLeagueEventBody.parse(req.body ?? {});
    const row = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
    if (!row) return reply.code(404).send({ error: "season_not_found" });
    db.update(seasons)
      .set({ houseLeagueEventId: body.houseLeagueEventId })
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

/** Placeholder season creation: clones US Squash box-league registrations into local `draft`. Wire upstream Club Locker/US Squash “copy league” curl here when ready. */
const createSeasonFromPreviousBody = z.object({
  sourceSeasonId: z.string(),
  /** Event whose roster should seed the upcoming season (normally the league you wrap up). */
  sourceHouseLeagueEventId: z.string(),
  name: z.string().min(1),
  startMondayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

app.post("/api/seasons/create-from-previous", async (req, reply) => {
  const body = createSeasonFromPreviousBody.parse(req.body ?? {});
  const src = db
    .select()
    .from(seasons)
    .where(eq(seasons.id, body.sourceSeasonId))
    .get();
  if (!src)
    return reply.code(404).send({ error: "source_season_not_found" });

  const derived =
    bookingCalendarClubYearSegmentForMondayISO(body.startMondayDate);
  if (!derived) {
    return reply.code(400).send({ error: "invalid_start_monday_date" });
  }

  const eventNum = Number(body.sourceHouseLeagueEventId);
  if (!Number.isFinite(eventNum) || eventNum <= 0) {
    return reply.code(400).send({ error: "invalid_source_house_league_event" });
  }

  let roster: unknown[] = [];
  let copyWarning: string | undefined;

  try {
    const client = createUssquashClient(config);
    const { status, data } = await client.listBoxLeaguePlayers(eventNum);
    if (status < 200 || status >= 300) {
      copyWarning = `USSquash roster copy failed (${status}); draft season created empty.`;
      roster = [];
    } else {
      roster = normalizeJsonArray(data).map((row) => ({
        ...(row as Record<string, unknown>),
        pointsSeason: 0,
        winsSeason: 0,
        lossesSeason: 0,
      }));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    copyWarning = `Roster fetch error (${msg}); draft season created empty.`;
    roster = [];
  }

  const id = crypto.randomUUID();
  db.insert(seasons)
    .values({
      id,
      name: body.name,
      clubYear: derived.clubYear,
      calendarSegment: derived.segment,
      startMondayDate: body.startMondayDate,
      status: "draft",
      houseLeagueEventId: eventNum,
      draftHouseLeaguePlayersJson:
        roster.length > 0 ? JSON.stringify(roster) : undefined,
    })
    .run();

  const created = db.select().from(seasons).where(eq(seasons.id, id)).get();
  if (!created) {
    return reply.code(500).send({ error: "season_insert_failed" });
  }

  return reply.send({
    ok: true,
    placeholder: true,
    seasonId: id,
    message:
      "This endpoint is provisional. Replace internals with upstream Club Locker / US Squash “copy league to new season” when that integration is ready.",
    sourceSeasonId: body.sourceSeasonId,
    sourceHouseLeagueEventId: body.sourceHouseLeagueEventId,
    rosterCount: roster.length,
    ...(copyWarning ? { warning: copyWarning } : {}),
    season: created,
  });
});

const draftHouseLeagueRosterPutBody = z.object({
  players: z.array(z.record(z.unknown())),
});

app.get(
  "/api/seasons/:seasonId/draft-house-league-roster",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const row = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
    if (!row) return reply.code(404).send({ error: "season_not_found" });
    if (row.status !== "draft") {
      return reply
        .code(400)
        .send({ error: "season_not_a_draft", status: row.status });
    }
    const raw = row.draftHouseLeaguePlayersJson;
    if (!raw) return { players: [] };
    try {
      const parsed = JSON.parse(raw) as unknown;
      const players = Array.isArray(parsed) ? parsed : [];
      return { players };
    } catch {
      return { players: [] };
    }
  },
);

app.put(
  "/api/seasons/:seasonId/draft-house-league-roster",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const body = draftHouseLeagueRosterPutBody.parse(req.body ?? {});
    const row = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
    if (!row) return reply.code(404).send({ error: "season_not_found" });
    if (row.status !== "draft") {
      return reply
        .code(400)
        .send({ error: "season_not_a_draft", status: row.status });
    }
    db.update(seasons)
      .set({
        draftHouseLeaguePlayersJson: JSON.stringify(body.players),
      })
      .where(eq(seasons.id, seasonId))
      .run();
    return { ok: true };
  },
);

const seasonStartRosterPutBody = z.object({
  players: z.array(z.record(z.unknown())),
});

app.get(
  "/api/seasons/:seasonId/season-start-roster",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const row = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
    if (!row) return reply.code(404).send({ error: "season_not_found" });
    const players = parseSeasonStartRosterPlayers(row.seasonStartRosterJson);
    return {
      players,
      savedAt: row.seasonStartRosterSavedAt ?? null,
    };
  },
);

app.put(
  "/api/seasons/:seasonId/season-start-roster",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const body = seasonStartRosterPutBody.parse(req.body ?? {});
    const row = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
    if (!row) return reply.code(404).send({ error: "season_not_found" });
    const savedAt = new Date().toISOString();
    db.update(seasons)
      .set({
        seasonStartRosterJson: JSON.stringify(body.players),
        seasonStartRosterSavedAt: savedAt,
      })
      .where(eq(seasons.id, seasonId))
      .run();
    return { ok: true, savedAt };
  },
);

app.post(
  "/api/seasons/:seasonId/season-start-roster/seed-from-live",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const client = createUssquashClient(config);
    const result = await seedSeasonStartRosterFromLive(db, config, seasonId, client);
    if ("error" in result) {
      return reply.code(400).send({ error: result.error });
    }
    return result;
  },
);

app.get(
  "/api/seasons/:seasonId/season-start-roster/diff",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const client = createUssquashClient(config);
    const result = await computeSeasonStartRosterDiff(db, config, seasonId, client);
    if ("error" in result) {
      return reply.code(400).send({ error: result.error });
    }
    return result;
  },
);

const relativeRankOverridesPutBody = z.object({
  overrides: z.record(z.string(), z.number().int().min(1).max(6)),
});

app.get(
  "/api/seasons/:seasonId/house-league/relative-rank-overrides",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const row = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
    if (!row) return reply.code(404).send({ error: "season_not_found" });
    let overrides = loadRelativeRankOverridesForSeason(db, seasonId);
    const eventId = row.houseLeagueEventId;
    if (eventId != null && eventId > 0) {
      const client = createUssquashClient(config);
      const { status, data } = await client.listBoxLeaguePlayers(eventId);
      if (status >= 200 && status < 300) {
        const roster = normalizeLiveBoxLeaguePlayers(data);
        overrides = sanitizeRelativeRankOverridesForLiveSeason(
          db,
          seasonId,
          roster,
          overrides,
        );
      }
    }
    return {
      overrides: Object.fromEntries(
        [...overrides.entries()].map(([id, rr]) => [String(id), rr]),
      ),
    };
  },
);

app.put(
  "/api/seasons/:seasonId/house-league/relative-rank-overrides",
  async (req, reply) => {
    try {
      const { seasonId } = req.params as { seasonId: string };
      const row = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
      if (!row) return reply.code(404).send({ error: "season_not_found" });

      const eventId = row.houseLeagueEventId;
      if (
        eventId != null &&
        eventId > 0 &&
        row.status !== "draft" &&
        (await blockUnlessBookingSeasonAllowsHouseLeagueRosterWrites(
          reply,
          req.query,
          eventId,
        ))
      ) {
        return;
      }

      const body = relativeRankOverridesPutBody.parse(req.body ?? {});
      let overrides = parseRelativeRankOverridesJson(
        JSON.stringify(body.overrides),
      );

      if (eventId != null && eventId > 0) {
        const client = createUssquashClient(config);
        const { status, data } = await client.listBoxLeaguePlayers(eventId);
        if (status >= 200 && status < 300) {
          const roster = normalizeLiveBoxLeaguePlayers(data);
          overrides = sanitizeRelativeRankOverridesForLiveSeason(
            db,
            seasonId,
            roster,
            overrides,
          );
        }
      }

      saveRelativeRankOverridesForSeason(db, seasonId, overrides);
      return {
        ok: true,
        overrides: Object.fromEntries(
          [...overrides.entries()].map(([id, rr]) => [String(id), rr]),
        ),
      };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({
          error: "invalid_body",
          detail: err.flatten(),
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  },
);

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

app.get("/api/seasons/:seasonId/house-league/box-eml", async (req, reply) => {
  const { seasonId } = req.params as { seasonId: string };
  const q = z
    .object({
      boxNumber: z.coerce.number().int().positive().optional(),
      purpose: boxEmlTemplatePurposeSchema,
    })
    .parse(req.query ?? {});
  const bundle = await buildHouseLeagueBoxEmlBundle(
    db,
    config,
    seasonId,
    undefined,
    undefined,
    q.purpose,
  );
  if ("error" in bundle) {
    return reply.code(400).send({ error: bundle.error });
  }
  if (q.boxNumber != null) {
    const box = bundle.boxes.find((b) => b.boxNumber === q.boxNumber);
    if (!box) {
      return reply.code(404).send({ error: "box_not_found" });
    }
    return {
      seasonName: bundle.seasonName,
      seasonStartDateLabel: bundle.seasonStartDateLabel,
      warnings: bundle.warnings,
      box,
    };
  }
  return bundle;
});

app.get("/api/seasons/:seasonId/house-league/box-eml.zip", async (req, reply) => {
  const { seasonId } = req.params as { seasonId: string };
  const q = z
    .object({ purpose: boxEmlTemplatePurposeSchema })
    .parse(req.query ?? {});
  const result = await buildHouseLeagueBoxEmlZipBuffer(
    db,
    config,
    seasonId,
    undefined,
    q.purpose,
  );
  if ("error" in result) {
    return reply.code(400).send({ error: result.error });
  }
  return reply
    .header("Content-Type", "application/zip")
    .header(
      "Content-Disposition",
      `attachment; filename="${result.filename.replace(/"/g, "")}"`,
    )
    .send(result.buffer);
});

const boxEmlTemplatePairBody = z.object({
  bodyTemplate: z.string().optional(),
  subjectTemplate: z.string().optional(),
});

const boxEmlTemplatePurposeSchema = z
  .enum(["season_start", "box_modification"])
  .default("season_start");

const BOX_EML_LARGE_BODY_LIMIT = 25 * 1024 * 1024;

app.post(
  "/api/house-league/box-eml-assets",
  { bodyLimit: BOX_EML_LARGE_BODY_LIMIT },
  async (req, reply) => {
    const body = z
      .object({
        dataUrl: z.string().min(1),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
      })
      .parse(req.body ?? {});
    try {
      const asset = createBoxEmlTemplateAssetFromDataUrl(
        db,
        body.dataUrl,
        body.width,
        body.height,
      );
      return { id: asset.id, url: boxEmlAssetPublicUrl(asset.id) };
    } catch (e) {
      if (e instanceof Error && e.message === "invalid_image_data_url") {
        return reply.code(400).send({ error: "invalid_image_data_url" });
      }
      throw e;
    }
  },
);

app.get("/api/house-league/box-eml-assets/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const asset = getBoxEmlTemplateAsset(db, id);
  if (!asset) {
    return reply.code(404).send({ error: "asset_not_found" });
  }
  const buffer = Buffer.from(asset.dataBase64, "base64");
  return reply
    .header("Content-Type", asset.mimeType)
    .header("Cache-Control", "private, max-age=31536000")
    .send(buffer);
});

app.post(
  "/api/seasons/:seasonId/house-league/box-eml.zip",
  { bodyLimit: BOX_EML_LARGE_BODY_LIMIT },
  async (req, reply) => {
  const { seasonId } = req.params as { seasonId: string };
  const body = z
    .object({
      purpose: boxEmlTemplatePurposeSchema,
      managed: boxEmlTemplatePairBody.optional(),
      unmanaged: boxEmlTemplatePairBody.optional(),
      bodyTemplate: z.string().optional(),
      subjectTemplate: z.string().optional(),
    })
    .parse(req.body ?? {});
  const templateOverride =
    body.managed || body.unmanaged
      ? { managed: body.managed, unmanaged: body.unmanaged }
      : body.bodyTemplate || body.subjectTemplate
        ? {
            managed: {
              bodyTemplate: body.bodyTemplate,
              subjectTemplate: body.subjectTemplate,
            },
            unmanaged: {
              bodyTemplate: body.bodyTemplate,
              subjectTemplate: body.subjectTemplate,
            },
          }
        : undefined;
  const result = await buildHouseLeagueBoxEmlZipBuffer(
    db,
    config,
    seasonId,
    templateOverride,
    body.purpose,
  );
  if ("error" in result) {
    return reply.code(400).send({ error: result.error });
  }
  return reply
    .header("Content-Type", "application/zip")
    .header(
      "Content-Disposition",
      `attachment; filename="${result.filename.replace(/"/g, "")}"`,
    )
    .send(result.buffer);
});

app.get("/api/house-league/box-eml-template", async (req) => {
  const q = z
    .object({ purpose: boxEmlTemplatePurposeSchema })
    .parse(req.query ?? {});
  return getHouseLeagueBoxEmlTemplateSettings(db, q.purpose);
});

app.patch(
  "/api/house-league/box-eml-template",
  { bodyLimit: BOX_EML_LARGE_BODY_LIMIT },
  async (req, reply) => {
  const q = z
    .object({ purpose: boxEmlTemplatePurposeSchema })
    .parse(req.query ?? {});
  const body = z
    .object({
      managed: boxEmlTemplatePairBody.optional(),
      unmanaged: boxEmlTemplatePairBody.optional(),
      bodyTemplate: z.string().optional(),
      subjectTemplate: z.string().optional(),
    })
    .parse(req.body ?? {});
  const patch =
    body.managed || body.unmanaged
      ? { managed: body.managed, unmanaged: body.unmanaged }
      : body.bodyTemplate !== undefined || body.subjectTemplate !== undefined
        ? {
            managed: {
              bodyTemplate: body.bodyTemplate,
              subjectTemplate: body.subjectTemplate,
            },
          }
        : {};
  try {
    return patchHouseLeagueBoxEmlTemplateSettings(db, patch, q.purpose);
  } catch (e) {
    if (e instanceof Error && e.message === "body_template_required") {
      return reply.code(400).send({ error: "body_template_required" });
    }
    if (e instanceof Error && e.message === "subject_template_required") {
      return reply.code(400).send({ error: "subject_template_required" });
    }
    throw e;
  }
});

/* Email outbox */
app.get("/api/email-outbox", async (req) => {
  const q = z
    .object({
      limit: z.coerce.number().int().min(1).max(500).optional(),
      area: z.enum(["house_league", "championships"]).optional(),
      seasonId: z.string().optional(),
    })
    .parse(req.query ?? {});
  const limit = q.limit ?? 100;
  if (!q.area) {
    return db
      .select()
      .from(emailOutbox)
      .orderBy(desc(emailOutbox.createdAt))
      .limit(limit)
      .all();
  }
  return listOutboundForArea(db, q.area, {
    seasonId: q.seasonId,
    limit,
  });
});

app.get("/api/email-inbox", async (req) => {
  const q = z
    .object({
      limit: z.coerce.number().int().min(1).max(500).optional(),
      area: z.enum(["house_league", "championships"]),
    })
    .parse(req.query ?? {});
  return listInboundForArea(db, q.area, { limit: q.limit ?? 100 });
});

/** @deprecated Use POST .../house-league/weekly-box-email/send */
app.post("/api/seasons/:seasonId/weeks/:week/email-self-managed", async (req, reply) => {
  const { seasonId, week } = req.params as { seasonId: string; week: string };
  const w = Number(week);
  if (!Number.isFinite(w) || w < 1) {
    return reply.code(400).send({ error: "invalid_week" });
  }
  const body = z
    .object({
      force: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      boxNumber: z.number().int().positive().optional(),
    })
    .parse(req.body ?? {});
  const autoSend = shouldAutoSendForCurrentMode(db);
  const out = await stageWeeklyBoxEmails(db, config, emailAdapter, {
    seasonId,
    weekNumber: w,
    autoSend,
    mode: "normal",
    force: body.force,
    dryRun: body.dryRun,
    boxNumbers: body.boxNumber != null ? [body.boxNumber] : undefined,
  });
  return {
    ok: true,
    weekNumber: w,
    staged: out.staged,
    sent: out.sent,
    skipped: out.skipped,
    warnings: out.warnings,
  };
});

const weeklyTemplatePairPatch = z.object({
  bodyTemplate: z.string().optional(),
  subjectTemplate: z.string().optional(),
});

const patchWeeklyBoxEmailSettingsBody = z.object({
  enabled: z.boolean().optional(),
  seasonId: z.string().nullable().optional(),
  recipientMode: z.enum(["per_box", "per_matchup"]).optional(),
  fromEmail: z.string().min(1).email().optional(),
  fromName: z.string().optional(),
  alternateFromEmails: z.array(z.string().email()).optional(),
  /** @deprecated Use alternateFromEmails */
  extraToEmails: z.array(z.string().email()).optional(),
  templates: z
    .object({
      perBox: z
        .object({
          managed: weeklyTemplatePairPatch.optional(),
          unmanaged: weeklyTemplatePairPatch.optional(),
        })
        .optional(),
      perMatchup: z
        .object({
          managed: weeklyTemplatePairPatch.optional(),
          unmanaged: weeklyTemplatePairPatch.optional(),
        })
        .optional(),
      managed: weeklyTemplatePairPatch.optional(),
      unmanaged: weeklyTemplatePairPatch.optional(),
    })
    .optional(),
});

app.get("/api/house-league/weekly-box-email-settings", async () =>
  getHouseLeagueWeeklyBoxEmailSettings(db, config),
);

app.patch("/api/house-league/weekly-box-email-settings", async (req, reply) => {
  const body = patchWeeklyBoxEmailSettingsBody.parse(req.body ?? {});
  try {
    return patchHouseLeagueWeeklyBoxEmailSettings(db, config, body);
  } catch (e) {
    if (e instanceof Error && e.message === "body_template_required") {
      return reply.code(400).send({ error: "body_template_required" });
    }
    if (e instanceof Error && e.message === "subject_template_required") {
      return reply.code(400).send({ error: "subject_template_required" });
    }
    throw e;
  }
});

app.get("/api/seasons/:seasonId/house-league/roster-impact", async (req, reply) => {
  const { seasonId } = req.params as { seasonId: string };
  if (await blockUnlessSeasonHouseLeagueRosterWritable(reply, seasonId)) {
    return;
  }
  const q = z
    .object({
      weekFilter: z
        .enum(["current_and_future", "all_converted"])
        .optional(),
      weeks: z.string().optional(),
      asOfDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .parse(req.query ?? {});
  let weekFilter:
    | "current_and_future"
    | "all_converted"
    | { weekNumbers: number[] } = q.weekFilter ?? "current_and_future";
  if (q.weeks?.trim()) {
    const nums = q.weeks
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 1);
    if (nums.length > 0) weekFilter = { weekNumbers: nums };
  }
  const result = await computeHouseLeagueRosterImpact(db, config, seasonId, {
    weekFilter,
    asOfDate: q.asOfDate,
  });
  if ("error" in result) {
    return reply.code(400).send({ error: result.error });
  }
  return result;
});

app.post(
  "/api/seasons/:seasonId/house-league/roster-impact/apply-bookings",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    if (await blockUnlessSeasonHouseLeagueRosterWritable(reply, seasonId)) {
      return;
    }
    const body = z
      .object({
        weekNumbers: z.array(z.number().int().positive()).min(1),
        confirm: z.literal(true),
        notifyOnDelete: z.boolean().optional(),
        dryRun: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const out = await applyHouseLeagueRosterBookingUpdates(db, config, {
      seasonId,
      weekNumbers: body.weekNumbers,
      confirm: body.confirm,
      notifyOnDelete: body.notifyOnDelete,
      dryRun: body.dryRun,
    });
    return out;
  },
);

app.post(
  "/api/seasons/:seasonId/house-league/roster-impact/apply-court-slot",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    if (await blockUnlessSeasonHouseLeagueRosterWritable(reply, seasonId)) {
      return;
    }
    const body = z
      .object({
        weekNumber: z.number().int().positive(),
        playDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        slot: z.string().min(1),
        courtId: z.number().int().positive(),
        boxNumber: z.number().int().positive(),
        confirm: z.literal(true),
        notifyOnDelete: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const out = await applyHouseLeagueRosterCourtSlot(db, config, {
      seasonId,
      weekNumber: body.weekNumber,
      playDate: body.playDate,
      slot: body.slot,
      courtId: body.courtId,
      boxNumber: body.boxNumber,
      confirm: body.confirm,
      notifyOnDelete: body.notifyOnDelete,
    });
    return out;
  },
);

app.post(
  "/api/seasons/:seasonId/house-league/roster-impact/apply-emails",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    if (await blockUnlessSeasonHouseLeagueRosterWritable(reply, seasonId)) {
      return;
    }
    const body = z
      .object({
        weekly: z
          .array(
            z.object({
              weekNumber: z.number().int().positive(),
              boxNumbers: z.array(z.number().int().positive()).optional(),
            }),
          )
          .min(1),
        confirm: z.literal(true),
        dryRun: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const autoSend = shouldAutoSendForCurrentMode(db);
    const out = await applyHouseLeagueRosterEmailUpdates(
      db,
      config,
      emailAdapter,
      {
        seasonId,
        weekly: body.weekly,
        confirm: body.confirm,
        dryRun: body.dryRun,
      },
      autoSend,
    );
    return out;
  },
);

app.get("/api/seasons/:seasonId/house-league/weekly-box-email", async (req, reply) => {
  const { seasonId } = req.params as { seasonId: string };
  const q = z
    .object({
      week: z.coerce.number().int().positive().optional(),
    })
    .parse(req.query ?? {});
  const season = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
  if (!season) return reply.code(404).send({ error: "season_not_found" });
  const startMonday = season.startMondayDate?.trim() ?? "";
  let weekNumber = q.week;
  if (weekNumber == null) {
    if (!startMonday) {
      return reply.code(400).send({ error: "season_start_monday_required" });
    }
    const target = resolveWeeklyTargetWeek(db, startMonday);
    if (!target) {
      return reply.code(400).send({ error: "no_target_week" });
    }
    weekNumber = target.weekNumber;
  }
  const bundle = await buildWeeklyBoxEmailBundle(db, config, seasonId, weekNumber);
  if ("error" in bundle) {
    return reply.code(400).send({ error: bundle.error });
  }
  return bundle;
});

function resolveWeeklyZipWeekNumber(
  seasonId: string,
  week: number | undefined,
): number | { error: string; status: number } {
  if (week != null) return week;
  const season = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
  if (!season) return { error: "season_not_found", status: 404 };
  const startMonday = season.startMondayDate?.trim() ?? "";
  if (!startMonday) {
    return { error: "season_start_monday_required", status: 400 };
  }
  const target = resolveWeeklyTargetWeek(db, startMonday);
  if (!target) {
    return { error: "no_target_week", status: 400 };
  }
  return target.weekNumber;
}

app.get(
  "/api/seasons/:seasonId/house-league/weekly-box-email.zip",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const q = z
      .object({
        week: z.coerce.number().int().positive().optional(),
        fromEmail: z.string().min(1).email().optional(),
        fromName: z.string().optional(),
      })
      .parse(req.query ?? {});
    const season = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
    if (!season) return reply.code(404).send({ error: "season_not_found" });
    const weekResolved = resolveWeeklyZipWeekNumber(seasonId, q.week);
    if (typeof weekResolved !== "number") {
      return reply.code(weekResolved.status).send({ error: weekResolved.error });
    }
    const delivery = getHouseLeagueWeeklyBoxEmailSettings(db, config);
    const result = await buildWeeklyBoxEmlZipBuffer(
      db,
      config,
      seasonId,
      weekResolved,
      {
        fromEmail: q.fromEmail?.trim() || delivery.fromEmail,
        fromName: q.fromName !== undefined ? q.fromName : delivery.fromName,
      },
    );
    if ("error" in result) {
      return reply.code(400).send({ error: result.error });
    }
    return reply
      .header("Content-Type", "application/zip")
      .header(
        "Content-Disposition",
        `attachment; filename="${result.filename.replace(/"/g, "")}"`,
      )
      .send(result.buffer);
  },
);

app.post(
  "/api/seasons/:seasonId/house-league/weekly-box-email.zip",
  { bodyLimit: BOX_EML_LARGE_BODY_LIMIT },
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const body = z
      .object({
        week: z.number().int().positive(),
        fromEmail: z.string().min(1).email().optional(),
        fromName: z.string().optional(),
        templates: patchWeeklyBoxEmailSettingsBody.shape.templates,
      })
      .parse(req.body ?? {});
    const season = db.select().from(seasons).where(eq(seasons.id, seasonId)).get();
    if (!season) return reply.code(404).send({ error: "season_not_found" });
    const delivery = getHouseLeagueWeeklyBoxEmailSettings(db, config);
    const result = await buildWeeklyBoxEmlZipBuffer(db, config, seasonId, body.week, {
      templateOverride: body.templates,
      fromEmail: body.fromEmail?.trim() || delivery.fromEmail,
      fromName: body.fromName !== undefined ? body.fromName : delivery.fromName,
    });
    if ("error" in result) {
      return reply.code(400).send({ error: result.error });
    }
    return reply
      .header("Content-Type", "application/zip")
      .header(
        "Content-Disposition",
        `attachment; filename="${result.filename.replace(/"/g, "")}"`,
      )
      .send(result.buffer);
  },
);

app.get(
  "/api/seasons/:seasonId/house-league/weekly-box-email/box-eml",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const q = z
      .object({
        week: z.coerce.number().int().positive(),
        boxNumber: z.coerce.number().int().positive(),
        matchIndex: z.coerce.number().int().min(0).max(2).optional(),
        itemKey: z.string().min(1).optional(),
        fromEmail: z.string().min(1).email().optional(),
        fromName: z.string().optional(),
      })
      .parse(req.query ?? {});
    const delivery = getHouseLeagueWeeklyBoxEmailSettings(db, config);
    const bundle = await buildWeeklyBoxEmailBundle(
      db,
      config,
      seasonId,
      q.week,
    );
    if ("error" in bundle) {
      return reply.code(400).send({ error: bundle.error });
    }
    const item =
      (q.itemKey
        ? bundle.items.find((i) => i.itemKey === q.itemKey)
        : null) ??
      bundle.items.find(
        (i) =>
          i.boxNumber === q.boxNumber &&
          i.matchIndex === (q.matchIndex ?? 0),
      );
    if (!item) {
      return reply.code(404).send({ error: "item_not_found" });
    }
    const eml = weeklyEmlFileForItem(
      item,
      q.week,
      q.fromName?.trim() || delivery.fromName,
      q.fromEmail?.trim() || delivery.fromEmail,
    );
    if ("error" in eml) {
      return reply.code(400).send({ error: eml.error });
    }
    return reply
      .header("Content-Type", "message/rfc822")
      .header(
        "Content-Disposition",
        `attachment; filename="${eml.filename.replace(/"/g, "")}"`,
      )
      .send(eml.content);
  },
);

app.post(
  "/api/seasons/:seasonId/house-league/weekly-box-email/send",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const body = z
      .object({
        week: z.number().int().positive(),
        force: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        boxNumber: z.number().int().positive().optional(),
      })
      .parse(req.body ?? {});
    const autoSend = shouldAutoSendForCurrentMode(db);
    const out = await stageWeeklyBoxEmails(db, config, emailAdapter, {
      seasonId,
      weekNumber: body.week,
      autoSend,
      mode: "normal",
      force: body.force,
      dryRun: body.dryRun,
      boxNumbers: body.boxNumber != null ? [body.boxNumber] : undefined,
    });
    return {
      ok: true,
      weekNumber: body.week,
      staged: out.staged,
      sent: out.sent,
      skipped: out.skipped,
      warnings: out.warnings,
    };
  },
);

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
  db.update(emailOutbox)
    .set({ status: "sent", sentAt: new Date().toISOString() })
    .where(eq(emailOutbox.id, id))
    .run();
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

function csvEscapeCell(value: string): string {
  const v = String(value ?? "").replace(/\r\n|\n|\r/g, " ").trimEnd();
  if (/["\n,]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function houseLeagueRosterCsvBuffer(
  roster: { firstName: string; lastName: string }[],
): Buffer {
  const lines = [
    `${csvEscapeCell("First name")},${csvEscapeCell("Last name")}`,
  ];
  for (const r of roster) {
    lines.push(`${csvEscapeCell(r.firstName)},${csvEscapeCell(r.lastName)}`);
  }
  return Buffer.from(`\uFEFF${lines.join("\r\n")}`, "utf8");
}

const houseLeagueAccountingRosterMailBody = z.object({
  to: z.string().email(),
  body: z.string().min(1).max(100_000),
  /** Booking season row id (shown in HL Emails → Outbox when filtering by linked season). */
  seasonId: z.string().min(1).optional(),
  roster: z
    .array(
      z.object({
        firstName: z.string().max(200),
        lastName: z.string().max(200),
      }),
    )
    .min(1)
    .max(5000),
});

/**
 * Director action: email the current house league roster CSV (first / last name only)
 * to an accounting address.
 */
app.post("/api/houseleague/roster/send-accounting", async (req, reply) => {
  const body = houseLeagueAccountingRosterMailBody.parse(req.body);
  const csvBuf = houseLeagueRosterCsvBuffer(body.roster);
  const day = new Date().toISOString().slice(0, 10);
  const filename = `house-league-roster-${day}.csv`;
  const subject = `House league roster (${body.roster.length} players)`;

  const sent = await emailAdapter.send({
    to: body.to.trim(),
    subject,
    body: body.body.trim(),
    meta: {
      kind: "houseleague_roster_accounting",
      playerCount: body.roster.length,
    },
    attachments: [
      {
        filename,
        content: csvBuf,
        contentType: "text/csv; charset=utf-8",
      },
    ],
  });

  if (!sent.ok) {
    return reply.code(502).send({ ok: false, error: sent.error });
  }

  const sid = body.seasonId?.trim();
  const ts = new Date().toISOString();
  db.insert(emailOutbox)
    .values({
      id: crypto.randomUUID(),
      kind: "houseleague_roster_accounting",
      seasonId: sid || null,
      status: "sent",
      scheduledSendAt: null,
      sentAt: ts,
      toAddress: body.to.trim(),
      subject,
      body: body.body.trim(),
      metaJson: JSON.stringify({
        rosterAccountingAttachment: filename,
        playerCount: body.roster.length,
      }),
    })
    .run();

  return { ok: true };
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

app.post("/api/seasons/:seasonId/booking/rebook-play-day", async (req) => {
  const { seasonId } = req.params as { seasonId: string };
  const body = z
    .object({
      week: z.coerce.number().int().min(1),
      playDay: z.enum(["mon", "tue"]),
      holdId: z.string().optional(),
      startMondayDate: z.string().optional(),
      confirm: z.boolean(),
    })
    .parse(req.body);
  return runRebookPlayDay(db, config, { seasonId, ...body });
});

app.post("/api/seasons/:seasonId/booking/mark-week-local", async (req) => {
  const { seasonId } = req.params as { seasonId: string };
  const body = z
    .object({
      startMondayDate: z.string().min(1),
      week: z.coerce.number().int().min(1),
      display: z.enum(["bulk_held", "converted"]),
    })
    .parse(req.body);
  return markWeekBookingDisplayLocal(db, { seasonId, ...body });
});

app.post("/api/seasons/:seasonId/booking/mark-slot-local", async (req) => {
  const { seasonId } = req.params as { seasonId: string };
  const body = z
    .object({
      startMondayDate: z.string().min(1),
      week: z.coerce.number().int().min(1),
      date: z.string().min(1),
      begin: z.string().min(1),
      end: z.string().min(1),
      display: z.enum(["bulk_held", "converted"]),
    })
    .parse(req.body);
  return markSlotBookingDisplayLocal(db, { seasonId, ...body });
});

app.post(
  "/api/seasons/:seasonId/booking/book-slot-both-courts",
  async (req, reply) => {
    const { seasonId } = req.params as { seasonId: string };
    const body = z
      .object({
        week: z.coerce.number().int().min(1),
        mondayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        tuesdayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        begin: z.string().regex(/^\d{1,2}:\d{2}$/),
        end: z.string().regex(/^\d{1,2}:\d{2}$/),
      })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        ok: false,
        message: "Invalid request",
        detail: body.error.flatten(),
      });
    }
    try {
      const result = await runBookSlotBothCourtsNoBulkCancel(db, config, {
        seasonId,
        ...body.data,
      });
      const code = result.ok ? 200 : 502;
      return reply.code(code).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ ok: false, message, courts: [] });
    }
  },
);

/** TEMP: Stadium ID-map smoke test before Convert Visible Week. */
app.post("/api/seasons/:seasonId/booking/test-stadium-id-map", async (req, reply) => {
  const { seasonId } = req.params as { seasonId: string };
  const body = z
    .object({
      week: z.coerce.number().int().min(1),
      mondayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      tuesdayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      sourceBegin: z.string().regex(/^\d{1,2}:\d{2}$/),
      sourceEnd: z.string().regex(/^\d{1,2}:\d{2}$/),
    })
    .safeParse(req.body ?? {});
  if (!body.success) {
    return reply.code(400).send({
      ok: false,
      message: "Invalid request",
      detail: body.error.flatten(),
    });
  }
  try {
    const result = await runStadiumIdMapTestBooking(db, config, {
      seasonId,
      ...body.data,
    });
    const code = result.ok ? 200 : 502;
    return reply.code(code).send(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ ok: false, message });
  }
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
