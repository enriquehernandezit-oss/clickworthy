import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { outreachJobs } from "@/db/schema";
import { getAllSettings } from "@/lib/settings";
import { getDeliverability } from "@/lib/photoStats";
import { dailyCap, sentToday } from "@/worker/jobs/sendOutreach";
import { describeSendWindow } from "@/worker/lib/sendWindow";
import { ALL_QUEUES, SOURCE_QUEUE, SEND_QUEUE, REPLY_QUEUE, STATS_QUEUE, PACKAGE_QUEUE, SOURCING_REPORT_QUEUE } from "@/lib/queues";
import { Card, EmptyState, SectionHeading, fmtDateTime } from "../../ui";
import { PauseControl, AutosendControl, NumberSetting } from "./ControlToggles";
import RunNow from "./RunNow";

// Approved-but-unsent Touch 1 + bump rows — the pile actually waiting on the
// send window (not drafts, which still need approval first).
async function getSendState() {
  const [{ pending }] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${outreachJobs.status} = 'approved' and ${outreachJobs.kind} in ('touch1','bump'))::int`,
    })
    .from(outreachJobs)
    .where(isNull(outreachJobs.sentAt));
  const [cap, sent] = await Promise.all([dailyCap(), sentToday()]);
  return { pending: pending ?? 0, cap, sent, remaining: Math.max(0, cap - sent) };
}

export const dynamic = "force-dynamic";

type LastRun = { name: string; last_completed: string | null };
type Depth = { name: string; state: string; n: number };
type Failure = { name: string; created_on: string; error: string | null };

// Worker health, read straight from pg-boss's own tables (v12 keeps completed/
// failed jobs in pgboss.job ~7 days — there's no archive table). Degrades to a
// clear message if the schema isn't there yet (worker never booted).
async function getWorkerHealth(): Promise<{
  ok: boolean;
  lastRuns: Record<string, string | null>;
  depth: Record<string, { created: number; active: number; retry: number }>;
  failures: Failure[];
  replyStaleMinutes: number | null;
  nowMs: number;
  error?: string;
}> {
  const nowMs = Date.now();
  const emptyDepth: Record<string, { created: number; active: number; retry: number }> = {};
  try {
    const lastRows = (await db.execute(
      sql`select name, max(completed_on) as last_completed from pgboss.job where state = 'completed' group by name`
    )) as unknown as LastRun[];
    const lastRuns: Record<string, string | null> = {};
    for (const row of lastRows) if ((ALL_QUEUES as readonly string[]).includes(row.name)) lastRuns[row.name] = row.last_completed;

    // Queue depth per state — jobs waiting to start (created), currently
    // running (active), and awaiting retry after failure (retry). Depth > 0 on
    // 'created' means the worker is behind or stopped; 'retry' means Claid/
    // Gmail is failing on real jobs.
    const depthRows = (await db.execute(
      sql`select name, state, count(*)::int as n
          from pgboss.job
          where state in ('created','active','retry')
            and name in (${sql.join(ALL_QUEUES.map((q) => sql`${q}`), sql`, `)})
          group by name, state`
    )) as unknown as Depth[];
    const depth = { ...emptyDepth };
    for (const r of depthRows) {
      depth[r.name] ??= { created: 0, active: 0, retry: 0 };
      (depth[r.name] as Record<string, number>)[r.state] = r.n;
    }

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

    return { ok: true, lastRuns, depth, failures: failRows, replyStaleMinutes, nowMs };
  } catch (err) {
    return {
      ok: false,
      lastRuns: {},
      depth: emptyDepth,
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
  [SOURCING_REPORT_QUEUE]: "Nightly sourcing report",
};

const RUN_QUEUES = [
  { queue: SOURCE_QUEUE, label: "Source leads", hint: "Find + enrich new restaurants now (needs Google Maps + NeverBounce keys)." },
  { queue: SEND_QUEUE, label: "Draft + send Touch 1", hint: "Compose today's drafts (and send approved ones, if enabled)." },
  { queue: REPLY_QUEUE, label: "Check replies", hint: "Poll Gmail, send the bump + approved Touch 2s." },
  { queue: PACKAGE_QUEUE, label: "Process paid orders", hint: "Run the Claid first pass on paid packages + retry failed self-serve orders." },
  { queue: STATS_QUEUE, label: "Weekly report", hint: "Email the pipeline summary now." },
  { queue: SOURCING_REPORT_QUEUE, label: "Nightly sourcing report", hint: "Email the sourcing/enrichment health summary now." },
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
  const [{ values, updatedAt }, health, deliverability, sendState] = await Promise.all([
    getAllSettings(),
    getWorkerHealth(),
    getDeliverability(),
    getSendState(),
  ]);
  const boot = values.worker_boot_info;

  return (
    <div className="flex flex-col gap-10">
      {/* Toggles */}
      <section className="flex flex-col gap-4">
        <SectionHeading>Controls</SectionHeading>
        <p className="-mt-2 max-w-2xl text-sm text-muted">
          Two separate gates, in this order: <strong>Approval mode</strong> decides whether a new draft needs your
          click before it&apos;s approved at all. <strong>Pause/Resume</strong> decides whether something
          already approved is allowed to actually leave. Pausing never approves or skips your review — it only
          holds the door shut on sends that already passed it.
        </p>
        <PauseControl paused={values.outreach_paused} />
        <AutosendControl autosend={values.outreach_autosend} />
        <NumberSetting
          settingKey="outreach_daily_cap"
          label="Daily send cap"
          help="How many Touch-1 emails go out each day. Leave empty to use the auto-ramp (30 → 50 over ~a month) or set a fixed cap."
          value={values.outreach_daily_cap}
          nullable
          suffix="/ day"
          formulaHint={boot ? `${boot.ramp.start} → ${boot.ramp.cap} auto-ramp` : "auto-ramp"}
        />
        <NumberSetting
          settingKey="bump_after_days"
          label="Days before the Touch 1.5 bump"
          help="How many days after Touch 1 a no-reply gets the one-time bump."
          value={values.bump_after_days}
          nullable={false}
          suffix="days"
        />
        <NumberSetting
          settingKey="outreach_daily_draft_target"
          label="Daily draft target"
          help="How many NEW Touch 1 drafts the nightly job stages for review (manual-approval mode). Autosend paces to the send cap instead."
          value={values.outreach_daily_draft_target}
          nullable={false}
          suffix="/ day"
        />
      </section>

      {/* Deliverability guard */}
      <section>
        <SectionHeading>Deliverability guard</SectionHeading>
        <div
          className="mt-3 rounded-xl border p-4"
          style={{
            background: deliverability.healthy ? "var(--card)" : "var(--coral-soft)",
            borderColor: deliverability.healthy ? "var(--line)" : "var(--coral)",
          }}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="font-display text-sm font-semibold" style={{ color: deliverability.healthy ? "var(--c-text)" : "var(--coral)" }}>
              {deliverability.healthy
                ? deliverability.sampleReached
                  ? "Healthy — well below the pause threshold"
                  : "No verdict yet — not enough sends this week"
                : "Auto-paused — opt-out/bounce rate above the threshold"}
            </div>
            <div className="font-mono-label text-[11px] uppercase tracking-wider" style={{ color: "var(--c-text-muted)" }}>
              7-day sample
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-6 text-sm" style={{ color: "var(--c-text-muted)" }}>
            <span><span className="font-semibold tabular-nums text-[var(--c-text)]">{deliverability.sends}</span> sends</span>
            <span><span className="font-semibold tabular-nums text-[var(--c-text)]">{deliverability.suppressions}</span> new suppressions</span>
            <span>
              <span className="font-semibold tabular-nums text-[var(--c-text)]">
                {deliverability.rate === null ? "—" : `${(deliverability.rate * 100).toFixed(1)}%`}
              </span>{" "}
              rate <span className="text-xs">(pause at 8% once 20+ sends)</span>
            </span>
          </div>
          {!deliverability.healthy && (
            <p className="mt-2 text-xs" style={{ color: "var(--coral)" }}>
              The send job will skip until the rate drops. Review the recent suppressions and the copy before resuming.
            </p>
          )}
        </div>
      </section>

      {/* Send window — why an approved email might be waiting */}
      <section>
        <SectionHeading>Send window</SectionHeading>
        <div className="mt-3 rounded-xl border p-4" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
          <div className="font-display text-sm font-semibold" style={{ color: "var(--c-text)" }}>
            {describeSendWindow()}
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--c-text-muted)" }}>
            Approved emails only leave during the recipient&apos;s local business hours — a Miami lead sends on Eastern
            time, a Los Angeles lead on Pacific. Outside the window an approved draft simply waits; it isn&apos;t lost.
            Weekends are skipped.
          </p>
          <div className="mt-3 flex flex-wrap gap-6 text-sm" style={{ color: "var(--c-text-muted)" }}>
            <span>
              <span className="font-semibold tabular-nums text-[var(--c-text)]">{sendState.pending}</span> approved, waiting to send
            </span>
            <span>
              <span className="font-semibold tabular-nums text-[var(--c-text)]">{sendState.sent}</span> sent today
            </span>
            <span>
              <span className="font-semibold tabular-nums text-[var(--c-text)]">{sendState.remaining}</span> of {sendState.cap} daily cap remaining
            </span>
          </div>
        </div>
      </section>

      {/* Worker health */}
      <section>
        <SectionHeading>Worker health</SectionHeading>
        {!health.ok ? (
          <EmptyState>pg-boss tables not found — the worker has never initialized. Boot it once, then refresh.</EmptyState>
        ) : (
          <>
            {(health.replyStaleMinutes === null || health.replyStaleMinutes > 10) && (
              <div className="mt-3 rounded-lg border px-4 py-3 text-sm font-medium text-coral" style={{ borderColor: "var(--coral)", background: "var(--coral-soft)" }}>
                Worker may be down — the reply cycle (every ~4 min) last completed{" "}
                {health.replyStaleMinutes === null ? "never" : `${health.replyStaleMinutes} min ago`}.
              </div>
            )}
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-faint">
                    <th scope="col" className="px-3 py-2 font-semibold">Queue</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Last completed</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Depth (waiting · running · retry)</th>
                  </tr>
                </thead>
                <tbody>
                  {ALL_QUEUES.map((q) => {
                    const d = health.depth[q];
                    const backed = d ? d.created + d.active + d.retry : 0;
                    return (
                    <tr key={q} className="border-b border-line">
                      <td className="px-3 py-2 font-medium">{QUEUE_LABELS[q] ?? q}</td>
                      <td className="px-3 py-2 tabular-nums text-muted">
                        {health.lastRuns[q] ? staleness(health.nowMs, health.lastRuns[q]!) : "—"}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-muted">
                        {backed === 0 ? (
                          <span style={{ color: "var(--c-text-faint)" }}>—</span>
                        ) : (
                          <>
                            <span className={d && d.created > 0 ? "font-semibold text-gold" : ""}>{d?.created ?? 0}</span>
                            {" · "}
                            <span>{d?.active ?? 0}</span>
                            {" · "}
                            <span className={d && d.retry > 0 ? "font-semibold text-coral" : ""}>{d?.retry ?? 0}</span>
                          </>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <h3 className="mt-6 text-sm font-semibold text-text">Recent failures (7 days)</h3>
            {health.failures.length === 0 ? (
              <p className="mt-2 text-sm text-faint">None — everything has run clean.</p>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                {health.failures.map((f, i) => (
                  <div key={i} className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--coral)", background: "var(--coral-soft)" }}>
                    <span className="font-medium text-coral">{QUEUE_LABELS[f.name] ?? f.name}</span>
                    <span className="ml-2 text-xs text-faint">{fmtDateTime(new Date(f.created_on))}</span>
                    <div className="mt-1 text-text">{f.error ?? "(no error message)"}</div>
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
            <p className="mt-3 text-xs text-faint">
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
    <div className="flex justify-between gap-4 border-b border-line py-1">
      <dt className="text-faint">{label}</dt>
      <dd className="text-right font-medium text-text">{value}</dd>
    </div>
  );
}
