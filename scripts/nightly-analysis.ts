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
import { getSetting } from "@/lib/settings";
import { classifyWebsite } from "@/worker/lib/websitePlatform";
import { calibrationReport, type CalibrationLead, type Decision } from "@/worker/lib/calibration";

const arg = Number(process.argv[2]);
const nights = Number.isFinite(arg) && arg > 0 ? Math.floor(arg) : 10;

// created_at is a naive UTC timestamp; bucket it in AST so a night lines up with
// the calendar day you'd call "last night" (the 02:17 UTC cron = 22:17 AST prior
// evening). Shared by every date-bucketed query below.
const AST_DAY = sql`date_trunc('day', (created_at at time zone 'UTC') at time zone 'America/Puerto_Rico')`;
const rows = <T>(r: unknown) => r as T[];
const hr = (s: string) => console.log(`\n${"─".repeat(72)}\n  ${s}\n${"─".repeat(72)}`);

// ── 1. Run health ──────────────────────────────────────────────────────────
hr("1 · RUN HEALTH");
const boot = (await getSetting("worker_boot_info")) as
  | { bootedAt?: string; nightlyEnrichCap?: number; cities?: string[]; outreachEnabled?: boolean }
  | null;
if (boot?.bootedAt) {
  const ageH = ((Date.now() - Date.parse(boot.bootedAt)) / 3_600_000).toFixed(1);
  console.log(`  worker booted:      ${boot.bootedAt} (${ageH}h ago)`);
  console.log(`  nightly cap:        ${boot.nightlyEnrichCap ?? "(not recorded)"}`);
  console.log(`  cities:             ${boot.cities?.length ?? "?"}   outreach: ${boot.outreachEnabled ? "ENABLED" : "off"}`);
} else {
  console.log("  ⚠ no worker boot info — the worker may never have started.");
}

// Live API check — a depleted balance / usage cap silently disables both quality
// gates (they fail open), which is the #1 cause of a poisoned night (see §8).
try {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  await c.messages.create({ model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "ok" }] });
  console.log("  Anthropic API:      ✓ reachable");
} catch (e: unknown) {
  const msg = (e as { message?: string })?.message ?? String(e);
  console.log(`  Anthropic API:      ✗ FAILING — gates are running blind: ${msg.slice(0, 90)}`);
}

// ── 2. Email-ready trend ───────────────────────────────────────────────────
hr(`2 · EMAIL-READY (queued) PER NIGHT — last ${nights} nights, AST`);
type TrendRow = { night: string; sourced: number; queued: number; needs: number; call: number; rej: number };
const trend = rows<TrendRow>(
  await db.execute(sql`
    select to_char(${AST_DAY}, 'YYYY-MM-DD (Dy)') as night,
      count(*)::int as sourced,
      -- email-ready = ever reached a verified email. A lead that got EMAILED
      -- moves queued -> contacted, so counting only 'queued' made the number
      -- SHRINK as leads succeeded once the send cron went live. Both count.
      count(*) filter (where enrichment_status in ('queued','contacted'))::int as queued,
      count(*) filter (where enrichment_status='needs_manual_email')::int as needs,
      count(*) filter (where enrichment_status='call_list')::int as call,
      count(*) filter (where enrichment_status='rejected')::int as rej
    from restaurants
    where created_at > now() - (${nights} * interval '1 day')
    group by 1 order by 1 desc`)
);
console.log("  night              sourced  EMAIL-READY  needs-email  call-list  rejected");
for (const r of trend) {
  console.log(
    "  " + r.night.padEnd(18) + String(r.sourced).padStart(6) + String(r.queued).padStart(13) +
      String(r.needs).padStart(13) + String(r.call).padStart(11) + String(r.rej).padStart(10)
  );
}
const runNights = trend.filter((r) => r.sourced > 0);
const avgReady = runNights.length ? runNights.reduce((a, r) => a + r.queued, 0) / runNights.length : 0;
console.log(`\n  avg email-ready / run night: ${avgReady.toFixed(1)}  (target 20, over ${runNights.length} run nights)`);

// ── 3. Last night deep-dive ────────────────────────────────────────────────
// The most recent AST day that actually sourced anything.
const [lastNight] = rows<{ d: string }>(
  await db.execute(sql`
    select to_char(${AST_DAY}, 'YYYY-MM-DD') as d
    from restaurants group by 1 having count(*) > 0 order by 1 desc limit 1`)
);
const NIGHT = lastNight?.d ?? "1970-01-01";
const inNight = sql`(created_at at time zone 'UTC') at time zone 'America/Puerto_Rico' >= ${NIGHT}::date
  and (created_at at time zone 'UTC') at time zone 'America/Puerto_Rico' < (${NIGHT}::date + interval '1 day')`;

