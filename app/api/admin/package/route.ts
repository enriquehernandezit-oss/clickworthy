import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks, restaurants } from "@/db/schema";
import { enhancePhoto } from "@/lib/claid";
import { persistEnhancedFromUrl, storeImageBytes } from "@/lib/storage";
import { sendOrderDeliveredEmail } from "@/lib/customerEmail";
import { FINALIZED_ENHANCEMENT_PROMPT } from "@/worker/lib/prompts";

// Paid-order production actions (behind Basic Auth). A paid package lands as
// `ready_for_review` with a Claid first pass already run; Enrique/Jose finish
// each photo here and deliver.
//   first_pass_one  — optional: re-run Claid on one photo's original
//   upload_edited   — replace one photo's enhanced version with a human-finished file
//   deliver         — mark the whole order `completed` (unlocks the delivery page)
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

  if (action === "deliver") {
    await db.update(magicLinks).set({ packageStatus: "completed" }).where(eq(magicLinks.id, id));

    // Tell the customer — their delivery page was gated on this status, so
    // without this email they'd have no way to know it's ready.
    if (link.restaurantId != null) {
      const [r] = await db.select().from(restaurants).where(eq(restaurants.id, link.restaurantId)).limit(1);
      if (r?.email) {
        await sendOrderDeliveredEmail({
          to: r.email,
          restaurantName: r.name,
          language: r.language ?? "en",
          deliveryUrl: `${appOrigin.replace(/\/$/, "")}/l/${link.token}/upload`,
        });
      }
    }

    return NextResponse.json({ ok: true, packageStatus: "completed" });
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
