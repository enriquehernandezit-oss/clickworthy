// Central config + env access for the worker service. Reading env through
// here (rather than process.env scattered everywhere) keeps the "which keys
// are missing" story in one place and lets jobs fail with a clear message.

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  neverBounceApiKey: process.env.NEVERBOUNCE_API_KEY,

  // Model used for all worker Claude calls (photo scoring, email extraction,
  // hospitality-group check, Revenue Impact Card copy).
  claudeModel: "claude-sonnet-5",

  // When true, the pipeline runs but caps volume and never sends anything
  // outbound — for reviewing sourced/enriched data before going live.
  dryRun: process.env.WORKER_DRY_RUN === "true",

  // Hard cap on restaurants processed per sourcing run (protects the free-tier
  // API budgets while testing). 0 = no cap.
  sourceLimit: Number(process.env.WORKER_SOURCE_LIMIT ?? "20"),

  // Cities to source, SEMICOLON-separated (so each entry can be "City, State").
  // Clickworthy is 100% US-based: Miami, New York, Chicago, Los Angeles.
  targetCities: (
    process.env.WORKER_TARGET_CITIES ??
    "Miami, FL; New York, NY; Chicago, IL; Los Angeles, CA"
  )
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean),

  // Cron for the nightly sourcing run (local time on Railway). Off-minute on
  // purpose so we're not hammering Google/Anthropic exactly on the hour.
  sourcingCron: process.env.WORKER_SOURCING_CRON ?? "17 2 * * *",

  // Nightly Touch 1 send (after sourcing/enrichment has had time to run).
  sendCron: process.env.WORKER_SEND_CRON ?? "23 14 * * *",

  // How often to poll Gmail for replies.
  replyPollCron: process.env.WORKER_REPLY_POLL_CRON ?? "*/4 * * * *",

  // Public origin of the web app, used to build magic-link URLs and (for the
  // Postgres-blob storage fallback) absolute photo URLs.
  appOrigin: process.env.APP_ORIGIN ?? "https://clickworthytool.com",
};

export function requireKey(key: keyof typeof config, label: string): string {
  const value = config[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${label} is not configured (env for "${String(key)}" is empty). ` +
        "This step cannot run until the key is added."
    );
  }
  return value;
}
