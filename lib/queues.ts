// Single source of truth for pg-boss queue names, imported by BOTH the worker
// (worker/index.ts + jobs) and the web app (admin "Run now" + health panel), so
// the two can never drift. Changing a name here changes it everywhere.

export const SOURCE_QUEUE = "source-leads";
export const ENRICH_QUEUE = "enrich-restaurant";
export const SEND_QUEUE = "send-outreach";
export const REPLY_QUEUE = "reply-cycle";
export const PACKAGE_QUEUE = "process-package";
export const STATS_QUEUE = "weekly-stats";
export const SOURCING_REPORT_QUEUE = "sourcing-report";
export const SNAPSHOT_QUEUE = "pipeline-snapshot";

export const ALL_QUEUES = [
  SOURCE_QUEUE,
  ENRICH_QUEUE,
  SEND_QUEUE,
  REPLY_QUEUE,
  PACKAGE_QUEUE,
  STATS_QUEUE,
  SOURCING_REPORT_QUEUE,
  SNAPSHOT_QUEUE,
] as const;
