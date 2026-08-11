import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks, restaurants } from "@/db/schema";
import { enhancePhoto } from "@/lib/claid";
import { persistEnhancedFromUrl, storeImageBytes } from "@/lib/storage";
import { sendOrderDeliveredEmail } from "@/lib/customerEmail";
import { FINALIZED_ENHANCEMENT_PROMPT } from "@/worker/lib/prompts";
import { recordManualPayment } from "@/lib/paymentLedger";
import { PACKAGES, isPackageId } from "@/lib/packages";

type Original = { name: string; url: string };

// Paid-order production actions (behind Basic Auth). A paid package lands as
// `ready_for_review` with a Claid first pass already run; Enrique/Jose finish
// each photo here and deliver.
//   first_pass_one  — optional: re-run Claid on one photo's original
//   upload_edited   — replace one photo's enhanced version with a human-finished file
//   deliver         — mark the whole order `completed` (unlocks the delivery page)
//   resend_delivery — re-send the delivery email (it fails soft, so a bounce or
//                     a Resend outage otherwise leaves the customer never told)
//   mark_paid       — record a package paid off-Stripe (check/Zelle) so it can
//                     enter the production pipeline
//   retry           — re-queue a `failed` order for another Claid first pass.
//                     packageStatus only reaches 'failed' when EVERY photo
//                     failed (see worker/jobs/processPackage.ts), so resetting
//                     packageResults here never discards a real success —
//                     there isn't one to discard in this state. Without this,
//                     a paid-but-failed package had NO recovery path from the
//                     console at all (the production queue only lists
//                     'ready_for_review', so no action buttons ever rendered).
//   upload_originals — the admin-side counterpart to the customer's own upload
//                     at /l/[token]/upload (app/api/outreach/enhance/route.ts).
//                     Restaurant owners email a folder of photos regardless of
//                     what the upload page says — this lets Jose drop those
//                     files straight into the same pipeline, keyed by
//                     magicLinkId instead of the customer's token. Mirrors that
//                     route's validation exactly so both paths land in an
//                     identical packageOriginals/packageStatus state.
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

type PackageResult = { name: string; originalUrl: string; enhancedUrl: string | null; error: string | null };

