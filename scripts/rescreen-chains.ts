// Re-screen leads the LLM chain check rejected, against the CURRENT threshold.
//
// The bar has moved twice (worker/lib/anthropic.ts): "any 2nd location" ->
// "3+" -> "5+ locations, or a franchise / hotel outlet / corporate hospitality
// group". Leads rejected under an older, stricter prompt are still sitting as
// `rejected` even though they'd pass today — Raspados Don Manuel, three family
// raspados stands on a free Weebly page with 431 reviews, is the case that
// prompted the change.
//
//   bun run scripts/rescreen-chains.ts            # DRY RUN — verdicts only
//   bun run scripts/rescreen-chains.ts --commit   # apply (reuses cached verdicts)
//   bun run scripts/rescreen-chains.ts --refresh  # ignore the cache, re-ask
//
// Costs ~$0.07/lead (Claude + up to 3 web searches). Verdicts are CACHED to
// disk, so the usual dry-run-then-commit flow asks each question once instead
// of twice — the first version double-charged, and on a 55-lead pass that was
// ~$3.85 wasted. `--refresh` forces a fresh look when the threshold changes.
//
// Restored leads re-enter at the status their data supports: a verified email ->
// `queued`, a website but no email -> `needs_manual_email`, neither ->
// `call_list`. Leads the FREE denylist catches (worker/lib/chains.ts) are never
// re-checked — those are unambiguous national chains and stay rejected.

import { and, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { checkHospitalityGroup } from "@/worker/lib/anthropic";
import { isKnownChain } from "@/worker/lib/chains";

const commit = process.argv.includes("--commit");
const refresh = process.argv.includes("--refresh");

// Verdict cache. Keyed by restaurant id so a re-run only pays for leads it
// hasn't judged yet — including resuming a pass that died partway (the last run
// lost 6 leads to an out-of-credits error mid-flight and had nothing to show
// for the 48 it had already paid for). Lives outside the repo.
const CACHE_PATH = `${process.env.TMPDIR ?? "/tmp"}/clickworthy-rescreen-chains.json`;
type Cached = { keep: boolean; reasoning: string; owner: string | null };

async function loadCache(): Promise<Record<string, Cached>> {
  if (refresh) return {};
  try {
    return JSON.parse(await Bun.file(CACHE_PATH).text()) as Record<string, Cached>;
  } catch {
    return {};
  }
}
const cache = await loadCache();
const cachedCount = Object.keys(cache).length;
if (cachedCount) console.log(`(reusing ${cachedCount} cached verdict(s) from ${CACHE_PATH} — pass --refresh to re-ask)\n`);

const rows = await db
  .select()
  .from(restaurants)
  .where(
    and(
      eq(restaurants.enrichmentStatus, "rejected"),
      isNotNull(restaurants.rejectionReason),
      like(restaurants.rejectionReason, "%hospitality group%")
    )
  );

console.log(`${rows.length} lead(s) previously rejected by the LLM chain check${commit ? " (COMMIT)" : " (dry run)"}\n`);
if (rows.length === 0) process.exit(0);

type Verdict = { r: typeof rows[number]; keep: boolean; reasoning: string; owner: string | null };
const verdicts: Verdict[] = [];

for (const r of rows) {
  const label = `${r.name}${r.city ? ` (${r.city})` : ""}`;

  // Free guard first — an unambiguous national chain never needs a paid recheck.
  if (isKnownChain(r.name, r.website)) {
    console.log(`  ✗ ${label} — known chain (denylist), staying rejected (no API call)`);
    continue;
  }

  const hit = cache[String(r.id)];
  if (hit) {
    verdicts.push({ r, ...hit });
    console.log(`  ${hit.keep ? "✓ NOW PASSES  " : "✗ still a chain"} ${label} — ${hit.reasoning.slice(0, 80)} (cached)`);
    continue;
  }

  try {
    const g = await checkHospitalityGroup(r.name, r.city ?? "");
    const v: Cached = { keep: !g.isGroup, reasoning: g.reasoning, owner: g.ownerFirstName };
    verdicts.push({ r, ...v });
    cache[String(r.id)] = v;
    // Persist after EVERY verdict, not at the end — an out-of-credits error
    // partway through must not throw away everything already paid for.
    await Bun.write(CACHE_PATH, JSON.stringify(cache, null, 2));
    console.log(`  ${g.isGroup ? "✗ still a chain" : "✓ NOW PASSES  "} ${label} — ${g.reasoning.slice(0, 95)}`);
  } catch (err) {
    // Leave it rejected rather than guessing — a failed check is not a pass.
    // Not cached: an API failure is not a verdict, so a re-run retries it.
    console.error(`  ! ${label} — recheck FAILED, left rejected: ${err instanceof Error ? err.message : err}`);
  }
}

const restore = verdicts.filter((v) => v.keep);
console.log(`\n--- ${verdicts.length} rechecked: ${restore.length} now pass, ${verdicts.length - restore.length} still chains ---`);
for (const v of restore) {
  const dest = v.r.email ? "queued" : v.r.website ? "needs_manual_email" : "call_list";
  console.log(`  restore -> ${dest.padEnd(19)} ${v.r.name}`);
}

if (!commit) {
  console.log("\nDry run — nothing written. Re-run with --commit to restore.");
  process.exit(0);
}

let applied = 0, failed = 0;
for (const v of restore) {
  const dest = v.r.email ? "queued" : v.r.website ? "needs_manual_email" : "call_list";
  try {
    await db
      .update(restaurants)
      .set({
        enrichmentStatus: dest,
        rejectionReason: null,
        isHospitalityGroup: false,
        // The recheck may have surfaced an owner name the original run missed.
        ...(v.owner && !v.r.contactFirstName ? { contactFirstName: v.owner } : {}),
      })
      .where(eq(restaurants.id, v.r.id));
    applied++;
  } catch (e) {
    failed++;
    console.error(`  write failed for ${v.r.name}:`, e instanceof Error ? e.message : e);
  }
}
console.log(`\nRestored ${applied}/${restore.length}.` + (failed ? ` ${failed} FAILED.` : ""));
process.exit(failed ? 1 : 0);
