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

export function createDb(databaseUrl: string) {
  const filePath = path.resolve(resolveSqlitePath(databaseUrl));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  migrateSqliteSeasonsColumns(sqlite);
  migrateChampionshipTables(sqlite);
  migrateEmailTemplatesTable(sqlite);
  migrateAutomationTables(sqlite);
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;
