// Processes paid outreach packages: finds magic links the customer has uploaded
// photos for (packageStatus = 'processing', no results yet), runs each original
// through Claid with the finalized prompt, persists durable results, and marks
// the package completed. Runs on a short cron; the upload page polls status.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks } from "@/db/schema";
import { enhancePhoto } from "@/lib/claid";
import { persistEnhancedFromUrl } from "@/lib/storage";
import { config } from "../config";
import { FINALIZED_ENHANCEMENT_PROMPT } from "../lib/prompts";

type Original = { name: string; url: string };
type PackageResult = { name: string; originalUrl: string; enhancedUrl: string | null; error: string | null };

async function processOne(linkId: number, token: string, originals: Original[]): Promise<void> {
  const results: PackageResult[] = [];

  for (let i = 0; i < originals.length; i++) {
    const original = originals[i];
    try {
      const claidUrl = await enhancePhoto(original.url, FINALIZED_ENHANCEMENT_PROMPT);
      const enhancedUrl = await persistEnhancedFromUrl(`${token}-pkg`, i, claidUrl, config.appOrigin);
      results.push({ name: original.name, originalUrl: original.url, enhancedUrl, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // TODO(Phase 4): alert — a PAID package photo failed to enhance.
      console.error(`[package] enhance failed for "${original.name}" (link ${token}):`, message);
      results.push({ name: original.name, originalUrl: original.url, enhancedUrl: null, error: message });
    }
  }

  const anySucceeded = results.some((r) => r.enhancedUrl !== null);
  await db
    .update(magicLinks)
    .set({ packageResults: results, packageStatus: anySucceeded ? "completed" : "failed" })
    .where(eq(magicLinks.id, linkId));

  console.log(`[package] link ${token}: ${results.filter((r) => r.enhancedUrl).length}/${results.length} enhanced`);
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
