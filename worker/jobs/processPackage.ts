// Processes paid outreach packages: finds magic links the customer has uploaded
// photos for (packageStatus = 'processing', no results yet), runs each original
// through Claid with the finalized prompt, persists durable results, and marks
// the package completed. Runs on a short cron; the upload page polls status.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks } from "@/db/schema";
import { enhancePhoto } from "@/lib/claid";
import { persistEnhancedFromUrl } from "@/lib/storage";
import { sendAlert } from "@/lib/alerts";
import { config } from "../config";
import { FINALIZED_ENHANCEMENT_PROMPT } from "../lib/prompts";
import { withRetry } from "../lib/retry";

type Original = { name: string; url: string };
type PackageResult = { name: string; originalUrl: string; enhancedUrl: string | null; error: string | null };

async function processOne(linkId: number, token: string, originals: Original[]): Promise<void> {
  const results: PackageResult[] = [];

  for (let i = 0; i < originals.length; i++) {
    const original = originals[i];
    try {
      const claidUrl = await withRetry(() => enhancePhoto(original.url, FINALIZED_ENHANCEMENT_PROMPT), {
        label: `claid package ${token} #${i}`,
      });
      const enhancedUrl = await persistEnhancedFromUrl(`${token}-pkg`, i, claidUrl, config.appOrigin);
      results.push({ name: original.name, originalUrl: original.url, enhancedUrl, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[package] enhance failed for "${original.name}" (link ${token}):`, message);
      results.push({ name: original.name, originalUrl: original.url, enhancedUrl: null, error: message });
    }
  }

  const succeeded = results.filter((r) => r.enhancedUrl !== null).length;
  // This is only a first pass — Enrique/Jose finish and approve each photo in
  // /admin before it's delivered. Never auto-delivers to the paid customer.
  await db
    .update(magicLinks)
    .set({ packageResults: results, packageStatus: "ready_for_review" })
    .where(eq(magicLinks.id, linkId));

  console.log(`[package] link ${token}: ${succeeded}/${results.length} first-passed → ready for review`);

  await sendAlert(
    "Paid order ready to finish",
    `Link ${token}: ${succeeded}/${results.length} photos got a Claid first pass. ` +
      "Finish + approve them in /admin, then deliver."
  );
}

export async function runProcessPackages(): Promise<void> {
  const pending = await db
    .select({
      id: magicLinks.id,
      token: magicLinks.token,
      originals: magicLinks.packageOriginals,
    })
    .from(magicLinks)
    .where(and(eq(magicLinks.packageStatus, "processing"), isNull(magicLinks.packageResults)));

  for (const link of pending) {
    const originals = (link.originals as Original[] | null) ?? [];
    if (originals.length === 0) continue;
    await processOne(link.id, link.token, originals);
  }
}
