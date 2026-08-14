import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs } from "@/db/schema";
import { sendEmail } from "@/worker/lib/gmail";
import { getSetting } from "@/lib/settings";
import { complianceFooter, hasComplianceFooter, normalizeLanguage } from "@/worker/lib/outreachEmail";
import { isSuppressed } from "@/worker/lib/suppression";

// Manual one-off email to a restaurant, sent from the same `mail@` mailbox as
// cold outreach. Logged as `touchNumber: 0` so it never counts toward the daily
// ramp or bump/reply-cycle logic (which only look at touch 1 + touch 2).
//
// This is a COMMERCIAL email to a prospect, so it carries the same three guards
// every other Gmail path applies — suppression, the CAN-SPAM footer, and the
// pause switch. Without them this route could email a STOP'd recipient with no
// postal address and no opt-out line: two CAN-SPAM violations in one click.
//
// Fails loudly if GOOGLE_SERVICE_ACCOUNT_JSON isn't set on the WEB service —
// the worker's env is separate and, in that case, the caller must add the key
// on the web too or send from Gmail directly.

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const restaurantId = Number(form.get("restaurantId"));
  const subject = String(form.get("subject") ?? "").trim();
  const rawBody = String(form.get("body") ?? "").trim();

  if (!Number.isInteger(restaurantId)) return NextResponse.json({ error: "Bad restaurantId" }, { status: 400 });
  if (!subject || !rawBody) return NextResponse.json({ error: "Subject and body are both required." }, { status: 400 });

  const [r] = await db.select().from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1);
  if (!r) return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });
  if (!r.email) return NextResponse.json({ error: "This restaurant has no email on file." }, { status: 400 });

  // Panic button applies here too — it gates all outbound Gmail to prospects.
  if (await getSetting("outreach_paused")) {
    return NextResponse.json({ error: "Sending is paused (Controls) — resume it, then try again." }, { status: 409 });
  }

  // Never email someone who opted out (or was otherwise suppressed), even by hand.
  if (r.suppressed || (await isSuppressed(r.email))) {
    return NextResponse.json(
      { error: "This restaurant is on the do-not-contact list — they opted out or bounced. Can't email them." },
      { status: 409 }
    );
  }

  // Append the CAN-SPAM footer (postal address + STOP opt-out), same as every
  // template path. Then assert it's really there — an unset postal address
  // renders a placeholder that hasComplianceFooter() rejects, blocking the send
  // rather than shipping a non-compliant email (mirrors sendApproved's guard).
  const postalAddress = await getSetting("outreach_postal_address");
  const body = rawBody + complianceFooter(normalizeLanguage(r.language), postalAddress);
  if (!hasComplianceFooter(body)) {
    return NextResponse.json(
      { error: "Set a postal address on the Templates page first — a commercial email legally needs one." },
      { status: 409 }
    );
  }

  try {
    const senderNameSetting = await getSetting("outreach_sender_name");
    const sent = await sendEmail({ to: r.email, subject, body, fromName: senderNameSetting });
    await db.insert(outreachJobs).values({
      restaurantId: r.id,
      touchNumber: 0, // 'manual' — excluded from ramp / bump / touch-2 flow
      kind: "manual",
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
