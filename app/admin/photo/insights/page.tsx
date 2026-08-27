import { desc } from "drizzle-orm";
import { db } from "@/db";
import { pipelineNightSnapshots } from "@/db/schema";
import { SectionHeading, EmptyState, Funnel } from "../../ui";
import {
  deriveNightFindings,
  derivePatterns,
  yieldPct,
  EMAIL_READY_TARGET,
  type NightSession,
  type Insight,
} from "@/lib/pipelineHealth";

// The Insights tab: a scrollable history of each night's pipeline session,
// read from the FROZEN pipeline_night_snapshots (written the morning after by
// worker/jobs/snapshotNight.ts). Findings + cross-night patterns are derived
// on read from the frozen numbers — deterministic, no API cost. The Overview
// briefing answers "did anything break last night?"; this answers "how has the
// pipeline been doing, and what patterns are forming?"
export const dynamic = "force-dynamic";

// Snapshot row -> the NightSession shape the derive helpers expect. The columns
// line up 1:1; only the jsonb fields need a cast.
type SnapshotRow = typeof pipelineNightSnapshots.$inferSelect;
function toSession(r: SnapshotRow): NightSession {
  return {
    night: r.night,
    sourced: r.sourced,
    freeFiltered: r.freeFiltered,
    reachedEnrichment: r.reachedEnrichment,
    gateRejected: r.gateRejected,
    emailReady: r.emailReady,
    contacted: r.contacted,
    needsManualEmail: r.needsManualEmail,
    callList: r.callList,
    siteHavers: r.siteHavers,
    siteGotEmail: r.siteGotEmail,
    nightlyCap: r.nightlyCap,
    rejectionBuckets: (r.rejectionBuckets as { bucket: string; n: number }[]) ?? [],
    anomalies: (r.anomalies as string[]) ?? [],
  };
}

const TONE_COLOR: Record<Insight["tone"], string> = {
  good: "var(--teal)",
  warn: "var(--gold)",
  bad: "var(--coral)",
  neutral: "var(--c-text-muted)",
};
const TONE_MARK: Record<Insight["tone"], string> = { good: "▲", warn: "△", bad: "⚠", neutral: "·" };

function InsightLine({ insight }: { insight: Insight }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="mt-0.5 shrink-0 text-xs" style={{ color: TONE_COLOR[insight.tone] }} aria-hidden>
        {TONE_MARK[insight.tone]}
      </span>
      <span style={{ color: insight.tone === "neutral" ? "var(--c-text-muted)" : TONE_COLOR[insight.tone] }}>{insight.text}</span>
    </div>
  );
}

export default async function InsightsPage() {
  const rows = await db.select().from(pipelineNightSnapshots).orderBy(desc(pipelineNightSnapshots.night)).limit(30);
  const sessions = rows.map(toSession);
  const patterns = derivePatterns(sessions);

  return (
    <>
      <div className="max-w-2xl">
        <SectionHeading>Insights</SectionHeading>
        <p className="mt-2 text-sm text-muted">
          Every night&apos;s pipeline session, frozen the morning after and compiled with the key findings and patterns —
          so you can see how sourcing, gates, and email discovery are trending without re-deriving it each day.
        </p>
      </div>

      {sessions.length === 0 ? (
        <EmptyState>
          No snapshots yet. They&apos;re written automatically the morning after each run — or trigger one now from
          Controls → &ldquo;Snapshot last night&rdquo;.
        </EmptyState>
      ) : (
        <>
          {/* Cross-night patterns. */}
          {patterns.length > 0 && (
            <section className="mt-8">
              <div className="rounded-xl border border-line bg-surface p-5">
                <div className="font-mono-label mb-3 text-[10.5px] uppercase tracking-wider text-faint">
                  Patterns · last {Math.min(sessions.length, 7)} nights
                </div>
                <div className="flex flex-col gap-2">
                  {patterns.map((p, i) => (
                    <InsightLine key={i} insight={p} />
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* Per-night sessions, newest first. */}
          <section className="mt-8 flex flex-col gap-4">
            {sessions.map((s) => {
              const findings = deriveNightFindings(s);
              const y = yieldPct(s);
              const hit = s.emailReady >= EMAIL_READY_TARGET;
              return (
                <div key={s.night} className="rounded-xl border border-line bg-surface p-5">
                  {/* header */}
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <div className="flex items-baseline gap-3">
                      <h3 className="font-mono-label text-sm font-semibold tabular-nums text-text">{s.night}</h3>
                      {s.anomalies.length > 0 && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[11px] font-semibold"
                          style={{ background: "color-mix(in oklch, var(--coral) 14%, var(--card))", color: "var(--coral)" }}
                        >
                          {s.anomalies.length} anomaly{s.anomalies.length > 1 ? " flags" : " flag"}
                        </span>
                      )}
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-mono-label text-2xl font-semibold tabular-nums" style={{ color: hit ? "var(--teal)" : "var(--gold)" }}>
                        {s.emailReady}
                      </span>
                      <span className="text-xs text-faint">/ {EMAIL_READY_TARGET} email-ready</span>
                    </div>
                  </div>

                  {/* funnel */}
                  <div className="mt-4">
                    <Funnel
                      steps={[
                        { label: "Sourced", value: s.sourced },
                        { label: "Reached enrichment", value: s.reachedEnrichment },
                        { label: "Email-ready", value: s.emailReady },
                      ]}
                    />
                  </div>

                  {/* secondary stats */}
                  <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
                    <span>
                      Yield <span className="font-mono-label font-semibold text-text">{y != null ? `${y}%` : "—"}</span>
                      <span className="text-faint"> ({s.siteGotEmail}/{s.siteHavers})</span>
                    </span>
                    <span>
                      Needs-email <span className="font-mono-label text-text">{s.needsManualEmail}</span>
                    </span>
                    <span>
                      Call-list <span className="font-mono-label text-text">{s.callList}</span>
                    </span>
                    <span>
                      Gate-rejected <span className="font-mono-label text-text">{s.gateRejected}</span>
                    </span>
                    {s.nightlyCap != null && (
                      <span className="text-faint">
                        cap <span className="font-mono-label">{s.nightlyCap}</span>
                      </span>
                    )}
                  </div>

                  {/* rejection buckets */}
                  {s.rejectionBuckets.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {s.rejectionBuckets.slice(0, 5).map((b) => (
                        <span key={b.bucket} className="rounded bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
                          {b.bucket} <span className="font-mono-label tabular-nums text-text">{b.n}</span>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* findings */}
                  <div className="mt-4 flex flex-col gap-1.5 border-t border-line pt-3">
                    {findings.map((f, i) => (
                      <InsightLine key={i} insight={f} />
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        </>
      )}
    </>
  );
}
