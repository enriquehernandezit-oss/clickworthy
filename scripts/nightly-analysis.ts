// The one-command nightly diagnostic. Everything you'd want to know about how
// the pipeline is performing, in one paste — built to be run and handed to
// Claude (or skimmed directly) so parameter changes are made from data, not
// vibes. READ-ONLY: computes and prints, never writes. Recommends; never
// auto-applies (at current volume that would chase noise — see the calibration
// section's own floor).
//
//   bun run scripts/nightly-analysis.ts          # last 10 nights of trend + last night deep-dive
//   bun run scripts/nightly-analysis.ts 21        # custom trend lookback in nights
//
// Sections:
//   1  Run health        — did last night's cron fire, on what cap, is the API alive
//   2  Email-ready trend — queued/night, the priority metric, over time
//   3  Last night        — the full funnel + status split for the most recent run
//   4  Why leads died    — rejection reasons, bucketed
//   5  Email yield       — of leads WITH a website, how many got a verified email
//   6  Website prospects — platform-tier mix for the website product
//   7  Spend             — real per-driver API cost, all-time
//   8  Anomalies         — outage signatures (gates failing open) + other red flags
//   9  Calibration       — the photo-fit feedback loop vs your approve/skip taste
//  10  Outcomes          — sent / replied (the real learning signal, once volume builds)

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { classifyWebsite } from "@/worker/lib/websitePlatform";
import { calibrationReport, type CalibrationLead, type Decision } from "@/worker/lib/calibration";
import {
  getRunHealth,
  checkAnthropicReachable,
  getEmailReadyTrend,
  avgEmailReady,
  getLastSourcingNight,
  getNightFunnel,
  getRejectionBuckets,
  getEmailYield,
  getAnomalies,
  EMAIL_READY_TARGET,
} from "@/lib/pipelineHealth";

const arg = Number(process.argv[2]);
const nights = Number.isFinite(arg) && arg > 0 ? Math.floor(arg) : 10;

// created_at is a naive UTC timestamp; bucket it in AST so a night lines up with
// the calendar day you'd call "last night". Shared by the §6/§7/§9 queries that
// still live inline here (§1–5 + §8 now come from lib/pipelineHealth.ts).
const AST_DAY = sql`date_trunc('day', (created_at at time zone 'UTC') at time zone 'America/Puerto_Rico')`;
const rows = <T>(r: unknown) => r as T[];
const hr = (s: string) => console.log(`\n${"─".repeat(72)}\n  ${s}\n${"─".repeat(72)}`);

// ── 1. Run health ──────────────────────────────────────────────────────────
hr("1 · RUN HEALTH");
const health = await getRunHealth(Date.now());
if (health.bootedAt) {
  console.log(`  worker booted:      ${health.bootedAt} (${health.ageHours!.toFixed(1)}h ago)`);
  console.log(`  nightly cap:        ${health.nightlyCap ?? "(not recorded)"}`);
  console.log(`  cities:             ${health.cities ?? "?"}   outreach: ${health.outreachEnabled ? "ENABLED" : "off"}`);
} else {
  console.log("  ⚠ no worker boot info — the worker may never have started.");
}
const reach = await checkAnthropicReachable();
if (reach.ok) console.log("  Anthropic API:      ✓ reachable");
else console.log(`  Anthropic API:      ✗ FAILING — gates are running blind: ${reach.message.slice(0, 90)}`);

// ── 2. Email-ready trend ───────────────────────────────────────────────────
hr(`2 · EMAIL-READY (queued) PER NIGHT — last ${nights} nights, AST`);
const trend = await getEmailReadyTrend(nights);
console.log("  night              sourced  EMAIL-READY  needs-email  call-list  rejected");
for (const r of trend) {
  console.log(
    "  " + r.night.padEnd(18) + String(r.sourced).padStart(6) + String(r.queued).padStart(13) +
      String(r.needs).padStart(13) + String(r.call).padStart(11) + String(r.rej).padStart(10)
  );
}
const { avg: avgReady, runNights: runNightCount } = avgEmailReady(trend);
console.log(`\n  avg email-ready / run night: ${avgReady.toFixed(1)}  (target ${EMAIL_READY_TARGET}, over ${runNightCount} run nights)`);

// ── 3. Last night deep-dive ────────────────────────────────────────────────
const NIGHT = (await getLastSourcingNight()) ?? "1970-01-01";

hr(`3 · LAST NIGHT (${NIGHT} AST) — the funnel`);
const f = await getNightFunnel(NIGHT);
if (f) {
  const reached = f.sourced - f.free_filtered;
  console.log(`  sourced                       ${f.sourced}`);
  console.log(`   ├─ killed by free filters    ${f.free_filtered}   (review count / price / denylist — $0)`);
  console.log(`   └─ reached paid enrichment   ${reached}`);
  console.log(`       ├─ rejected by gates     ${f.gate_rejected}   (photo-fit / chain check)`);
  console.log(`       ├─ EMAIL-READY           ${f.queued}   ← the metric  (${f.contacted} already emailed, ${f.queued - f.contacted} still queued)`);
  console.log(`       ├─ needs manual email    ${f.needs_email}   (has site, no address found)`);
  console.log(`       └─ call list             ${f.call_list}   (no website — phone only)`);
}

// ── 4. Rejection reasons ───────────────────────────────────────────────────
hr(`4 · WHY LEADS DIED — last night (${NIGHT}), bucketed`);
const rejBuckets = await getRejectionBuckets(NIGHT);
for (const r of rejBuckets) console.log(`  ${String(r.n).padStart(4)}  ${r.bucket}`);
if (rejBuckets.length === 0) console.log("  (no rejections last night)");

