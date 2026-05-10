import { relations, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const players = sqliteTable("players", {
  id: text("id").primaryKey(),
  externalId: text("external_id"),
  displayName: text("display_name").notNull(),
  email: text("email"),
  rating: text("rating").notNull().default("3.0"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const seasons = sqliteTable("seasons", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Club-booking calendar year (Winter Y starts this club cycle). */
  clubYear: integer("club_year"),
  /** winter | spring | summer | fall */
  calendarSegment: text("calendar_segment"),
  /** First Monday of this calendar segment (YYYY-MM-DD), local club rules. */
  startMondayDate: text("start_monday_date"),
  startDate: text("start_date"),
  endDate: text("end_date"),
  status: text("status").notNull().default("registration"),
  /** JSON map of bracket round → YYYY-MM-DD due date for all club championships in this season. */
  championshipRoundDueDatesJson: text("championship_round_due_dates_json"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const leagueBoxes = sqliteTable("league_boxes", {
  id: text("id").primaryKey(),
  seasonId: text("season_id")
    .notNull()
    .references(() => seasons.id, { onDelete: "cascade" }),
  boxNumber: integer("box_number").notNull(),
});

export const leagueBoxPlayers = sqliteTable("league_box_players", {
  id: text("id").primaryKey(),
  boxId: text("box_id")
    .notNull()
    .references(() => leagueBoxes.id, { onDelete: "cascade" }),
  playerId: text("player_id")
    .notNull()
    .references(() => players.id, { onDelete: "cascade" }),
  seat: integer("seat").notNull(),
});

export const enrollments = sqliteTable("enrollments", {
  id: text("id").primaryKey(),
  seasonId: text("season_id")
    .notNull()
    .references(() => seasons.id, { onDelete: "cascade" }),
  playerId: text("player_id")
    .notNull()
    .references(() => players.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("enrolled"),
});

export const syncRuns = sqliteTable("sync_runs", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  status: text("status").notNull(),
  detail: text("detail"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const registrationQueue = sqliteTable("registration_queue", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  fromEmail: text("from_email").notNull(),
  subject: text("subject"),
  body: text("body"),
  parsedName: text("parsed_name"),
  status: text("status").notNull().default("pending"),
  matchedPlayerId: text("matched_player_id").references(() => players.id),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const emailOutbox = sqliteTable("email_outbox", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  seasonId: text("season_id").references(() => seasons.id),
  status: text("status").notNull().default("draft"),
  toAddress: text("to_address").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  metaJson: text("meta_json"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const inboundEmails = sqliteTable("inbound_emails", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull(),
  fromAddress: text("from_address").notNull(),
  toAddress: text("to_address").notNull(),
  subject: text("subject"),
  bodyText: text("body_text"),
  bodyHtml: text("body_html"),
  aliasTag: text("alias_tag"),
  receivedAt: text("received_at").notNull(),
  processedAt: text("processed_at"),
  errorMessage: text("error_message"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const inboundActions = sqliteTable("inbound_actions", {
  id: text("id").primaryKey(),
  emailId: text("email_id")
    .notNull()
    .references(() => inboundEmails.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  payloadJson: text("payload_json"),
  confidence: text("confidence"),
  status: text("status").notNull().default("pending"),
  appliedAt: text("applied_at"),
  appliedRefId: text("applied_ref_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const drawVersions = sqliteTable("draw_versions", {
  id: text("id").primaryKey(),
  seasonId: text("season_id")
    .notNull()
    .references(() => seasons.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("draft"),
  boxesJson: text("boxes_json").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const weekPlans = sqliteTable("week_plans", {
  id: text("id").primaryKey(),
  seasonId: text("season_id")
    .notNull()
    .references(() => seasons.id, { onDelete: "cascade" }),
  weekNumber: integer("week_number").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull().default("draft"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const playerBoxStats = sqliteTable("player_box_stats", {
  id: text("id").primaryKey(),
  seasonId: text("season_id")
    .notNull()
    .references(() => seasons.id, { onDelete: "cascade" }),
  boxId: text("box_id")
    .notNull()
    .references(() => leagueBoxes.id, { onDelete: "cascade" }),
  playerId: text("player_id")
    .notNull()
    .references(() => players.id, { onDelete: "cascade" }),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
});

export const bookingProposals = sqliteTable("booking_proposals", {
  id: text("id").primaryKey(),
  seasonId: text("season_id")
    .notNull()
    .references(() => seasons.id, { onDelete: "cascade" }),
  weekNumber: integer("week_number").notNull(),
  status: text("status").notNull().default("draft"),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/** Pre-season / weekly hold created by bulk clinic; stores Club Locker ids to delete before conversion */
export const bookingHolds = sqliteTable("booking_holds", {
  id: text("id").primaryKey(),
  seasonId: text("season_id")
    .notNull()
    .references(() => seasons.id, { onDelete: "cascade" }),
  weekNumber: integer("week_number").notNull(),
  mondayDate: text("monday_date").notNull(),
  tuesdayDate: text("tuesday_date").notNull(),
  status: text("status").notNull().default("active"), // active | converted | cancelled
  externalReservationIdsJson: text("external_reservation_ids_json").notNull(), // string[] of ids to DELETE
  rawBulkResponseJson: text("raw_bulk_response_json"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const bookingRuns = sqliteTable("booking_runs", {
  id: text("id").primaryKey(),
  seasonId: text("season_id")
    .notNull()
    .references(() => seasons.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // bulk | season_bulk | convert
  weekNumber: integer("week_number"),
  status: text("status").notNull(), // ok | partial | error
  summaryJson: text("summary_json").notNull(),
  holdId: text("hold_id").references(() => bookingHolds.id),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/** Pre-season recurring clinic block for the full season (Mon + Tue series, both courts each). */
export const seasonBookingHolds = sqliteTable("season_booking_holds", {
  id: text("id").primaryKey(),
  seasonId: text("season_id")
    .notNull()
    .references(() => seasons.id, { onDelete: "cascade" }),
  startMondayDate: text("start_monday_date").notNull(),
  seasonWeeks: integer("season_weeks").notNull(),
  status: text("status").notNull().default("active"), // active | fully_converted | cancelled
  /** One id per Mon slot×court×week (length = seasonWeeks × 16) from the Monday recurring clinic */
  mondayReservationIdsJson: text("monday_reservation_ids_json").notNull(),
  /** Same structure for Tuesday recurring clinic */
  tuesdayReservationIdsJson: text("tuesday_reservation_ids_json").notNull(),
  /** Week numbers (1-based) already converted to match reservations */
  convertedWeeksJson: text("converted_weeks_json").notNull().default("[]"),
  rawBulkResponseJson: text("raw_bulk_response_json"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/* -------------------------------------------------------------------------- */
/* Club championships (singles + doubles draws)                               */
/* -------------------------------------------------------------------------- */

/** A single championship draw for one division (e.g. Singles B, Doubles 40+). */
export const championships = sqliteTable("championships", {
  id: text("id").primaryKey(),
  seasonId: text("season_id").references(() => seasons.id, {
    onDelete: "set null",
  }),
  /** "singles" | "doubles" */
  format: text("format").notNull(),
  /** "skill" | "age" */
  divisionKind: text("division_kind").notNull(),
  /** "A".."F" for skill divisions; "40+"/"50+" for age divisions. */
  divisionLabel: text("division_label").notNull(),
  name: text("name").notNull(),
  /** "registration" | "drawn" | "published" | "completed" */
  status: text("status").notNull().default("registration"),
  /** ISO date by which round-1 matches must be completed (used in emails). */
  roundOneDueDate: text("round_one_due_date"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/** A player entered in a championship (with optional partner for doubles). */
export const championshipEntries = sqliteTable("championship_entries", {
  id: text("id").primaryKey(),
  championshipId: text("championship_id")
    .notNull()
    .references(() => championships.id, { onDelete: "cascade" }),
  playerId: text("player_id")
    .notNull()
    .references(() => players.id, { onDelete: "cascade" }),
  /** Doubles partner (optional). */
  partnerPlayerId: text("partner_player_id").references(() => players.id, {
    onDelete: "set null",
  }),
  /** 1-based seed; null = unseeded (will be randomly placed). */
  seed: integer("seed"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/** One generated bracket for a championship. Most championships have 1 active draw. */
export const championshipDraws = sqliteTable("championship_draws", {
  id: text("id").primaryKey(),
  championshipId: text("championship_id")
    .notNull()
    .references(() => championships.id, { onDelete: "cascade" }),
  /** "draft" | "published" */
  status: text("status").notNull().default("draft"),
  /** Power-of-two bracket size (entries + byes). */
  size: integer("size").notNull(),
  /** Cached snapshot of the bracket entries at generation time, JSON. */
  snapshotJson: text("snapshot_json").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/** One match within a draw. Round 1 is populated initially; later rounds fill as winners advance. */
export const championshipMatches = sqliteTable("championship_matches", {
  id: text("id").primaryKey(),
  championshipId: text("championship_id")
    .notNull()
    .references(() => championships.id, { onDelete: "cascade" }),
  drawId: text("draw_id")
    .notNull()
    .references(() => championshipDraws.id, { onDelete: "cascade" }),
  /** 1-based round number; round 1 = first round. */
  round: integer("round").notNull(),
  /** 0-based slot within its round. */
  matchIndex: integer("match_index").notNull(),
  /** Top-half entry (or null for bye / not yet decided). */
  topEntryId: text("top_entry_id").references(() => championshipEntries.id, {
    onDelete: "set null",
  }),
  topIsBye: integer("top_is_bye").notNull().default(0),
  bottomEntryId: text("bottom_entry_id").references(
    () => championshipEntries.id,
    { onDelete: "set null" },
  ),
  bottomIsBye: integer("bottom_is_bye").notNull().default(0),
  /** Winner entry id (null until reported). */
  winnerEntryId: text("winner_entry_id").references(
    () => championshipEntries.id,
    { onDelete: "set null" },
  ),
  /** Optional override due date in addition to the championship-level default. */
  dueDate: text("due_date"),
  /** When players reported they plan to play this match. */
  scheduledAt: text("scheduled_at"),
  completedAt: text("completed_at"),
});

/** Director-authored subject/body patterns with `{{variable}}` placeholders. */
export const emailTemplates = sqliteTable("email_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  subjectTemplate: text("subject_template").notNull(),
  bodyTemplate: text("body_template").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const championshipMatchFollowups = sqliteTable(
  "championship_match_followups",
  {
    id: text("id").primaryKey(),
    matchId: text("match_id")
      .notNull()
      .references(() => championshipMatches.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    sentAt: text("sent_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
);

export const executions = sqliteTable("executions", {
  id: text("id").primaryKey(),
  workflow: text("workflow").notNull(),
  triggerKind: text("trigger_kind").notNull(),
  triggerRefId: text("trigger_ref_id"),
  status: text("status").notNull().default("running"),
  inputJson: text("input_json"),
  outputJson: text("output_json"),
  errorMessage: text("error_message"),
  errorStack: text("error_stack"),
  parentExecutionId: text("parent_execution_id"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  durationMs: integer("duration_ms"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const executionSteps = sqliteTable("execution_steps", {
  id: text("id").primaryKey(),
  executionId: text("execution_id")
    .notNull()
    .references(() => executions.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  stepOrder: integer("step_order").notNull(),
  status: text("status").notNull().default("running"),
  inputJson: text("input_json"),
  outputJson: text("output_json"),
  errorMessage: text("error_message"),
  durationMs: integer("duration_ms"),
  langfuseTraceId: text("langfuse_trace_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const playersRelations = relations(players, ({ many }) => ({
  boxSeats: many(leagueBoxPlayers),
}));

export const leagueBoxesRelations = relations(leagueBoxes, ({ one, many }) => ({
  season: one(seasons, {
    fields: [leagueBoxes.seasonId],
    references: [seasons.id],
  }),
  players: many(leagueBoxPlayers),
}));
