import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().default("file:./data/squash.db"),
  CLUB_LOCKER_ADAPTER: z.enum(["mock", "http", "playwright"]).default("mock"),
  EMAIL_ADAPTER: z
    .enum(["console", "mailchimp", "smtp", "gmail"])
    .default("console"),
  /** Gmail SMTP credentials (used when EMAIL_ADAPTER=gmail). */
  GMAIL_USER: z.string().optional(),
  /** Gmail App Password — generate at https://myaccount.google.com/apppasswords */
  GMAIL_APP_PASSWORD: z.string().optional(),
  /** Friendly From-name shown in mail clients. */
  GMAIL_FROM_NAME: z.string().optional(),
  /** Gmail IMAP host used for inbound automation polling. */
  GMAIL_IMAP_HOST: z.string().default("imap.gmail.com"),
  /** Gmail IMAP TLS port. */
  GMAIL_IMAP_PORT: z.coerce.number().int().default(993),
  /** AI classifier provider for inbound automation. */
  AI_AGENT: z.enum(["gemini", "mock"]).default("mock"),
  /** Gemini API key used when AI_AGENT=gemini. */
  GEMINI_API_KEY: z.string().optional(),
  /** Gemini model slug, e.g. gemini-2.5-flash. */
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  /** Automation scheduler tick interval (milliseconds). */
  AUTOMATION_TICK_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Optional Langfuse host; when unset, Langfuse is disabled. */
  LANGFUSE_HOST: z.string().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  /** US Squash (Club Locker) resources API: mock = no network; live = real HTTP. */
  US_SQUASH_MODE: z.enum(["mock", "live"]).default("mock"),
  US_SQUASH_API_BASE: z
    .string()
    .default("https://api.ussquash.com/resources/res"),
  US_SQUASH_BEARER_TOKEN: z.string().optional(),
  /** Optional session cookie (e.g. USSQ-API-SESSION=...) if the API requires it beyond Bearer auth. */
  US_SQUASH_SESSION_COOKIE: z.string().optional(),
  US_SQUASH_CLUB_ID: z.coerce.number().default(10_706),
  US_SQUASH_COURT_1_ID: z.coerce.number().default(3_510),
  US_SQUASH_COURT_2_ID: z.coerce.number().default(3_512),
  US_SQUASH_CUSTOM_MATCH_TYPE: z.coerce.number().default(457),
  /**
   * Page size when walking `members2` with `limit`/`offset` (live mode). If the first
   * bare response has exactly this many rows, the client fetches further pages.
   */
  US_SQUASH_MEMBERS_PAGE_SIZE: z.coerce.number().int().min(1).max(2000).default(500),
  /** Roster size returned by US_SQUASH_MODE=mock for the members directory. */
  US_SQUASH_MEMBERS_MOCK_COUNT: z.coerce.number().int().min(1).max(5000).default(564),
  /** Managed league: number of play weeks in a season (recurring block repeat count is derived from this). */
  LEAGUE_SEASON_WEEKS: z.coerce.number().int().min(1).default(8),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.warn("Invalid env, using defaults", parsed.error.flatten());
    return envSchema.parse({});
  }
  return parsed.data;
}
