// Central config + env access for the worker service. Reading env through
// here (rather than process.env scattered everywhere) keeps the "which keys
// are missing" story in one place and lets jobs fail with a clear message.

// Parse a positive-integer env var, falling back on anything nonsensical.
// Treats unset, "", "0", and non-numeric ("abc") all as "use the default" —
// which is deliberate: none of the knobs below has a meaningful zero, and "0"
// / "" were exactly the values that used to fall through the old `|| 60`
// footgun and silently triple the API spend.
export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

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

  // LEGACY — only the old citywide Text Search path (searchRestaurants, used by
  // worker/run-once.ts for ad-hoc queries) reads this. The nightly cron now
  // sources via the neighborhood grid (worker/lib/grid.ts + searchNearby), which
  // is bounded by the grid cells, not this number.
  perCityLimit: intEnv("WORKER_PER_CITY_LIMIT", 60),

  // Retained only for worker/run-once.ts (the manual one-off sourcing script).
  sourceLimit: intEnv("WORKER_SOURCE_LIMIT", 20),

  // Max photos scored per restaurant during enrichment. Scoring is the dominant
  // per-restaurant cost (a Google fetch + a Claude Vision call each), so this is
  // the main cost dial. Scoring stops EARLY once a signature dish is found — this
  // is just the worst-case ceiling (see scorePhotos in enrichRestaurant.ts).
  //
  // NOT the dominant cost any more (this comment said so until 2026-08-24 and
  // was off by ~40x, which is exactly what made photo scoring look like the
  // thing to cut). Measured over Aug 20-23: 480 restaurants -> 148 Vision calls
  // total, i.e. 0.31 per restaurant (~$0.11/night) — the adaptive early-exit
  // above works. The real per-lead cost is the chain check in enrichRestaurant
  // step 4 at ~$4-5/night before it was gated to emailable leads only.
  photoScoreLimit: intEnv("WORKER_PHOTO_SCORE_LIMIT", 4),

  // How many guessed mailboxes to run past NeverBounce when the free
  // extractors find nothing. Order in GUESS_LOCALPARTS (emailDiscovery.ts) is
  // info/contact/hello — now load-bearing: measured 2026-08-25 across every
  // verified guess ever, all 11 were info@; contact@/hello@ had verified ZERO.
  // Lowered 3 -> 1 on that basis — no measured yield loss, and it keeps guess
  // spend inside NeverBounce's flat 1,000-credit/mo plan at the current
  // nightly cap (3/lead was heading toward overage). Raise via
  // WORKER_EMAIL_GUESS_LIMIT if a later measurement shows contact@/hello@
  // earning their keep; 0 turns the guess fallback off entirely.
  emailGuessLimit: intEnv("WORKER_EMAIL_GUESS_LIMIT", 1),

  // The chain/hospitality-group check (Claude + up to 3 web searches, ~6¢ each).
  // ON by default (flipped 2026-08-21) — the static denylist (chains.ts) kept
  // missing real cases in production the same night this shipped: two 7-Eleven
  // locations, Pollo Feliz, Pure Green, and — the one that mattered most — a
  // legitimate independent (Tree House Chicago) whose listed contact was a
  // shared hospitality-GROUP mailbox, which no name-matching denylist can catch
  // by design. This check runs on every candidate that clears the free hard
  // filters (~15-20/night at the current cap), so budget ~$1-1.20/night
  // (~$30-35/month) — not the old "~6¢/call" framing, which undersold the real
  // nightly rate. Bonus: it also fills ownerFirstName for personalization,
  // which had never been populated with this off. Set WORKER_ENABLE_CHAIN_CHECK
  // to "false" to opt back into the wide-net strategy.
  enableChainCheck: process.env.WORKER_ENABLE_CHAIN_CHECK !== "false",

  // Politeness delay between Places search calls in the sourcing loop (ms).
  placesThrottleMs: intEnv("WORKER_PLACES_THROTTLE_MS", 200),

  // Cap on how many NEW (never-seen) grid candidates to fully process per run —
  // this is the nightly SPEND CEILING. Filtering is free (fields ride on the
  // Nearby search); the cost is one enrichment job (NeverBounce + Vision) per
  // candidate that clears the hard filters.
  // The grid can discover hundreds of new places on the first sweeps, so unlike
  // the old text-search path this MUST be capped. 0 = no cap. Candidates beyond
  // the cap aren't recorded, so they simply reappear in tomorrow's sweep — the
  // grid backfills over several nights.
  //
  // Raised 50 -> 80 on 2026-08-24. Measured across 4 real nights: 50 processed
  // -> ~17 survive all gates with a website -> 3-4 queued (verified email). The
  // original "~50 processed ≈ ~20 queued" estimate was off by ~5x — at cap 50
  // the 20/night target is arithmetically unreachable even with a perfect email
  // hit rate. 80 processed projects to ~6-8 queued/night at the measured ~20%
  // hit rate, for roughly +$1-1.50/night (chain checks + Vision + NeverBounce
  // on ~15 extra gate-clearing candidates). Set WORKER_NIGHTLY_ENRICH_CAP on
  // Railway to override without a deploy.
  nightlyEnrichCap: intEnv("WORKER_NIGHTLY_ENRICH_CAP", 80),

  // Cities to source, SEMICOLON-separated (so each entry can be "City, State").
  // Each MUST have a grid in worker/lib/grid.ts. Added Nashville/Denver/San Diego
  // for email supply (measured higher email-hit-rate than Miami/LA). NOTE: if
  // WORKER_TARGET_CITIES is set on Railway it OVERRIDES this default — update it
  // there too, or unset it to use this list.
  targetCities: (
    process.env.WORKER_TARGET_CITIES ??
    "Miami, FL; New York, NY; Chicago, IL; Los Angeles, CA; Nashville, TN; Denver, CO; San Diego, CA"
  )
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean),

  // Cron for the nightly sourcing run (local time on Railway). Off-minute on
  // purpose so we're not hammering Google/Anthropic exactly on the hour.
  sourcingCron: process.env.WORKER_SOURCING_CRON ?? "17 2 * * *",

  // Touch 1 drafting + sending. Every 20 minutes, NOT daily (changed
  // 2026-08-24): approving a draft only flips a DB flag, so on the old
  // "23 14 * * *" schedule an email approved at 2pm sat until 10:23 the next
  // morning unless someone hit "Run now" on the Controls page — which is what
  // Enrique was doing by hand every time.
  //
  // Running it 72x/day does NOT increase volume. sendApproved() is bounded by
  // dailyCap() minus sentToday(), so the daily ceiling holds no matter how often
  // the job ticks, and sends stay spread out rather than firing in one burst.
  // draftBatch() computes its room as (daily draft target − the pending review
  // pile), so extra ticks just top the pile back up to the same number instead
  // of drafting more. The frequent tick did require throttling the
  // deliverability alert, which trips on every run while it holds — see
  // DELIVERABILITY_ALERT_COOLDOWN_MS in worker/jobs/sendOutreach.ts.
  //
  // The cron stays 24/7 on PURPOSE even though sends are now confined to
  // business hours (2026-08-26): the business-hours window is enforced
  // per-recipient at SEND time (worker/lib/sendWindow.ts — 9am–12pm local,
  // Mon–Fri, in the recipient's own timezone, since the target cities span
  // ET→PT), NOT by the cron. Gating the cron instead would (a) also freeze
  // draftBatch(), so the review pile would go stale overnight/weekends, and
  // (b) miss bumps entirely, which fire on the reply-poll cron, not this one.
  // Keeping the cron frequent lets drafting stay fresh while the send gate
  // handles timing; a tick outside every recipient's window is a cheap no-op.
  sendCron: process.env.WORKER_SEND_CRON ?? "*/20 * * * *",

  // How often to poll Gmail for replies.
  replyPollCron: process.env.WORKER_REPLY_POLL_CRON ?? "*/4 * * * *",

  // How often to check for paid packages with uploaded photos to enhance.
  packageCron: process.env.WORKER_PACKAGE_CRON ?? "*/1 * * * *",

  // Weekly pipeline report email (Monday ~1pm local, off-minute).
  statsCron: process.env.WORKER_STATS_CRON ?? "7 13 * * 1",

  // Nightly sourcing health report email — runs a couple hours AFTER sourcing so
  // per-restaurant enrichment has finished and the summary reflects verified
  // emails / photo scores, not just raw sourcing counts. ~4am local, off-minute.
  sourcingReportCron: process.env.WORKER_SOURCING_REPORT_CRON ?? "9 4 * * *",

  // How far back the sourcing report counts "tonight's" leads. Must comfortably
  // cover the gap between the sourcing cron and this report (default 2:17am ->
  // 4:09am, so 6h is ample) without bleeding into the previous night's run.
  sourcingReportLookbackHours: intEnv("WORKER_SOURCING_REPORT_LOOKBACK_HOURS", 6),

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
