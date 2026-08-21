// Re-run email discovery v2 over leads stuck in `needs_manual_email` — they
// cleared every filter and gate but the v1 text-regex couldn't find an address.
//
//   bun run scripts/backfill-emails.ts              # DRY RUN, FREE: no NeverBounce,
//                                                   #   no writes. Reports which
//                                                   #   extractor would find what.
//   bun run scripts/backfill-emails.ts --commit     # verify (costs) + write + requeue
//   bun run scripts/backfill-emails.ts --commit --limit 10
//
// The free dry run exists so the extractor lift can be measured BEFORE paying
// for a single verification — run it first and read the per-source table.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import {
  fetchHomepageHtml,
  discoverEmail,
  guessEmailCandidates,
  extractCfEmails,
  extractMailtoEmails,
  extractJsonLdEmails,
  extractMetaEmails,
  isAcceptableDomain,
} from "@/worker/lib/emailDiscovery";
import { findVerifiedEmail } from "@/worker/lib/findEmail";

const commit = process.argv.includes("--commit");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Math.max(1, Number(process.argv[limitArg + 1]) || 0) : 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (commit && !process.env.NEVERBOUNCE_API_KEY?.trim()) {
  console.error("NEVERBOUNCE_API_KEY is not set — can't verify. Aborting.");
  process.exit(1);
}

const rows = await db
  .select({ id: restaurants.id, name: restaurants.name, city: restaurants.city, website: restaurants.website })
  .from(restaurants)
  .where(and(eq(restaurants.enrichmentStatus, "needs_manual_email"), isNotNull(restaurants.website)))
  .orderBy(sql`${restaurants.priorityScore} desc nulls last`)
  .limit(limit || 1000);

console.log(`${rows.length} stuck leads with a website${commit ? "" : "  [DRY RUN — no verification, no writes, $0]"}\n`);

const bySource: Record<string, number> = { text: 0, cloudflare: 0, mailto: 0, jsonld: 0, meta: 0 };
let candidates = 0;
let guessable = 0;
let verified = 0;
let checks = 0;
const found: string[] = [];

for (const r of rows) {
  const site = r.website!;
  const html = await fetchHomepageHtml(site);
  const domain = (() => { try { return new URL(site).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; } })();

  if (commit) {
    const res = await findVerifiedEmail(site, html ?? undefined);
    checks += res.checks;
    if (res.found) {
      verified++;
      await db
        .update(restaurants)
        .set({
          email: res.found.email,
          emailRank: res.found.rank,
          emailSource: res.found.source,
          enrichmentStatus: "queued", // released back into the draft queue
        })
        .where(eq(restaurants.id, r.id));
      console.log(`  ✓ ${r.name.slice(0, 30).padEnd(30)} ${res.found.email}  (${res.found.source})`);
    }
    await sleep(150);
    continue;
  }

  // --- free dry run: which extractor WOULD find an address (unverified) ---
  if (html) {
    const ok = (list: string[]) => list.filter((e) => isAcceptableDomain((e.split("@")[1] ?? "").toLowerCase(), domain));
    if (ok(extractCfEmails(html)).length) bySource.cloudflare++;
    if (ok(extractMailtoEmails(html)).length) bySource.mailto++;
    if (ok(extractJsonLdEmails(html)).length) bySource.jsonld++;
    if (ok(extractMetaEmails(html)).length) bySource.meta++;
  }
  const d = await discoverEmail(site, html ?? undefined);
  if (d) {
    candidates++;
    found.push(`  · ${r.name.slice(0, 30).padEnd(30)} ${d.email}`);
  } else if (guessEmailCandidates(site).length > 0) {
    guessable++;
  }
  await sleep(120);
}

console.log("");
if (commit) {
  console.log(`=== BACKFILL DONE ===`);
  console.log(`  recovered + requeued : ${verified} of ${rows.length}`);
  console.log(`  NeverBounce checks   : ${checks}  (~$${(checks * 0.008).toFixed(2)} at $0.008/check)`);
} else {
  console.log(`=== DRY RUN (free) ===`);
  console.log(`  would find an address : ${candidates} of ${rows.length}  (${Math.round((candidates / (rows.length || 1)) * 100)}%)`);
  console.log(`  no address, guessable : ${guessable}  (would cost up to 3 checks each)`);
  console.log(`  potential total       : ${candidates + guessable} of ${rows.length}`);
  console.log(`\n  which extractor fired (leads where it found something):`);
  for (const [k, v] of Object.entries(bySource)) if (k !== "text") console.log(`    ${k.padEnd(11)} ${v}`);
  if (found.length) {
    console.log(`\n  addresses found (unverified — verify happens on --commit):`);
    for (const f of found.slice(0, 25)) console.log(f);
  }
  console.log(`\n  Next: bun run scripts/backfill-emails.ts --commit`);
}
process.exit(0);
