// Recomposes approved-but-unsent bump drafts with the CURRENT bump template
// and identity settings, and resets their status back to `draft` for a fresh
// approval pass.
//
//   bun run scripts/recompose-stale-bumps.ts            # DRY RUN — shows before/after
//   bun run scripts/recompose-stale-bumps.ts --commit   # write them
//
// WHY THIS EXISTS (2026-09-13). 38 bumps sat `approved` since Aug 28-31,
// unable to send because sendApprovedBumps() reserved every approved-pending
// Touch 1 (unbounded by the daily cap) for Touch 1's own priority, leaving
// bumps 0 budget every run (see worker/jobs/sendOutreach.ts / sendBumps.ts —
// fixed the same day). Their body text was composed back when the bump
// template still opened with a hardcoded "Hi there," (the Aug 26 template
// hand-edit that also dropped {{dish}} — see scripts/reset-templates-to-
// default.ts) rather than the restaurant owner's actual first name, so
// sending them as-is now would ship stale, worse copy than a fresh draft
// would.
//
// Skips (does not touch) any bump whose restaurant has since replied, been
// suppressed, or lost its email — recomposing those would be pointless or
// unsafe. Sets status back to `draft`, NOT `cancelled`: draftBumps()'s
// one-bump-ever guard counts a bump row in ANY status, so a cancelled bump
// could never be redrafted by the normal nightly job — this script is the
// only path back to a sendable bump for these restaurants.

import { db } from "@/db";
import { restaurants, outreachJobs } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { getSetting } from "@/lib/settings";
import { composeBump, normalizeLanguage, type ComposeIdentity } from "../worker/lib/outreachEmail";

const commit = process.argv.includes("--commit");

async function main() {
  const stale = await db
    .select({ job: outreachJobs, r: restaurants })
    .from(outreachJobs)
    .innerJoin(restaurants, eq(outreachJobs.restaurantId, restaurants.id))
    .where(and(eq(outreachJobs.kind, "bump"), eq(outreachJobs.status, "approved"), isNull(outreachJobs.sentAt)));

  console.log(`\n=== recompose-stale-bumps ${commit ? "(COMMIT)" : "(DRY RUN)"} ===`);
  console.log(`${stale.length} approved-but-unsent bump(s) found.\n`);
  if (stale.length === 0) return;

  const [template, senderNameSetting, postalAddressSetting, signatureSetting] = await Promise.all([
    getSetting("outreach_bump_template"),
    getSetting("outreach_sender_name"),
    getSetting("outreach_postal_address"),
    getSetting("outreach_signature"),
  ]);
  const identity: ComposeIdentity = { senderName: senderNameSetting, postalAddress: postalAddressSetting, signature: signatureSetting };

  let recomposed = 0;
  let skipped = 0;

  for (const { job, r } of stale) {
    if (job.repliedAt) {
      console.log(`SKIP  ${r.name} (job ${job.id}) — restaurant replied since; leave the approved bump alone`);
      skipped++;
      continue;
    }
    if (r.suppressed) {
      console.log(`SKIP  ${r.name} (job ${job.id}) — restaurant is suppressed`);
      skipped++;
      continue;
    }
    if (!r.email) {
      console.log(`SKIP  ${r.name} (job ${job.id}) — no email on file`);
      skipped++;
      continue;
    }

    const language = normalizeLanguage(r.language);
    let body: string;
    try {
      body = composeBump({
        restaurantName: r.name,
        firstName: r.contactFirstName,
        dish: r.signatureDish ?? (language === "es" ? "plato" : "dish"),
        city: r.city,
        language,
        template,
        identity,
      });
    } catch (err) {
      console.error(`ERROR ${r.name} (job ${job.id}) — compose failed:`, err instanceof Error ? err.message : err);
      skipped++;
      continue;
    }

    console.log(`${r.name} (job ${job.id}) -> ${r.email}`);
    console.log(`  BEFORE: ${(job.emailContent ?? "").replace(/\s+/g, " ").slice(0, 100)}...`);
    console.log(`  AFTER:  ${body.replace(/\s+/g, " ").slice(0, 100)}...`);

    if (commit) {
      await db
        .update(outreachJobs)
        .set({ emailContent: body, status: "draft", approvedAt: null })
        .where(eq(outreachJobs.id, job.id));
    }
    recomposed++;
  }

  console.log(
    `\n${commit ? "Recomposed" : "Would recompose"} ${recomposed}, skipped ${skipped}.` +
      (commit
        ? " Re-approve them in Approvals."
        : " Pass --commit to write (sets status back to 'draft' for re-approval).")
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
