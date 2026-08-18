// Worker service entry point. Runs as a second Railway service (separate from
// the Next.js web app, sharing the same Postgres). Responsibilities:
//   - nightly cron: source leads (Google Places -> filters -> DB)
//   - per-restaurant enrichment (email, group check, photo scoring)
//   - nightly cron: send Touch 1 cold email (gated by OUTREACH_ENABLED)
//   - every few minutes: poll Gmail for replies, send the one-time bump, and
//     send approved Touch 2s. Photo editing is done by hand in /admin.
//
// pg-boss (Postgres-backed) provides both the queue and the cron, so there's
// no Redis/extra infrastructure. Queues must be created before use in v12.

import { PgBoss } from "pg-boss";
import { config, requireKey } from "./config";
import { SOURCE_QUEUE, ENRICH_QUEUE, SEND_QUEUE, REPLY_QUEUE, PACKAGE_QUEUE, STATS_QUEUE, SOURCING_REPORT_QUEUE } from "@/lib/queues";
import { runSourcing, type SourceJobData } from "./jobs/sourceLeads";
import { runEnrichment, type EnrichJobData } from "./jobs/enrichRestaurant";
import { runSendOutreach, RAMP } from "./jobs/sendOutreach";
import { runReplyPoll } from "./jobs/pollReplies";
import { runSendBumps } from "./jobs/sendBumps";
import { runProcessPackages } from "./jobs/processPackage";
import { runProcessEnhancementOrders, recoverStuckPendingOrders } from "./jobs/processEnhancementOrders";
import { runWeeklyStats } from "./jobs/weeklyStats";
import { runSourcingReport } from "./jobs/sourcingReport";
import { setSetting } from "@/lib/settings";
import { WORKER_ENV_KEYS, envPresence } from "@/lib/envKeys";

async function main() {
  const connectionString = requireKey("databaseUrl", "DATABASE_URL");
  const boss = new PgBoss(connectionString);

  boss.on("error", (err) => console.error("[pg-boss] error:", err));

  await boss.start();

  // Per-queue retry policy. The per-item fan-out jobs (enrichment, free-sample
  // enhancement) retry with backoff since they hit flaky external APIs and are
  // safe to re-run. The cron-triggered batch queues use no job-level retry —
  // they simply run again on the next tick, avoiding overlapping double-runs.
  const RETRY = { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 900 };
  const NO_RETRY = { retryLimit: 0, expireInSeconds: 1800 };
  const queueConfig: Record<string, object> = {
    [SOURCE_QUEUE]: NO_RETRY,
    [ENRICH_QUEUE]: RETRY,
    [SEND_QUEUE]: NO_RETRY,
    [REPLY_QUEUE]: NO_RETRY,
    [PACKAGE_QUEUE]: NO_RETRY,
    [STATS_QUEUE]: NO_RETRY,
    [SOURCING_REPORT_QUEUE]: NO_RETRY,
  };
  for (const [q, cfg] of Object.entries(queueConfig)) {
    // createQueue only applies options on first creation; updateQueue enforces
    // the policy every boot, so changing retry config takes effect on existing
    // queues too.
    await boss.createQueue(q, cfg);
    await boss.updateQueue(q, cfg);
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

  // Reply cycle — poll Gmail for replies, then draft/send any due bumps. Touch 2
  // has no worker-driven phase anymore: approving a finished sample sends it
  // synchronously (see app/api/admin/sample/route.ts).
  await boss.work(REPLY_QUEUE, async (jobs) => {
    for (let i = 0; i < jobs.length; i++) {
      await runReplyPoll();
      await runSendBumps();
    }
  });

  // Paid work, both revenue paths: outreach-package uploads get their Claid
  // first pass, and self-serve /enhance orders are enhanced here rather than
  // inside the Stripe webhook (which would time out and be retried).
  await boss.work(PACKAGE_QUEUE, async (jobs) => {
    for (let i = 0; i < jobs.length; i++) {
      await runProcessPackages();
      await runProcessEnhancementOrders();
      await recoverStuckPendingOrders();
    }
  });

  // Weekly pipeline report.
  await boss.work(STATS_QUEUE, async (jobs) => {
    for (let i = 0; i < jobs.length; i++) await runWeeklyStats();
  });

  // Nightly sourcing health report (runs after sourcing + enrichment settle).
  await boss.work(SOURCING_REPORT_QUEUE, async (jobs) => {
    for (let i = 0; i < jobs.length; i++) await runSourcingReport();
  });

  // Crons (idempotent across restarts — pg-boss dedupes the schedule by queue).
  await boss.schedule(SOURCE_QUEUE, config.sourcingCron, {});
  await boss.schedule(SEND_QUEUE, config.sendCron, {});
  await boss.schedule(REPLY_QUEUE, config.replyPollCron, {});
  await boss.schedule(PACKAGE_QUEUE, config.packageCron, {});
  await boss.schedule(STATS_QUEUE, config.statsCron, {});
  await boss.schedule(SOURCING_REPORT_QUEUE, config.sourcingReportCron, {});

  console.log(
    `[worker] up.\n` +
      `  sourcing:   "${config.sourcingCron}"  cities: ${config.targetCities.join("; ")}\n` +
      `  send:       "${config.sendCron}"  (outreach ${process.env.OUTREACH_ENABLED === "true" ? "ENABLED" : "disabled"})\n` +
      `  reply poll: "${config.replyPollCron}"\n` +
      `  packages:   "${config.packageCron}"` +
      (config.dryRun ? "\n  [DRY RUN]" : "")
  );

  // Publish this worker's env truth so /admin can show it (web + worker have
  // separate Railway env, so the web app can't read these values otherwise).
  await setSetting("worker_boot_info", {
    outreachEnabled: process.env.OUTREACH_ENABLED === "true",
    dryRun: config.dryRun,
    ramp: RAMP,
    crons: {
      sourcing: config.sourcingCron,
      send: config.sendCron,
      replyPoll: config.replyPollCron,
      package: config.packageCron,
      stats: config.statsCron,
      sourcingReport: config.sourcingReportCron,
    },
    cities: config.targetCities,
    bootedAt: new Date().toISOString(),
    envPresent: envPresence(WORKER_ENV_KEYS),
  }).catch((err) => console.error("[worker] failed to write boot info:", err));

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
