// Re-check GUESSED emails that were approved under the old, permissive catchall
// policy and are still sitting in `queued`, waiting to be sent.
//
//   bun run scripts/recheck-guessed.ts            # DRY RUN — lists candidates, NO API calls, no writes
//   bun run scripts/recheck-guessed.ts --commit   # verify each + hold the ones that fail
//   bun run scripts/recheck-guessed.ts --commit --limit 3
//
// WHY THIS EXISTS (2026-08-27). isContactable() used to accept a `catchall`
// verdict for any address. An accept-all domain says yes to anything, including
// an address we invented, so guessed info@ addresses passed verification and
// then hard-bounced hours later via async DSN: 4 of 15 guessed sends bounced
// (~27%), against 0 of 49 scraped. The policy now rejects catchall for guessed
// addresses (worker/lib/neverbounce.ts) — but that only applies at ENRICHMENT
// time. Leads already verified under the old bar are still sitting in `queued`
// with an invented address, and the send cron will happily mail them. This is
// the one-off pass that re-checks those, so the fix isn't purely forward-looking.
//
// Mirrors the enricher's own convention exactly (worker/jobs/enrichRestaurant.ts
// step 7): a lead with no contactable email keeps `email = null` and routes to
// `needs_manual_email`, or `call_list` when the site is a social/ordering page
// where no mailbox can exist. Clearing the address is deliberate, not data loss
// — it is provably worthless (an invented mailbox on an accept-all domain), it
// is trivially reconstructible (info@ + their domain), and a null email is what
// makes the row eligible for scripts/reverify-emails.ts, which will later try to
// discover a REAL published address for it. Held, not dropped.
//
// Safety: read-only until --commit; only ever touches rows that are BOTH
// `queued` AND `emailSource='guessed'` (never a scraped address, never a lead
// already contacted); skips suppressed rows; per-row try/catch so one API error
// can't abort the batch; a verification THROW leaves the row untouched rather
// than holding a lead on an infrastructure blip.

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { verifyEmail, isContactable } from "@/worker/lib/neverbounce";
import { classifyWebsite } from "@/worker/lib/websitePlatform";

const commit = process.argv.includes("--commit");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Math.max(1, Number(process.argv[limitArg + 1]) || 0) : 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fail fast rather than churning through every row catching an identical
// "key missing" throw (same guard as scripts/reverify-emails.ts).
if (commit && !process.env.NEVERBOUNCE_API_KEY?.trim()) {
  console.error(
    "NEVERBOUNCE_API_KEY is not set — add it to .env.local before --commit.\n" +
      "Without it every verification throws and nothing would change."
  );
  process.exit(1);
}

const candidates = await db
  .select({
    id: restaurants.id,
    name: restaurants.name,
    email: restaurants.email,
    emailSource: restaurants.emailSource,
    website: restaurants.website,
  })
  .from(restaurants)
  .where(
    and(
      eq(restaurants.enrichmentStatus, "queued"),
      eq(restaurants.emailSource, "guessed"),
      eq(restaurants.suppressed, false),
      isNotNull(restaurants.email)
    )
  )
  .orderBy(restaurants.id);

console.log(
  `\n=== recheck-guessed ===\n` +
    `candidates: ${candidates.length} queued lead(s) with a GUESSED email, not yet sent\n`
);

if (!commit) {
  const preview = limit ? candidates.slice(0, limit) : candidates;
  console.table(preview.map((c) => ({ id: c.id, name: c.name, email: c.email, website: c.website ?? "—" })));
  console.log(`\nDry run — no API calls, no writes.\nPass --commit to verify each against the strict (guessed) bar.`);
  process.exit(0);
}

const batch = limit ? candidates.slice(0, limit) : candidates;
console.log(`Verifying ${batch.length} address(es) against the strict bar...\n`);

let kept = 0;
let held = 0;
let errored = 0;

for (const c of batch) {
  try {
    const verdict = await verifyEmail(c.email!);
    // guessed=true is the whole point: a catchall verdict carries no evidence
    // for an address we invented. Read from the row rather than hardcoded, so
    // the flag can't silently disagree with what the query selected.
    const contactable = isContactable(verdict, { guessed: c.emailSource === "guessed" });

    if (contactable) {
      kept++;
      console.log(`  ✓ ${c.name} — ${c.email} (${verdict.result}) → stays queued`);
      continue;
    }

    // Same routing the enricher applies when it ends up with no email.
    const tier = c.website ? classifyWebsite(c.website).tier : "none";
    const deadEnd = tier === "social_only" || tier === "ordering_platform";
    const status = c.website && !deadEnd ? "needs_manual_email" : "call_list";

    await db
      .update(restaurants)
      .set({ email: null, emailRank: null, emailSource: null, enrichmentStatus: status })
      .where(eq(restaurants.id, c.id));

    held++;
    console.log(`  ✗ ${c.name} — ${c.email} (${verdict.result}) → held as ${status}`);
  } catch (err) {
    errored++;
    console.warn(`  ! ${c.name} — verification error, LEFT UNTOUCHED: ${err instanceof Error ? err.message : String(err)}`);
  }

  await sleep(250);
}

console.log(
  `\n=== done ===\n` +
    `  still contactable (kept queued): ${kept}\n` +
    `  held (no longer sendable):       ${held}\n` +
    `  errored (left untouched):        ${errored}\n` +
    (held > 0
      ? `\n${held} lead(s) will NOT be emailed. They keep their website, so ` +
        `scripts/reverify-emails.ts can try to discover a real published address for them.`
      : `\nNothing needed holding.`)
);
process.exit(0);
