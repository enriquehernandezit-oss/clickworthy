// Re-verify email for existing `needs_manual_email` leads, now that NeverBounce
// is configured. Sourcing skips restaurants already in the DB, so the back
// catalogue never gets a second automated pass on its own — this script is that
// pass, for the email step only.
//
//   bun run scripts/reverify-emails.ts                     # DRY RUN — lists candidates, NO API calls, no writes
//   bun run scripts/reverify-emails.ts --commit            # discover + verify + write (idempotent)
//   bun run scripts/reverify-emails.ts --commit --limit 5  # same, first 5 only (sane first-run check)
//
// For each `needs_manual_email` row that has a website but no email yet, it runs
// the SAME discovery + NeverBounce verification the enricher uses, sets the email,
// then re-applies the EXACT enrichment gate (unchanged policy): a row moves to
// `queued` only with BOTH a contactable email AND a signature dish. A row that
// gets a verified email but still has no dish stays `needs_manual_email` — now
// with the email pre-filled, so a human only has to add the dish.
//
// Safety: never overwrites an existing email; never touches signatureDish or any
// other field; skips suppressed rows; per-row try/catch so one bad site can't
// abort the batch. Idempotent — rows it queues drop out of the candidate set, so
// re-running only picks up what's still unresolved.

import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { discoverEmail } from "@/worker/lib/emailDiscovery";
import { verifyEmail, isContactable } from "@/worker/lib/neverbounce";

const commit = process.argv.includes("--commit");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Math.max(1, Number(process.argv[limitArg + 1]) || 0) : 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fail fast with a clear message rather than churning through every row and
// catching an identical "key missing" throw on each verify call.
if (commit && !process.env.NEVERBOUNCE_API_KEY?.trim()) {
  console.error(
    "NEVERBOUNCE_API_KEY is not set — add it to .env.local (and the Railway worker service) before --commit.\n" +
      "Without it every verification fails and nothing would change."
  );
  process.exit(1);
}

// Candidates: held for a human on email, with a site to scrape and no email yet.
// (Suppressed = opted out / bounced — never re-contact, so never re-verify.)
const candidates = await db
  .select({
    id: restaurants.id,
    name: restaurants.name,
    website: restaurants.website,
    signatureDish: restaurants.signatureDish,
  })
  .from(restaurants)
  .where(
    and(
      eq(restaurants.enrichmentStatus, "needs_manual_email"),
      eq(restaurants.suppressed, false),
      isNotNull(restaurants.website),
      isNull(restaurants.email)
    )
  )
  .orderBy(restaurants.id);

const withDish = candidates.filter((c) => c.signatureDish).length;
console.log(
  `\n=== reverify-emails ===\n` +
    `candidates: ${candidates.length} needs_manual_email rows with a website and no email\n` +
    `  (any with a contactable email will queue; ${withDish} have a dish, ` +
    `${candidates.length - withDish} will draft with a generic {{dish}} fallback)\n`
);

if (!commit) {
  const preview = candidates.slice(0, limit || candidates.length);
  console.table(
    preview.map((c) => ({ id: c.id, name: c.name, dish: c.signatureDish ?? "—", website: c.website }))
  );
  console.log(
    `\nDry run — no API calls, no writes.` +
      (limit ? ` (showing first ${preview.length})` : "") +
      `\nPass --commit to discover + verify + write.`
  );
  process.exit(0);
}

const batch = limit ? candidates.slice(0, limit) : candidates;
console.log(`Processing ${batch.length} row(s)...\n`);

let queued = 0; // got a contactable email → queued (dish optional)
let noEmail = 0; // discovery found nothing / verification not contactable
let errored = 0;

for (const c of batch) {
  try {
    const discovered = await discoverEmail(c.website!);
    if (!discovered) {
      noEmail++;
      console.log(`  ✗ ${c.name} — no email discoverable on site`);
      continue;
    }

    const verdict = await verifyEmail(discovered.email);
    if (!isContactable(verdict)) {
      noEmail++;
      console.log(`  ✗ ${c.name} — ${discovered.email} not contactable (${verdict.result})`);
      continue;
    }

    // Mirror the enrichRestaurant gate: a contactable email is enough to queue.
    // A dish still personalizes Touch 1 when present, but dish-less leads queue
    // too (composeTouch1 uses a generic {{dish}} fallback).
    await db
      .update(restaurants)
      .set({
        email: discovered.email,
        emailRank: discovered.rank,
        emailSource: "website",
        enrichmentStatus: "queued",
      })
      .where(eq(restaurants.id, c.id));

    queued++;
    const dishNote = c.signatureDish ? "" : " (no dish — generic draft)";
    console.log(`  ✓ ${c.name} — ${discovered.email} (${verdict.result}) → queued${dishNote}`);
  } catch (err) {
    errored++;
    console.warn(`  ! ${c.name} — error: ${err instanceof Error ? err.message : String(err)}`);
  }

  await sleep(250); // politeness between site fetches + NeverBounce calls
}

console.log(
  `\n=== done ===\n` +
    `  queued (contactable email):  ${queued}\n` +
    `  no contactable email:        ${noEmail}\n` +
    `  errored:                     ${errored}\n` +
    (queued > 0
      ? `\n${queued} lead(s) are now queued — the nightly send cron will draft Touch 1 for them ` +
        `(gated by OUTREACH_ENABLED / the ramp).`
      : `\nNothing reached "queued" this run.`)
);
process.exit(0);
