import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { outreachJobs, restaurants } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { sendCustomerEmail } from "@/lib/customerEmail";
import { sendEmail, getThreadTail } from "@/worker/lib/gmail";

// Approve/deny/send actions for the kinds that don't fit Touch 1's own route
// (app/api/admin/outreach/route.ts, kind-scoped to "touch1"): bump, reply, and
// payment_confirmation. Kept separate from the outreach route rather than
// folded in — each kind's send-completion semantics differ enough (in-thread
// Gmail reply vs. a fresh Resend send, draft-then-approve-then-cron-sends vs.
// send-atomically) that tangling them into one file would cost more than it
// saves.
//
//   bump_approve                — draft -> approved (the next reply-cycle run
//                                  sends it — see worker/jobs/sendBumps.ts's
//                                  sendApprovedBumps()).
//   bump_edit                   — hand-edit the body; drops back to draft so
//                                  it's re-reviewed before it can send. Mirrors
//                                  Touch 1's own set_content action.
//   bump_deny                   — terminal: the one-bump-ever guard in
//                                  draftBumps() blocks re-drafting once ANY
//                                  bump row exists for a restaurant, denied
//                                  included — honors the bump's own promise
//                                  ("I won't follow up again").
//   reply_send                  — a human-authored reply to a customer's
//                                  message. No LLM drafting anywhere in this
//                                  path — the draft body is blank until a
//                                  person writes it. Resolves the thread's
//                                  subject and In-Reply-To FRESH here, not at
//                                  draft time: drafting is a cheap DB-only
//                                  write (worker/jobs/pollReplies.ts), and the
//                                  customer could send another message before
//                                  this runs.
//   reply_deny                  — no re-draft guard needed, unlike the
//                                  bump's: a reply is a one-shot event already
//                                  deduplicated by lastReplyMessageId on the
//                                  poller side, so denying one can't cause a
//                                  duplicate to reappear later.
//   payment_confirmation_send   — sends the (possibly edited) draft the
//                                  Stripe webhook queued. Resend, not Gmail —
//                                  no threading to resolve.
//   payment_confirmation_deny   — one-shot event already deduplicated by the
//                                  webhook's atomic paidAt guard, same
//                                  reasoning as reply_deny.

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  const id = Number(form.get("outreachJobId"));
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad outreachJobId" }, { status: 400 });

  const [job] = await db.select().from(outreachJobs).where(eq(outreachJobs.id, id)).limit(1);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (action === "bump_approve") {
    if (job.kind !== "bump") {
      return NextResponse.json({ error: `Not a bump draft (this is ${job.kind ?? "unknown"}).` }, { status: 409 });
    }
    if (job.status !== "draft") {
      return NextResponse.json({ error: `Can only approve a draft (this is ${job.status}).` }, { status: 409 });
    }
    await db.update(outreachJobs).set({ status: "approved", approvedAt: new Date() }).where(eq(outreachJobs.id, id));
    return NextResponse.json({ ok: true, status: "approved" });
  }

  if (action === "bump_edit") {
    if (job.kind !== "bump") {
      return NextResponse.json({ error: `Not a bump draft (this is ${job.kind ?? "unknown"}).` }, { status: 409 });
    }
    if (job.status !== "draft" && job.status !== "approved") {
      return NextResponse.json({ error: `Can only edit a draft/approved row (this is ${job.status}).` }, { status: 409 });
    }
    const body = String(form.get("body") ?? "").trim();
    if (!body) return NextResponse.json({ error: "Body is required." }, { status: 400 });
    await db
      .update(outreachJobs)
      .set({ emailContent: body, status: "draft", approvedAt: null })
      .where(eq(outreachJobs.id, id));
    return NextResponse.json({ ok: true, status: "draft" });
  }

  if (action === "bump_deny") {
    if (job.kind !== "bump") {
      return NextResponse.json({ error: `Not a bump draft (this is ${job.kind ?? "unknown"}).` }, { status: 409 });
    }
    if (job.status !== "draft") {
      return NextResponse.json({ error: `Can only deny a draft (this is ${job.status}).` }, { status: 409 });
    }
    await db.update(outreachJobs).set({ status: "denied" }).where(eq(outreachJobs.id, id));
    return NextResponse.json({ ok: true, status: "denied" });
  }

  if (action === "reply_send") {
    if (job.kind !== "reply") {
      return NextResponse.json({ error: `Not a reply draft (this is ${job.kind ?? "unknown"}).` }, { status: 409 });
    }
    if (job.status !== "draft") {
      return NextResponse.json({ error: `Can only send a draft (this is ${job.status}).` }, { status: 409 });
    }
    if (!job.gmailThreadId) {
      return NextResponse.json({ error: "This draft has no thread to reply into." }, { status: 400 });
    }
    if (!job.replyFrom) {
      return NextResponse.json({ error: "This draft has no recipient on file." }, { status: 400 });
    }
    const body = String(form.get("body") ?? "").trim();
    if (!body) return NextResponse.json({ error: "Write a reply before sending." }, { status: 400 });

    // Gmail-based send — same infrastructure-readiness gate every other Gmail
    // send in this app checks. Deliberately NOT gated by outreach_paused: that
    // switch protects cold-outreach reputation exposure, and this is a reply
    // to someone who already emailed first, a different risk category.
    if (process.env.OUTREACH_ENABLED !== "true") {
      return NextResponse.json(
        { error: "Gmail sending isn't enabled on the worker (OUTREACH_ENABLED) — see Setup." },
        { status: 409 }
      );
    }

    const senderNameSetting = await getSetting("outreach_sender_name");
    try {
      const { messageId: inReplyTo, subject: origSubject } = await getThreadTail(job.gmailThreadId);
      const subject = origSubject ? (/^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`) : "";
      const sent = await sendEmail({
        to: job.replyFrom,
        subject,
        body,
        fromName: senderNameSetting,
        threadId: job.gmailThreadId,
        inReplyTo,
      });
      const now = new Date();
      await db
        .update(outreachJobs)
        .set({
          emailContent: body,
          subject,
          status: "sent",
          approvedAt: now,
          sentAt: now,
          gmailMessageId: sent.id,
        })
        .where(eq(outreachJobs.id, id));
      return NextResponse.json({ ok: true, status: "sent" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `Send failed: ${msg}` }, { status: 502 });
    }
  }

  if (action === "reply_deny") {
    if (job.kind !== "reply") {
      return NextResponse.json({ error: `Not a reply draft (this is ${job.kind ?? "unknown"}).` }, { status: 409 });
    }
    if (job.status !== "draft") {
      return NextResponse.json({ error: `Can only deny a draft (this is ${job.status}).` }, { status: 409 });
    }
    await db.update(outreachJobs).set({ status: "denied" }).where(eq(outreachJobs.id, id));
    return NextResponse.json({ ok: true, status: "denied" });
  }

  if (action === "payment_confirmation_send") {
    if (job.kind !== "payment_confirmation") {
      return NextResponse.json({ error: `Not a payment-confirmation draft (this is ${job.kind ?? "unknown"}).` }, { status: 409 });
    }
    if (job.status !== "draft") {
      return NextResponse.json({ error: `Can only send a draft (this is ${job.status}).` }, { status: 409 });
    }
    if (job.restaurantId == null) {
      return NextResponse.json({ error: "This draft has no restaurant on file." }, { status: 400 });
    }
    const subject = String(form.get("subject") ?? "").trim();
    const body = String(form.get("body") ?? "").trim();
    if (!subject || !body) return NextResponse.json({ error: "Subject and body are both required." }, { status: 400 });

    const [r] = await db.select().from(restaurants).where(eq(restaurants.id, job.restaurantId)).limit(1);
    if (!r?.email) return NextResponse.json({ error: "This restaurant has no email on file." }, { status: 400 });

    const sent = await sendCustomerEmail({ to: r.email, subject, body });
    if (!sent) {
      return NextResponse.json({ error: "Send failed — check RESEND_API_KEY on Setup, then try again." }, { status: 502 });
    }
    const now = new Date();
    await db
      .update(outreachJobs)
      .set({ subject, emailContent: body, status: "sent", approvedAt: now, sentAt: now })
      .where(eq(outreachJobs.id, id));
    return NextResponse.json({ ok: true, status: "sent" });
  }

  if (action === "payment_confirmation_deny") {
    if (job.kind !== "payment_confirmation") {
      return NextResponse.json({ error: `Not a payment-confirmation draft (this is ${job.kind ?? "unknown"}).` }, { status: 409 });
    }
    if (job.status !== "draft") {
      return NextResponse.json({ error: `Can only deny a draft (this is ${job.status}).` }, { status: 409 });
    }
    await db.update(outreachJobs).set({ status: "denied" }).where(eq(outreachJobs.id, id));
    return NextResponse.json({ ok: true, status: "denied" });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
