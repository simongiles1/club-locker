import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import fs from "node:fs";
import path from "node:path";

function resolveSqlitePath(databaseUrl: string): string {
  if (databaseUrl.startsWith("file:")) {
    return databaseUrl.slice("file:".length);
  }
  return databaseUrl;
}

/** Idempotent CREATE TABLE statements for core monorepo tables. */
function migrateCoreTables(sqlite: InstanceType<typeof Database>) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id text PRIMARY KEY,
      external_id text,
      display_name text NOT NULL,
      email text,
      rating text NOT NULL DEFAULT '3.0',
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS seasons (
      id text PRIMARY KEY,
      name text NOT NULL,
      club_year integer,
      calendar_segment text,
      start_monday_date text,
      start_date text,
      end_date text,
      status text NOT NULL DEFAULT 'registration',
      championship_round_due_dates_json text,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS league_boxes (
      id text PRIMARY KEY,
      season_id text NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      box_number integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS league_box_players (
      id text PRIMARY KEY,
      box_id text NOT NULL REFERENCES league_boxes(id) ON DELETE CASCADE,
      player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      seat integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS enrollments (
      id text PRIMARY KEY,
      season_id text NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'enrolled'
    );
  `);
}

/** Apply additive SQLite schema updates (no drizzle migrator in repo). */
function migrateSqliteSeasonsColumns(sqlite: InstanceType<typeof Database>) {
  const rows = sqlite.prepare("PRAGMA table_info(seasons)").all() as {
    name: string;
  }[];
  const names = new Set(rows.map((r) => r.name));
  if (!names.has("club_year")) {
    sqlite.exec("ALTER TABLE seasons ADD COLUMN club_year integer");
  }
  if (!names.has("calendar_segment")) {
    sqlite.exec("ALTER TABLE seasons ADD COLUMN calendar_segment text");
  }
  if (!names.has("start_monday_date")) {
    sqlite.exec("ALTER TABLE seasons ADD COLUMN start_monday_date text");
  }
  if (!names.has("championship_round_due_dates_json")) {
    sqlite.exec(
      "ALTER TABLE seasons ADD COLUMN championship_round_due_dates_json text",
    );
  }
  ensureColumn(
    sqlite,
    "seasons",
    "draft_house_league_players_json",
    "draft_house_league_players_json text",
  );
  ensureColumn(
    sqlite,
    "seasons",
    "house_league_event_id",
    "house_league_event_id integer",
  );
  ensureColumn(
    sqlite,
    "seasons",
    "season_start_roster_json",
    "season_start_roster_json text",
  );
  ensureColumn(
    sqlite,
    "seasons",
    "season_start_roster_saved_at",
    "season_start_roster_saved_at text",
  );
}

/** Idempotent CREATE TABLE statements for the championships feature. */
function migrateChampionshipTables(sqlite: InstanceType<typeof Database>) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS championships (
      id text PRIMARY KEY,
      season_id text REFERENCES seasons(id) ON DELETE SET NULL,
      format text NOT NULL,
      division_kind text NOT NULL,
      division_label text NOT NULL,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'registration',
      round_one_due_date text,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS championship_entries (
      id text PRIMARY KEY,
      championship_id text NOT NULL REFERENCES championships(id) ON DELETE CASCADE,
      player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      partner_player_id text REFERENCES players(id) ON DELETE SET NULL,
      seed integer,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS championship_draws (
      id text PRIMARY KEY,
      championship_id text NOT NULL REFERENCES championships(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'draft',
      size integer NOT NULL,
      snapshot_json text NOT NULL,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS championship_matches (
      id text PRIMARY KEY,
      championship_id text NOT NULL REFERENCES championships(id) ON DELETE CASCADE,
      draw_id text NOT NULL REFERENCES championship_draws(id) ON DELETE CASCADE,
      round integer NOT NULL,
      match_index integer NOT NULL,
      top_entry_id text REFERENCES championship_entries(id) ON DELETE SET NULL,
      top_is_bye integer NOT NULL DEFAULT 0,
      bottom_entry_id text REFERENCES championship_entries(id) ON DELETE SET NULL,
      bottom_is_bye integer NOT NULL DEFAULT 0,
      winner_entry_id text REFERENCES championship_entries(id) ON DELETE SET NULL,
      due_date text,
      completed_at text
    );
    CREATE INDEX IF NOT EXISTS championship_entries_championship_idx
      ON championship_entries(championship_id);
    CREATE INDEX IF NOT EXISTS championship_matches_draw_idx
      ON championship_matches(draw_id);
  `);
}

function migrateEmailTemplatesTable(sqlite: InstanceType<typeof Database>) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id text PRIMARY KEY,
      name text NOT NULL,
      subject_template text NOT NULL,
      body_template text NOT NULL,
      created_at text NOT NULL DEFAULT (datetime('now')),
      updated_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS email_templates_name_idx ON email_templates(name);
  `);
  ensureColumn(
    sqlite,
    "email_templates",
    "scope",
    `scope text NOT NULL DEFAULT 'championships'`,
  );
}

function ensureColumn(
  sqlite: InstanceType<typeof Database>,
  table: string,
  column: string,
  ddl: string,
) {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  const names = new Set(rows.map((r) => r.name));
  if (!names.has(column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function migrateStatutoryHolidaysTable(sqlite: InstanceType<typeof Database>) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS statutory_holidays (
      id text PRIMARY KEY,
      name text NOT NULL,
      date text NOT NULL,
      open_time text,
      close_time text,
      closed integer NOT NULL DEFAULT 0,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS statutory_holidays_date_uidx
      ON statutory_holidays(date);
  `);
  ensureColumn(
    sqlite,
    "statutory_holidays",
    "closure_kind",
    "closure_kind text NOT NULL DEFAULT 'holiday'",
  );
}

