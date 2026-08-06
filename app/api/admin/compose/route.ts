import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs } from "@/db/schema";
import { sendEmail } from "@/worker/lib/gmail";

// Manual one-off email to a restaurant, sent from the same `mail@` mailbox as
// cold outreach. Logged as `touchNumber: 0` so it never counts toward the daily
// ramp or bump/reply-cycle logic (which only look at touch 1 + touch 2).
//
// Fails loudly if GOOGLE_SERVICE_ACCOUNT_JSON isn't set on the WEB service —
// the worker's env is separate and, in that case, the caller must add the key
// on the web too or send from Gmail directly.

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const restaurantId = Number(form.get("restaurantId"));
  const subject = String(form.get("subject") ?? "").trim();
  const body = String(form.get("body") ?? "").trim();

  if (!Number.isInteger(restaurantId)) return NextResponse.json({ error: "Bad restaurantId" }, { status: 400 });
  if (!subject || !body) return NextResponse.json({ error: "Subject and body are both required." }, { status: 400 });

  const [r] = await db.select().from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1);
  if (!r) return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });
  if (!r.email) return NextResponse.json({ error: "This restaurant has no email on file." }, { status: 400 });

  try {
    const sent = await sendEmail({ to: r.email, subject, body, fromName: "Clickworthy" });
    await db.insert(outreachJobs).values({
      restaurantId: r.id,
      touchNumber: 0, // 'manual' — excluded from ramp / bump / touch-2 flow
      subject,
      emailContent: body,
      sentAt: new Date(),
      status: "sent",
      gmailMessageId: sent.id,
      gmailThreadId: sent.threadId,
    });
    return NextResponse.json({ ok: true, threadId: sent.threadId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Surface the config-missing error clearly rather than a generic 500.
    if (/not configured|GOOGLE_SERVICE_ACCOUNT_JSON|GMAIL_SENDER/i.test(msg)) {
      return NextResponse.json(
        { error: "Gmail isn't configured on the web service — set GOOGLE_SERVICE_ACCOUNT_JSON + GMAIL_SENDER, or send from Gmail directly." },
        { status: 409 }
      );
    }
    console.error("[compose] send failed:", msg);
    return NextResponse.json({ error: `Send failed: ${msg}` }, { status: 502 });
  }
}
