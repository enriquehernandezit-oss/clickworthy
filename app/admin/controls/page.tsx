import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getAllSettings } from "@/lib/settings";
import { ALL_QUEUES, SOURCE_QUEUE, SEND_QUEUE, REPLY_QUEUE, STATS_QUEUE, PACKAGE_QUEUE } from "@/lib/queues";
import { Card, EmptyState, SectionHeading, fmtDateTime } from "../ui";
import { PauseControl, AutosendControl } from "./ControlToggles";
import RunNow from "./RunNow";

export const dynamic = "force-dynamic";

type LastRun = { name: string; last_completed: string | null };
type Failure = { name: string; created_on: string; error: string | null };

// Worker health, read straight from pg-boss's own tables (v12 keeps completed/
// failed jobs in pgboss.job ~7 days — there's no archive table). Degrades to a
// clear message if the schema isn't there yet (worker never booted).
async function getWorkerHealth(): Promise<{
  ok: boolean;
  lastRuns: Record<string, string | null>;
  failures: Failure[];
  replyStaleMinutes: number | null;
  nowMs: number;
  error?: string;
}> {
  const nowMs = Date.now();
  try {
    const lastRows = (await db.execute(
      sql`select name, max(completed_on) as last_completed from pgboss.job where state = 'completed' group by name`
    )) as unknown as LastRun[];
    const lastRuns: Record<string, string | null> = {};
    for (const row of lastRows) if ((ALL_QUEUES as readonly string[]).includes(row.name)) lastRuns[row.name] = row.last_completed;

    const failRows = (await db.execute(
      sql`select name, created_on,
                 coalesce(output->>'message', output->'value'->>'message') as error
          from pgboss.job
          where state = 'failed' and created_on > now() - interval '7 days'
            and name in (${sql.join(ALL_QUEUES.map((q) => sql`${q}`), sql`, `)})
          order by completed_on desc nulls last
          limit 20`
    )) as unknown as Failure[];

    // reply-cycle runs every ~4 min; if its last completion is >10 min old (or
    // never), the worker is probably down.
    const replyLast = lastRuns[REPLY_QUEUE];
    const replyStaleMinutes = replyLast ? Math.floor((nowMs - new Date(replyLast).getTime()) / 60000) : null;

    return { ok: true, lastRuns, failures: failRows, replyStaleMinutes, nowMs };
  } catch (err) {
    return {
      ok: false,
      lastRuns: {},
      failures: [],
      replyStaleMinutes: null,
      nowMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const QUEUE_LABELS: Record<string, string> = {
  [SOURCE_QUEUE]: "Source leads",
  "enrich-restaurant": "Enrich restaurant",
  [SEND_QUEUE]: "Send outreach (draft + send)",
  [REPLY_QUEUE]: "Reply cycle (poll + bump + Touch 2)",
  "process-package": "Process orders",
  [STATS_QUEUE]: "Weekly stats",
};

const RUN_QUEUES = [
  { queue: SOURCE_QUEUE, label: "Source leads", hint: "Find + enrich new restaurants now (needs Google Maps + NeverBounce keys)." },
  { queue: SEND_QUEUE, label: "Draft + send Touch 1", hint: "Compose today's drafts (and send approved ones, if enabled)." },
  { queue: REPLY_QUEUE, label: "Check replies", hint: "Poll Gmail, send the bump + approved Touch 2s." },
  { queue: PACKAGE_QUEUE, label: "Process paid orders", hint: "Run the Claid first pass on paid packages + retry failed self-serve orders." },
  { queue: STATS_QUEUE, label: "Weekly report", hint: "Email the pipeline summary now." },
];

function staleness(nowMs: number, iso: string | undefined): string {
  if (!iso) return "";
  const mins = Math.floor((nowMs - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default async function ControlsPage() {
  const [{ values, updatedAt }, health] = await Promise.all([getAllSettings(), getWorkerHealth()]);
  const boot = values.worker_boot_info;

  return (
    <div className="flex flex-col gap-10">
      {/* Toggles */}
      <section className="flex flex-col gap-4">
        <SectionHeading>Controls</SectionHeading>
        <PauseControl paused={values.outreach_paused} />
        <AutosendControl autosend={values.outreach_autosend} />
      </section>

      {/* Worker health */}
      <section>
        <SectionHeading>Worker health</SectionHeading>
        {!health.ok ? (
          <EmptyState>pg-boss tables not found — the worker has never initialized. Boot it once, then refresh.</EmptyState>
        ) : (
          <>
            {(health.replyStaleMinutes === null || health.replyStaleMinutes > 10) && (
              <div className="mt-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
                Worker may be down — the reply cycle (every ~4 min) last completed{" "}
                {health.replyStaleMinutes === null ? "never" : `${health.replyStaleMinutes} min ago`}.
              </div>
            )}
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[32rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500">
                    <th className="px-3 py-2 font-semibold">Queue</th>
                    <th className="px-3 py-2 font-semibold">Last completed</th>
                  </tr>
                </thead>
                <tbody>
                  {ALL_QUEUES.map((q) => (
                    <tr key={q} className="border-b border-stone-100">
                      <td className="px-3 py-2 font-medium">{QUEUE_LABELS[q] ?? q}</td>
                      <td className="px-3 py-2 tabular-nums text-stone-600">
                        {health.lastRuns[q] ? staleness(health.nowMs, health.lastRuns[q]!) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="mt-6 text-sm font-semibold text-stone-700">Recent failures (7 days)</h3>
            {health.failures.length === 0 ? (
              <p className="mt-2 text-sm text-stone-500">None — everything has run clean.</p>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                {health.failures.map((f, i) => (
                  <div key={i} className="rounded-lg border border-red-100 bg-red-50 p-3 text-sm">
                    <span className="font-medium text-red-800">{QUEUE_LABELS[f.name] ?? f.name}</span>
                    <span className="ml-2 text-xs text-stone-500">{fmtDateTime(new Date(f.created_on))}</span>
                    <div className="mt-1 text-stone-700">{f.error ?? "(no error message)"}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* Worker boot info */}
      <section>
        <SectionHeading>Worker config (last boot)</SectionHeading>
        {!boot ? (
          <EmptyState>The worker hasn&apos;t reported in yet.</EmptyState>
        ) : (
          <Card className="mt-3">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              <Row label="Sending enabled (OUTREACH_ENABLED)" value={boot.outreachEnabled ? "yes" : "no"} />
              <Row label="Dry run" value={boot.dryRun ? "yes" : "no"} />
              <Row label="Daily ramp" value={`${boot.ramp.start} → ${boot.ramp.cap} (+${boot.ramp.step}/day)`} />
              <Row label="Cities" value={boot.cities.join(", ")} />
              <Row label="Send cron" value={boot.crons.send} />
              <Row label="Reply-poll cron" value={boot.crons.replyPoll} />
            </dl>
            <p className="mt-3 text-xs text-stone-500">
              This is the WORKER service&apos;s env as of its last boot ({staleness(health.nowMs, updatedAt.worker_boot_info?.toISOString())}). Restart the worker after changing its Railway env to refresh.
            </p>
          </Card>
        )}
      </section>

      {/* Run now */}
      <section>
        <SectionHeading>Run now</SectionHeading>
        <div className="mt-3">
          <RunNow queues={RUN_QUEUES} autosendOn={values.outreach_autosend} />
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-stone-100 py-1">
      <dt className="text-stone-500">{label}</dt>
      <dd className="text-right font-medium text-stone-900">{value}</dd>
    </div>
  );
}