function migrateFeedbackTicketsTable(sqlite: InstanceType<typeof Database>) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS feedback_tickets (
      id text PRIMARY KEY,
      kind text NOT NULL,
      description text NOT NULL,
      screenshot_mime text,
      screenshot_base64 text,
      completed_at text,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS feedback_tickets_created_idx
      ON feedback_tickets(created_at);
  `);
  ensureColumn(sqlite, "feedback_tickets", "completed_at", "completed_at text");
}

function migrateEmailOutboxAndHouseLeagueReminders(
  sqlite: InstanceType<typeof Database>,
) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS email_outbox (
      id text PRIMARY KEY,
      kind text NOT NULL,
      season_id text REFERENCES seasons(id),
      status text NOT NULL DEFAULT 'draft',
      to_address text NOT NULL,
      subject text NOT NULL,
      body text NOT NULL,
      meta_json text,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ensureColumn(
    sqlite,
    "email_outbox",
    "scheduled_send_at",
    "scheduled_send_at text",
  );
  ensureColumn(sqlite, "email_outbox", "sent_at", "sent_at text");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS house_league_booked_occurrences (
      id text PRIMARY KEY,
      season_id text NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      week_number integer NOT NULL,
      play_date text NOT NULL,
      slot text NOT NULL,
      court_id integer NOT NULL,
      box_number integer NOT NULL,
      player1_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      player2_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      booking_run_id text,
      reservation_id text,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS hl_occ_season_week_date_slot_box_uidx
      ON house_league_booked_occurrences(
        season_id, week_number, play_date, slot, court_id, box_number
      );
    CREATE TABLE IF NOT EXISTS house_league_match_reminder_sends (
      id text PRIMARY KEY,
      occurrence_id text NOT NULL REFERENCES house_league_booked_occurrences(id) ON DELETE CASCADE,
      player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      sent_at text NOT NULL,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS hl_rem_send_occ_player_uidx
      ON house_league_match_reminder_sends(occurrence_id, player_id);
  `);
}

function migrateAutomationTables(sqlite: InstanceType<typeof Database>) {
  ensureColumn(
    sqlite,
    "championship_matches",
    "scheduled_at",
    "scheduled_at text",
  );
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS inbound_emails (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      from_address text NOT NULL,
      to_address text NOT NULL,
      subject text,
      body_text text,
      body_html text,
      alias_tag text,
      received_at text NOT NULL,
      processed_at text,
      error_message text,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS inbound_emails_message_id_idx
      ON inbound_emails(message_id);
  `);
  ensureColumn(
    sqlite,
    "inbound_emails",
    "mailbox_scope",
    "mailbox_scope text",
  );
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS inbound_actions (
      id text PRIMARY KEY,
      email_id text NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
      kind text NOT NULL,
      payload_json text,
      confidence text,
      status text NOT NULL DEFAULT 'pending',
      applied_at text,
      applied_ref_id text,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS inbound_actions_email_idx
      ON inbound_actions(email_id);
    CREATE TABLE IF NOT EXISTS championship_match_followups (
      id text PRIMARY KEY,
      match_id text NOT NULL REFERENCES championship_matches(id) ON DELETE CASCADE,
      kind text NOT NULL,
      sent_at text NOT NULL,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS championship_followups_match_kind_idx
      ON championship_match_followups(match_id, kind);
    CREATE TABLE IF NOT EXISTS executions (
      id text PRIMARY KEY,
      workflow text NOT NULL,
      trigger_kind text NOT NULL,
      trigger_ref_id text,
      status text NOT NULL DEFAULT 'running',
      input_json text,
      output_json text,
      error_message text,
      error_stack text,
      parent_execution_id text,
      started_at text NOT NULL,
      finished_at text,
      duration_ms integer,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS executions_workflow_created_idx
      ON executions(workflow, created_at);
    CREATE TABLE IF NOT EXISTS execution_steps (
      id text PRIMARY KEY,
      execution_id text NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
      name text NOT NULL,
      step_order integer NOT NULL,
      status text NOT NULL DEFAULT 'running',
      input_json text,
      output_json text,
      error_message text,
      duration_ms integer,
      langfuse_trace_id text,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS execution_steps_execution_order_idx
      ON execution_steps(execution_id, step_order);
  `);
}