hr(`3 · LAST NIGHT (${NIGHT} AST) — the funnel`);
const [f] = rows<Record<string, number>>(
  await db.execute(sql`
    select
      count(*)::int as sourced,
      count(*) filter (where rejection_reason like 'Hard filter:%')::int as free_filtered,
      count(*) filter (where enrichment_status='rejected' and rejection_reason not like 'Hard filter:%')::int as gate_rejected,
      count(*) filter (where enrichment_status in ('queued','contacted'))::int as queued,
      count(*) filter (where enrichment_status='contacted')::int as contacted,
      count(*) filter (where enrichment_status='needs_manual_email')::int as needs_email,
      count(*) filter (where enrichment_status='call_list')::int as call_list,
      count(*) filter (where website is not null)::int as with_site
    from restaurants where ${inNight}`)
);
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
const rejBuckets = rows<{ bucket: string; n: number }>(
  await db.execute(sql`
    select case
      when rejection_reason like 'Hard filter: only%' or rejection_reason like 'Hard filter: no review%' then 'too few reviews'
      when rejection_reason like '%established destination%' then 'over review ceiling'
      when rejection_reason like 'Hard filter: price%' then 'too expensive'
      when rejection_reason like 'Hard filter: business status%' then 'closed'
      when rejection_reason like '%chain%' or rejection_reason like '%hospitality group%' then 'chain / group'
      when rejection_reason like '%professional photography%' then 'already has pro photos'
      when rejection_reason like 'Hard filter:%' then 'other hard filter'
      else 'other' end as bucket,
      count(*)::int as n
    from restaurants where ${inNight} and enrichment_status='rejected'
    group by 1 order by 2 desc`)
);
for (const r of rejBuckets) console.log(`  ${String(r.n).padStart(4)}  ${r.bucket}`);
if (rejBuckets.length === 0) console.log("  (no rejections last night)");

// ── 5. Email-discovery yield ───────────────────────────────────────────────
hr("5 · EMAIL YIELD — of leads WITH a website, how many got a verified email");
const yieldRows = rows<{ night: string; sites: number; emails: number }>(
  await db.execute(sql`
    select to_char(${AST_DAY}, 'MM-DD') as night,
      -- website-havers that finished as an email decision: got an email
      -- (queued/contacted) or had a site but none found (needs_manual_email).
      count(*) filter (where website is not null and enrichment_status in ('queued','contacted','needs_manual_email'))::int as sites,
      count(*) filter (where enrichment_status in ('queued','contacted'))::int as emails
    from restaurants
    where created_at > now() - (${Math.min(nights, 7)} * interval '1 day')
    group by 1 order by 1 desc`)
);
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
const flags: string[] = [];
// Gate-2 failed open: a RICH band with no pro-score means the Vision call
// didn't happen — the whole reason 24 leads went unscreened on 2026-08-24.
// `unclear` is deliberately EXCLUDED here since 2026-08-25 (photoFit.ts): Gate
// 2 now skips `unclear` by design (decidePhotoFit can never reject anything
// but `rich`, so scoring unclear was pure spend with no effect on any
// decision) — every unclear lead has a null pro-score on purpose now, and
// counting them here would flag normal operation as an outage every single
// night forever.
const [g2] = rows<{ n: number }>(
  await db.execute(sql`
    select count(*)::int as n from restaurants
    where ${inNight} and website_photo_band = 'rich' and website_pro_score is null`)
);
if (g2?.n > 0) flags.push(`Gate-2 (Vision) skipped on ${g2.n} rich-band lead(s) last night — likely an API outage; those leads were NOT photo-screened (this can't reject them into a decision, but it means they were never actually judged).`);
// Chain check failed open: a full run with zero chain/group rejections is
// suspicious (a normal night rejects several).
const [cc] = rows<{ n: number }>(
  await db.execute(sql`select count(*) filter (where rejection_reason ilike '%hospitality group%')::int as n from restaurants where ${inNight}`)
);
if (f && f.sourced >= 40 && cc?.n === 0) flags.push(`0 chain/group rejections on a ${f.sourced}-lead run — the chain check may have been down (a normal run rejects several).`);
// Suspiciously high email-ready rate (gates letting everything through).
if (f && f.sourced >= 40 && f.queued / f.sourced > 0.4) flags.push(`Email-ready rate ${((f.queued / f.sourced) * 100).toFixed(0)}% is abnormally high — gates may have failed open; verify before trusting the queue.`);
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
