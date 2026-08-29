import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks, restaurants, outreachJobs } from "@/db/schema";
import { enhancePhoto } from "@/lib/claid";
import { persistEnhancedFromUrl, storeImageBytes } from "@/lib/storage";
import { FINALIZED_ENHANCEMENT_PROMPT } from "@/worker/lib/prompts";
import { getSetting } from "@/lib/settings";
import { sendEmail } from "@/worker/lib/gmail";
import { hasComplianceFooter } from "@/worker/lib/outreachEmail";
import { threadToReplyInto } from "@/worker/jobs/sendTouch2";

// Free-sample production actions (behind the Basic Auth proxy — see proxy.ts).
// The reply pipeline drops a sample as `awaiting_edit`; Enrique/Jose finish it
// here by hand, then review + edit + send Touch 2 in the same request.
// Everything is FormData so the upload action can carry a file alongside the
// others.
//   first_pass       — optional: run Claid once on the original, store the rough
//   upload_finished  — store the human-finished photo as the sample to send
//   approve          — requires a finished photo + a reviewed subject/body;
//                       composes AND sends Touch 2 synchronously, right here
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
    const subject = String(form.get("subject") ?? "").trim();
    const body = String(form.get("body") ?? "").trim();
    if (!subject || !body) {
      return NextResponse.json({ error: "Subject and body are both required." }, { status: 400 });
    }
    // Catches a hand-edit that deleted the postal address / STOP line — the
    // same guard every other send path in this app applies before a real send.
    if (!hasComplianceFooter(body)) {
      return NextResponse.json(
        { error: "This email is missing the postal address or opt-out line — required on every commercial email." },
        { status: 400 }
      );
    }
    if (link.restaurantId == null) {
      return NextResponse.json({ error: "This sample has no restaurant on file." }, { status: 400 });
    }

    // Re-checked here, synchronously — the cron this replaces was the only
    // thing that checked these. Without this, a synchronous Touch 2 send would
    // silently bypass both breakers.
    if (await getSetting("outreach_paused")) {
      return NextResponse.json({ error: "Sending is paused (Controls) — resume it, then try again." }, { status: 409 });
    }
    if (process.env.OUTREACH_ENABLED !== "true") {
      return NextResponse.json(
        { error: "Gmail sending isn't enabled on the worker (OUTREACH_ENABLED) — see Setup." },
        { status: 409 }
      );
    }

    const [r] = await db.select().from(restaurants).where(eq(restaurants.id, link.restaurantId)).limit(1);
    if (!r || !r.email) {
      return NextResponse.json({ error: "This restaurant has no email on file." }, { status: 400 });
    }

    const senderNameSetting = await getSetting("outreach_sender_name");

    try {
      const { threadId, inReplyTo } = await threadToReplyInto(r.id);
      const sent = await sendEmail({
        to: r.email,
        subject,
        body,
        fromName: senderNameSetting,
        threadId: threadId ?? undefined,
        inReplyTo,
      });
      const now = new Date();
      await db.update(magicLinks).set({ reviewStatus: "approved", touch2SentAt: now }).where(eq(magicLinks.id, id));
      await db.insert(outreachJobs).values({
        restaurantId: r.id,
        magicLinkId: id,
        kind: "touch2",
        touchNumber: 2,
        subject,
        emailContent: body,
        // Composed, approved, and sent in the same instant — no separate async
        // phases for Touch 2, so all three timestamps land together.
        draftedAt: now,
        approvedAt: now,
        sentAt: now,
        status: "sent",
        gmailMessageId: sent.id,
        gmailThreadId: sent.threadId,
      });
      return NextResponse.json({ ok: true, reviewStatus: "approved" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `Send failed: ${msg}` }, { status: 502 });
    }
  }

  if (action === "reject") {
    await db.update(magicLinks).set({ reviewStatus: "rejected" }).where(eq(magicLinks.id, id));
    return NextResponse.json({ ok: true, reviewStatus: "rejected" });
  }

  // Undo a rejection — puts the reply back in the edit queue. Rejecting used to
  // be a permanent one-click loss of a lead that replied with a photo.
  if (action === "unreject") {
    if (link.reviewStatus !== "rejected") {
      return NextResponse.json({ error: `Only a rejected sample can be restored (this is ${link.reviewStatus}).` }, { status: 409 });
    }
    await db.update(magicLinks).set({ reviewStatus: "awaiting_edit" }).where(eq(magicLinks.id, id));
    return NextResponse.json({ ok: true, reviewStatus: "awaiting_edit" });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
