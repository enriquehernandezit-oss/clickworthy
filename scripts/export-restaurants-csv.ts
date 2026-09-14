// One-off, read-only export of every sourced restaurant + everything the
// pipeline recorded about it, to a CSV outside the repo (it holds contact
// data — names, emails, phone numbers). No schema or code change; safe to
// delete after use.
//
//   bun run scripts/export-restaurants-csv.ts [output-path]
//
// Defaults to ~/Desktop/clickworthy-restaurants-<today>.csv.

import { db } from "@/db";
import { restaurants, outreachJobs } from "@/db/schema";
import { sql } from "drizzle-orm";
import { classifyWebsite } from "../worker/lib/websitePlatform";
import { homedir } from "node:os";
import { join } from "node:path";

const outPath =
  process.argv[2] ?? join(homedir(), "Desktop", `clickworthy-restaurants-${new Date().toISOString().slice(0, 10)}.csv`);

const COLUMNS = [
  "id", "name", "city", "status", "rejection_reason", "rating", "review_count", "price_level",
  "phone", "website", "website_type", "email", "email_source", "email_rank", "contact_first_name",
  "signature_dish", "avg_photo_score", "photos_scored", "photo_count", "website_photo_band",
  "website_photo_richness", "website_pro_score", "is_hospitality_group", "delivery_enabled",
  "temporarily_closed", "is_new_opening", "priority_score", "language", "suppressed", "held",
  "sourced_at", "touch1_sent_at", "touch1_status", "bump_sent_at", "replied_at", "last_contacted_at",
] as const;

// RFC-4180: quote any field containing a comma, quote, or newline; double up
// embedded quotes. Restaurant names routinely contain commas ("Joe's, Inc.")
// and quotes, so this isn't optional.
function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  console.log("Fetching restaurants...");
  const rows = await db.select().from(restaurants).orderBy(restaurants.id);

  console.log("Fetching outreach history (touch1 + bump)...");
  const outreach = await db
    .select({
      restaurantId: outreachJobs.restaurantId,
      kind: outreachJobs.kind,
      status: outreachJobs.status,
      sentAt: outreachJobs.sentAt,
      repliedAt: outreachJobs.repliedAt,
    })
    .from(outreachJobs)
    .where(sql`${outreachJobs.kind} in ('touch1', 'bump')`);

  // A restaurant can have multiple touch1/bump rows over time (rare, but
  // possible after a cancel+redraft) — take the most recent of each kind.
  const byRestaurant = new Map<number, { touch1?: (typeof outreach)[number]; bump?: (typeof outreach)[number] }>();
  for (const o of outreach) {
    if (o.restaurantId == null) continue;
    const entry = byRestaurant.get(o.restaurantId) ?? {};
    const slot = o.kind === "touch1" ? "touch1" : "bump";
    const existing = entry[slot];
    if (!existing || (o.sentAt ?? new Date(0)) > (existing.sentAt ?? new Date(0))) entry[slot] = o;
    byRestaurant.set(o.restaurantId, entry);
  }

  console.log(`Writing ${rows.length} rows to ${outPath}...`);
  const lines: string[] = [COLUMNS.join(",")];

  for (const r of rows) {
    const oc = byRestaurant.get(r.id) ?? {};
    const websiteType = r.website ? classifyWebsite(r.website).tier : "none";
    const record: Record<(typeof COLUMNS)[number], unknown> = {
      id: r.id,
      name: r.name,
      city: r.city,
      status: r.enrichmentStatus,
      rejection_reason: r.rejectionReason,
      rating: r.rating,
      review_count: r.reviewCount,
      price_level: r.priceLevel,
      phone: r.phone,
      website: r.website,
      website_type: websiteType,
      email: r.email,
      email_source: r.emailSource,
      email_rank: r.emailRank,
      contact_first_name: r.contactFirstName,
      signature_dish: r.signatureDish,
      avg_photo_score: r.avgPhotoScore,
      photos_scored: r.photosScored,
      photo_count: r.photoCount,
      website_photo_band: r.websitePhotoBand,
      website_photo_richness: r.websitePhotoRichness,
      website_pro_score: r.websiteProScore,
      is_hospitality_group: r.isHospitalityGroup,
      delivery_enabled: r.deliveryEnabled,
      temporarily_closed: r.temporarilyClosed,
      is_new_opening: r.isNewOpening,
      priority_score: r.priorityScore,
      language: r.language,
      suppressed: r.suppressed,
      held: r.held,
      sourced_at: r.createdAt,
      touch1_sent_at: oc.touch1?.sentAt ?? null,
      touch1_status: oc.touch1?.status ?? null,
      bump_sent_at: oc.bump?.sentAt ?? null,
      replied_at: oc.touch1?.repliedAt ?? oc.bump?.repliedAt ?? null,
      last_contacted_at: r.lastContactedAt,
    };
    lines.push(COLUMNS.map((c) => csvField(record[c])).join(","));
  }

  // UTF-8 BOM so Excel renders accented names (Méxican, Café) and CJK
  // characters (避風塘) correctly instead of guessing the wrong codepage.
  const BOM = "﻿";
  await Bun.write(outPath, BOM + lines.join("\r\n") + "\r\n");
  console.log(`Done: ${rows.length} restaurants -> ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
