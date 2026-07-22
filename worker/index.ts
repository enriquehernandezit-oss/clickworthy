// Worker service entry point. Runs as a second Railway service (separate from
// the Next.js web app, sharing the same Postgres). Responsibilities:
//   - nightly cron: source leads (Google Places -> filters -> DB)
//   - per-restaurant enrichment (email, group check, photo scoring)
//   - nightly cron: send Touch 1 cold email (gated by OUTREACH_ENABLED)
//   - every few minutes: poll Gmail for replies + send approved Touch 2s
//   - enhance emailed free-sample photos (Claid), held for human review
//
// pg-boss (Postgres-backed) provides both the queue and the cron, so there's
// no Redis/extra infrastructure. Queues must be created before use in v12.

import { PgBoss } from "pg-boss";
import { config, requireKey } from "./config";
import { SOURCE_QUEUE, runSourcing, type SourceJobData } from "./jobs/sourceLeads";
import { ENRICH_QUEUE, runEnrichment, type EnrichJobData } from "./jobs/enrichRestaurant";
import { runSendOutreach } from "./jobs/sendOutreach";
import { runReplyPoll } from "./jobs/pollReplies";
import { runSendTouch2 } from "./jobs/sendTouch2";
import { PROCESS_SAMPLE_QUEUE, runProcessFreeSample, type ProcessSampleJobData } from "./jobs/processFreeSample";
import { runProcessPackages } from "./jobs/processPackage";

const SEND_QUEUE = "send-outreach";
const REPLY_QUEUE = "reply-cycle";
const PACKAGE_QUEUE = "process-package";

async function main() {
  const connectionString = requireKey("databaseUrl", "DATABASE_URL");
  const boss = new PgBoss(connectionString);

  boss.on("error", (err) => console.error("[pg-boss] error:", err));

  await boss.start();
  for (const q of [SOURCE_QUEUE, ENRICH_QUEUE, SEND_QUEUE, REPLY_QUEUE, PROCESS_SAMPLE_QUEUE, PACKAGE_QUEUE]) {
    await boss.createQueue(q);
  }

  // Sourcing — one batch job per run; fans out enrichment jobs.
  await boss.work<SourceJobData>(SOURCE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      console.log(`[worker] sourcing run ${job.id}`);
      await runSourcing(boss, job.data);
    }
  });

  // Enrichment — one job per restaurant.
  await boss.work<EnrichJobData>(ENRICH_QUEUE, async (jobs) => {
    for (const job of jobs) await runEnrichment(job.data);
  });

  // Touch 1 send — one batch job per run.
  await boss.work(SEND_QUEUE, async (jobs) => {
    for (let i = 0; i < jobs.length; i++) await runSendOutreach();
  });

  // Reply cycle — poll Gmail for replies, then send any approved Touch 2s.
  await boss.work(REPLY_QUEUE, async (jobs) => {
    for (let i = 0; i < jobs.length; i++) {
      await runReplyPoll(boss);
      await runSendTouch2();
    }
  });

  // Free-sample enhancement — one job per emailed photo.
  await boss.work<ProcessSampleJobData>(PROCESS_SAMPLE_QUEUE, async (jobs) => {
    for (const job of jobs) await runProcessFreeSample(job.data);
  });

  // Paid-package enhancement — processes uploaded photos after payment.
  await boss.work(PACKAGE_QUEUE, async (jobs) => {
    for (let i = 0; i < jobs.length; i++) await runProcessPackages();
  });

  // Crons (idempotent across restarts — pg-boss dedupes the schedule by queue).
  await boss.schedule(SOURCE_QUEUE, config.sourcingCron, {});
  await boss.schedule(SEND_QUEUE, config.sendCron, {});
  await boss.schedule(REPLY_QUEUE, config.replyPollCron, {});
  await boss.schedule(PACKAGE_QUEUE, config.packageCron, {});

  console.log(
    `[worker] up.\n` +
      `  sourcing:   "${config.sourcingCron}"  cities: ${config.targetCities.join("; ")}\n` +
      `  send:       "${config.sendCron}"  (outreach ${process.env.OUTREACH_ENABLED === "true" ? "ENABLED" : "disabled"})\n` +
      `  reply poll: "${config.replyPollCron}"\n` +
      `  packages:   "${config.packageCron}"` +
      (config.dryRun ? "\n  [DRY RUN]" : "")
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
