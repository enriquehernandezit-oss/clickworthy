// Worker service entry point. Runs as a second Railway service (separate from
// the Next.js web app, sharing the same Postgres). Responsibilities:
//   - a nightly cron that sources leads (Google Places -> filters -> DB)
//   - a per-restaurant enrichment consumer (email, group check, photo scoring)
//
// pg-boss (Postgres-backed) provides both the queue and the cron, so there's
// no Redis/extra infrastructure. Queues must be created before use in v12.

import { PgBoss } from "pg-boss";
import { config, requireKey } from "./config";
import { SOURCE_QUEUE, runSourcing, type SourceJobData } from "./jobs/sourceLeads";
import { ENRICH_QUEUE, runEnrichment, type EnrichJobData } from "./jobs/enrichRestaurant";

async function main() {
  const connectionString = requireKey("databaseUrl", "DATABASE_URL");
  const boss = new PgBoss(connectionString);

  boss.on("error", (err) => console.error("[pg-boss] error:", err));

  await boss.start();
  await boss.createQueue(SOURCE_QUEUE);
  await boss.createQueue(ENRICH_QUEUE);

  // Sourcing consumer — one batch job per run; fan out enrichment jobs.
  await boss.work<SourceJobData>(SOURCE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      console.log(`[worker] sourcing run ${job.id}`);
      await runSourcing(boss, job.data);
    }
  });

  // Enrichment consumer — one job per restaurant.
  await boss.work<EnrichJobData>(ENRICH_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await runEnrichment(job.data);
    }
  });

  // Nightly cron. Idempotent across restarts — pg-boss dedupes the schedule by
  // queue name.
  await boss.schedule(SOURCE_QUEUE, config.sourcingCron, {});
  console.log(
    `[worker] up. sourcing cron "${config.sourcingCron}", cities: ${config.targetCities.join("; ")}` +
      (config.dryRun ? " [DRY RUN]" : "")
  );

  const shutdown = async () => {
    console.log("[worker] shutting down...");
    await boss.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