function migrateBoxEmlTemplateAssetsTable(sqlite: InstanceType<typeof Database>) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS box_eml_template_assets (
      id text PRIMARY KEY,
      mime_type text NOT NULL,
      data_base64 text NOT NULL,
      width integer,
      height integer,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function migrateBookingTables(sqlite: InstanceType<typeof Database>) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS booking_proposals (
      id text PRIMARY KEY,
      season_id text NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      week_number integer NOT NULL,
      status text NOT NULL DEFAULT 'draft',
      payload_json text NOT NULL,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS booking_holds (
      id text PRIMARY KEY,
      season_id text NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      week_number integer NOT NULL,
      monday_date text NOT NULL,
      tuesday_date text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      external_reservation_ids_json text NOT NULL,
      raw_bulk_response_json text,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS booking_runs (
      id text PRIMARY KEY,
      season_id text NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      kind text NOT NULL,
      week_number integer,
      status text NOT NULL,
      summary_json text NOT NULL,
      hold_id text REFERENCES booking_holds(id),
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS season_booking_holds (
      id text PRIMARY KEY,
      season_id text NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      start_monday_date text NOT NULL,
      season_weeks integer NOT NULL,
      status text NOT NULL DEFAULT 'active',
      monday_reservation_ids_json text NOT NULL,
      tuesday_reservation_ids_json text NOT NULL,
      converted_weeks_json text NOT NULL DEFAULT '[]',
      locally_converted_slots_json text NOT NULL DEFAULT '[]',
      raw_bulk_response_json text,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function migrateHouseLeagueWeeklyBoxSends(sqlite: InstanceType<typeof Database>) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS house_league_weekly_box_sends (
      id text PRIMARY KEY,
      season_id text NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      week_number integer NOT NULL,
      box_number integer NOT NULL,
      match_index integer NOT NULL DEFAULT 0,
      outbox_id text REFERENCES email_outbox(id) ON DELETE SET NULL,
      sent_at text NOT NULL,
      created_at text NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ensureColumn(
    sqlite,
    "house_league_weekly_box_sends",
    "match_index",
    "match_index integer NOT NULL DEFAULT 0",
  );
  sqlite.exec(`DROP INDEX IF EXISTS hl_weekly_box_send_season_week_box_uidx;`);
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS hl_weekly_box_send_season_week_box_match_uidx
      ON house_league_weekly_box_sends(season_id, week_number, box_number, match_index);
  `);
}

export function createDb(databaseUrl: string) {
  const filePath = path.resolve(resolveSqlitePath(databaseUrl));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  migrateCoreTables(sqlite);
  migrateSqliteSeasonsColumns(sqlite);
  migrateChampionshipTables(sqlite);
  migrateEmailTemplatesTable(sqlite);
  migrateStatutoryHolidaysTable(sqlite);
  migrateAutomationTables(sqlite);
  migrateBookingTables(sqlite);
  migrateEmailOutboxAndHouseLeagueReminders(sqlite);
  migrateFeedbackTicketsTable(sqlite);
  migrateBoxEmlTemplateAssetsTable(sqlite);
  migrateHouseLeagueWeeklyBoxSends(sqlite);
  migrateSeasonBookingHoldsColumns(sqlite);
  return drizzle(sqlite, { schema });
}

function migrateSeasonBookingHoldsColumns(sqlite: InstanceType<typeof Database>) {
  ensureColumn(
    sqlite,
    "season_booking_holds",
    "locally_converted_slots_json",
    "locally_converted_slots_json text NOT NULL DEFAULT '[]'",
  );
}

export type Db = ReturnType<typeof createDb>;
