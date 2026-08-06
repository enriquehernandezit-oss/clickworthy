import { PgBoss } from "pg-boss";

// Web-side pg-boss handle, send-only. The worker owns the queues, crons, and
// schema; the web app just needs to enqueue a job when an admin clicks "Run now".
// So we disable every background loop:
//   supervise:false — no maintenance/archival supervision loop
//   schedule:false  — no cron clock (the worker runs the crons)
//   migrate:false   — never migrate the pgboss schema from the web app; if the
//                     schema is missing/mismatched, start() throws and the admin
//                     route reports "worker has never booted" instead of silently
//                     altering tables the worker owns.
// One lazy singleton for the whole server process (Railway long-lived Node).

let instance: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export function getBoss(): Promise<PgBoss> {
  if (instance) return Promise.resolve(instance);
  starting ??= new PgBoss({
    connectionString: process.env.DATABASE_URL!,
    supervise: false,
    schedule: false,
    migrate: false,
  })
    .start()
    .then((b) => {
      b.on("error", (e) => console.error("[queue] pg-boss:", e));
      instance = b;
      return b;
    })
    .catch((err) => {
      // Reset so a later request can retry (e.g. once the worker has booted).
      starting = null;
      throw err;
    });
  return starting;
}