// ── 5. Email-discovery yield ───────────────────────────────────────────────
hr("5 · EMAIL YIELD — of leads WITH a website, how many got a verified email");
const yieldRows = await getEmailYield(nights);
console.log("  night   website-havers  got-email  hit-rate");
for (const r of yieldRows) {
  const rate = r.sites ? ((r.emails / r.sites) * 100).toFixed(0) + "%" : "—";
  console.log(`  ${r.night}   ${String(r.sites).padStart(13)}  ${String(r.emails).padStart(9)}  ${rate.padStart(8)}`);
}
console.log("  (this hit-rate is the real bottleneck — more sourcing can't fix a low number here)");

// ── 6. Website-product prospects ───────────────────────────────────────────
hr("6 · WEBSITE PROSPECTS — platform tiers (for the future website product)");
const wl = rows<{ name: string; website: string | null; band: string | null; reason: string | null }>(
  await db.execute(sql`
    select name, website, website_photo_band as band, rejection_reason as reason
    from restaurants
    where coalesce(suppressed,false)=false and coalesce(rejection_reason,'') not ilike '%professional photography%'`)
);
const tiers = new Map<string, number>();
for (const r of wl) {
  const c = classifyWebsite(r.website);
  if (!(c.tier !== "custom" || r.band === "sparse")) continue;
  tiers.set(c.tier, (tiers.get(c.tier) ?? 0) + 1);
}
for (const [t, n] of [...tiers].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${t}`);
console.log(`  ${String([...tiers.values()].reduce((a, b) => a + b, 0)).padStart(4)}  TOTAL prospects`);

// ── 7. Spend ───────────────────────────────────────────────────────────────
hr("7 · SPEND — real API cost drivers, all-time");
const [s] = rows<Record<string, number>>(
  await db.execute(sql`
    select
      count(*)::int as sourced,
      count(*) filter (where coalesce(rejection_reason,'') not like 'Hard filter:%')::int as reached,
      count(*) filter (where email is not null)::int as emailable,
      coalesce(sum(coalesce(photos_scored,0)),0)::int + count(*) filter (where website_pro_score is not null)::int as vision
    from restaurants`)
);
if (s) {
  const chain = s.emailable * 0.07; // chain check now runs on emailable leads only
  const vision = s.vision * 0.01; // vision + places photo fetch
  console.log(`  reached paid enrichment:  ${s.reached} of ${s.sourced} sourced`);
  console.log(`  chain checks (emailable): ~${s.emailable}  → ~$${chain.toFixed(2)}`);
  console.log(`  Vision calls:             ${s.vision}  → ~$${vision.toFixed(2)}`);
  console.log(`  Places search:            ~$1–12 (per call, not per lead)`);
  console.log(`  ── marginal API total:    ~$${(chain + vision + 6).toFixed(2)}  (+ ~$72/mo fixed subscriptions)`);
}

// ── 8. Anomaly detection ───────────────────────────────────────────────────
hr("8 · ANOMALIES — outage signatures & red flags");
const flags = await getAnomalies(NIGHT, f);
if (flags.length === 0) console.log("  ✓ none detected — last night's gates appear to have run normally.");
for (const fl of flags) console.log(`  ⚠ ${fl}`);

// ── 9. Calibration ─────────────────────────────────────────────────────────
hr("9 · PHOTO-FIT CALIBRATION — the gate vs your approve/skip taste");
const calRows = rows<{ id: number; band: string | null; proScore: number | null; status: string | null; held: boolean | null; reason: string | null }>(
  await db.execute(sql`
    select id, website_photo_band as band, website_pro_score as "proScore",
      enrichment_status as status, held, rejection_reason as reason
    from restaurants where website_photo_band is not null`)
);
const approved = new Set(
  rows<{ rid: number }>(
    await db.execute(sql`
      select distinct restaurant_id as rid from outreach_jobs
      where kind='touch1' and status in ('approved','sent')`)
  ).map((r) => r.rid)
);
const decide = (r: (typeof calRows)[number]): Decision => {
  if (r.status === "rejected" && /professional photography/i.test(r.reason ?? "")) return "gate_rejected";
  if (approved.has(r.id)) return "approved";
  if (r.held) return "skipped";
  return "pending";
};
const leads: CalibrationLead[] = calRows.map((r) => ({ band: (r.band as CalibrationLead["band"]) ?? null, proScore: r.proScore ?? null, decision: decide(r) }));
const cal = calibrationReport(leads);
console.log(`  labeled decisions (approved+skipped): ${cal.labeled}`);
console.log(`  >>> ${cal.recommendation}`);

// ── 10. Outcomes ───────────────────────────────────────────────────────────
hr("10 · OUTCOMES — the real learning signal (grows with volume)");
const [o] = rows<{ sent: number; replied: number }>(
  await db.execute(sql`
    select count(*) filter (where sent_at is not null)::int as sent,
      count(*) filter (where replied_at is not null)::int as replied
    from outreach_jobs where kind='touch1'`)
);
if (o) {
  const rate = o.sent ? ((o.replied / o.sent) * 100).toFixed(1) + "%" : "—";
  console.log(`  Touch 1 sent (all-time): ${o.sent}   replied: ${o.replied}   reply rate: ${rate}`);
  if (o.sent < 50) console.log(`  ⚠ ${o.sent} sends is too few to trust a reply rate — treat every number above as directional until this passes ~50-100.`);
}

console.log("\n" + "═".repeat(72));
console.log("  Hand this to Claude with 'analyze last night' for interpretation + parameter calls.");
console.log("═".repeat(72) + "\n");
process.exit(0);
