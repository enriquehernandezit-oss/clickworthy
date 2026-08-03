import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks } from "@/db/schema";
import { enhancePhoto } from "@/lib/claid";
import { persistEnhancedFromUrl, storeImageBytes } from "@/lib/storage";
import { FINALIZED_ENHANCEMENT_PROMPT } from "@/worker/lib/prompts";

// Free-sample production actions (behind the Basic Auth proxy — see proxy.ts).
// The reply pipeline drops a sample as `awaiting_edit`; Enrique/Jose finish it
// here by hand, then approve to send Touch 2. Everything is FormData so the
// upload action can carry a file alongside the others.
//   first_pass       — optional: run Claid once on the original, store the rough
//   upload_finished  — store the human-finished photo as the sample to send
//   approve          — requires a finished photo; flips to `approved` (sends Touch 2)
//   reject           — flips to `rejected`
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

function appOriginFrom(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const host = request.headers.get("host") ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const id = Number(form.get("magicLinkId"));
  const action = String(form.get("action") ?? "");
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "Bad magicLinkId" }, { status: 400 });
  }

  const [link] = await db.select().from(magicLinks).where(eq(magicLinks.id, id)).limit(1);
  if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const appOrigin = appOriginFrom(request);

  if (action === "first_pass") {
    if (!link.freeSampleOriginalUrl) {
      return NextResponse.json({ error: "No original photo on file" }, { status: 400 });
    }
    try {
      const claidUrl = await enhancePhoto(link.freeSampleOriginalUrl, FINALIZED_ENHANCEMENT_PROMPT);
      const url = await persistEnhancedFromUrl(`${link.token}-firstpass`, 0, claidUrl, appOrigin);
      await db.update(magicLinks).set({ freeSampleFirstPassUrl: url }).where(eq(magicLinks.id, id));
      return NextResponse.json({ ok: true, url });
    } catch (err) {
      return NextResponse.json(
        { error: `Claid first pass failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 }
      );
    }
  }

  if (action === "upload_finished") {
    const photo = form.get("photo");
    if (!(photo instanceof File)) return NextResponse.json({ error: "No photo uploaded" }, { status: 400 });
    if (!ALLOWED.has(photo.type)) {
      return NextResponse.json({ error: "Upload a JPEG, PNG, or WEBP" }, { status: 400 });
    }
    const bytes = Buffer.from(await photo.arrayBuffer());
    const url = await storeImageBytes({
      groupKey: link.token,
      name: `finished-${Date.now()}-${photo.name}`,
      bytes,
      contentType: photo.type,
      appOrigin,
    });
    await db.update(magicLinks).set({ freeSampleEnhancedUrl: url }).where(eq(magicLinks.id, id));
    return NextResponse.json({ ok: true, url });
  }

  if (action === "approve") {
    if (!link.freeSampleEnhancedUrl) {
      return NextResponse.json({ error: "Upload the finished photo before approving." }, { status: 400 });
    }
    await db.update(magicLinks).set({ reviewStatus: "approved" }).where(eq(magicLinks.id, id));
    return NextResponse.json({ ok: true, reviewStatus: "approved" });
  }

  if (action === "reject") {
    await db.update(magicLinks).set({ reviewStatus: "rejected" }).where(eq(magicLinks.id, id));
    return NextResponse.json({ ok: true, reviewStatus: "rejected" });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