function appOriginFrom(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const host = request.headers.get("host") ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const id = Number(form.get("magicLinkId"));
  const action = String(form.get("action") ?? "");
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad magicLinkId" }, { status: 400 });

  const [link] = await db.select().from(magicLinks).where(eq(magicLinks.id, id)).limit(1);
  if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const appOrigin = appOriginFrom(request);
  const results = (link.packageResults as PackageResult[] | null) ?? [];

  // Sends the "your order is ready" email if the restaurant has an address.
  // Returns whether it attempted a send (false = no email on file).
  async function sendDelivery(): Promise<boolean> {
    if (link.restaurantId == null) return false;
    const [r] = await db.select().from(restaurants).where(eq(restaurants.id, link.restaurantId)).limit(1);
    if (!r?.email) return false;
    await sendOrderDeliveredEmail({
      to: r.email,
      restaurantName: r.name,
      language: r.language ?? "en",
      deliveryUrl: `${appOrigin.replace(/\/$/, "")}/l/${link.token}/upload`,
    });
    return true;
  }

  if (action === "deliver") {
    await db.update(magicLinks).set({ packageStatus: "completed", deliveredAt: new Date() }).where(eq(magicLinks.id, id));
    await sendDelivery();
    return NextResponse.json({ ok: true, packageStatus: "completed" });
  }

  if (action === "resend_delivery") {
    if (link.packageStatus !== "completed") {
      return NextResponse.json({ error: "Only a delivered order's email can be resent." }, { status: 409 });
    }
    const sent = await sendDelivery();
    return NextResponse.json(
      sent
        ? { ok: true }
        : { ok: false, error: "No email on file for this restaurant — can't send." },
      { status: sent ? 200 : 409 }
    );
  }

  if (action === "mark_paid") {
    if (link.paidAt) return NextResponse.json({ error: "Already marked paid." }, { status: 409 });
    if (!link.packageSelected) {
      return NextResponse.json({ error: "No package selected on this link." }, { status: 400 });
    }
    const paidAt = new Date();
    await db.update(magicLinks).set({ paidAt }).where(eq(magicLinks.id, id));
    // Record an off-Stripe (check/Zelle) payment: real fee $0. Priced from the
    // package list — a manual payment never has a Stripe amount to read.
    if (isPackageId(link.packageSelected)) {
      const pkg = PACKAGES[link.packageSelected];
      await recordManualPayment({
        line: "package",
        magicLinkId: id,
        restaurantId: link.restaurantId,
        packageId: link.packageSelected,
        grossCents: pkg.priceCents,
        description: `${pkg.name.en} (manual)`,
        paidAt,
      });
    }
    return NextResponse.json({ ok: true, paidAt: true });
  }

  if (action === "retry") {
    if (link.packageStatus !== "failed") {
      return NextResponse.json({ error: `Can only retry a failed order (this is ${link.packageStatus}).` }, { status: 409 });
    }
    await db.update(magicLinks).set({ packageStatus: "processing", packageResults: null }).where(eq(magicLinks.id, id));
    return NextResponse.json({ ok: true, packageStatus: "processing" });
  }

  if (action === "upload_originals") {
    if (!link.paidAt) return NextResponse.json({ error: "This order hasn't been paid yet." }, { status: 402 });
    if (link.packageStatus === "processing" || link.packageStatus === "completed") {
      return NextResponse.json({ error: "This order is already being processed." }, { status: 409 });
    }
    if (!isPackageId(link.packageSelected)) {
      return NextResponse.json({ error: "No package on file for this link." }, { status: 400 });
    }
    const limit = PACKAGES[link.packageSelected].photoLimit;

    const photos = form.getAll("photos").filter((e): e is File => e instanceof File);
    if (photos.length === 0) return NextResponse.json({ error: "Choose at least one photo." }, { status: 400 });
    if (photos.length > limit) {
      return NextResponse.json({ error: `This package includes up to ${limit} photos.` }, { status: 400 });
    }
    for (const p of photos) {
      if (!ALLOWED.has(p.type)) return NextResponse.json({ error: "Upload JPEG, PNG, or WEBP images only." }, { status: 400 });
    }

    try {
      const originals: Original[] = await Promise.all(
        photos.map(async (file, i) => {
          const bytes = Buffer.from(await file.arrayBuffer());
          const url = await storeImageBytes({
            groupKey: `${link.token}-pkg`,
            name: `${i}-${file.name}`,
            bytes,
            contentType: file.type,
            appOrigin,
          });
          return { name: file.name, url };
        })
      );
      await db
        .update(magicLinks)
        .set({ packageOriginals: originals, packageStatus: "processing", packageResults: null })
        .where(eq(magicLinks.id, id));
      return NextResponse.json({ ok: true, count: originals.length });
    } catch (err) {
      console.error("[admin-package] upload_originals failed:", err instanceof Error ? err.message : err);
      return NextResponse.json({ error: "Failed to store the photos. Try again." }, { status: 502 });
    }
  }

  const index = Number(form.get("photoIndex"));
  if (!Number.isInteger(index) || index < 0 || index >= results.length) {
    return NextResponse.json({ error: "Bad photoIndex" }, { status: 400 });
  }

  if (action === "first_pass_one") {
    try {
      const claidUrl = await enhancePhoto(results[index].originalUrl, FINALIZED_ENHANCEMENT_PROMPT);
      const url = await persistEnhancedFromUrl(`${link.token}-pkg`, index, claidUrl, appOrigin);
      results[index] = { ...results[index], enhancedUrl: url, error: null };
      await db.update(magicLinks).set({ packageResults: results }).where(eq(magicLinks.id, id));
      return NextResponse.json({ ok: true, url });
    } catch (err) {
      return NextResponse.json(
        { error: `Claid failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 }
      );
    }
  }

  if (action === "upload_edited") {
    const photo = form.get("photo");
    if (!(photo instanceof File)) return NextResponse.json({ error: "No photo uploaded" }, { status: 400 });
    if (!ALLOWED.has(photo.type)) return NextResponse.json({ error: "Upload a JPEG, PNG, or WEBP" }, { status: 400 });
    const bytes = Buffer.from(await photo.arrayBuffer());
    const url = await storeImageBytes({
      groupKey: `${link.token}-pkg`,
      name: `edited-${index}-${Date.now()}-${photo.name}`,
      bytes,
      contentType: photo.type,
      appOrigin,
    });
    results[index] = { ...results[index], enhancedUrl: url, error: null };
    await db.update(magicLinks).set({ packageResults: results }).where(eq(magicLinks.id, id));
    return NextResponse.json({ ok: true, url });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
