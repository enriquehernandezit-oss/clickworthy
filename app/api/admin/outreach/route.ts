import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { outreachJobs, restaurants } from "@/db/schema";
import { composeTouch1, normalizeLanguage, type ComposeIdentity } from "@/worker/lib/outreachEmail";
import { getSetting, type Touch1Template } from "@/lib/settings";

type Restaurant = typeof restaurants.$inferSelect;

// Touch-1 draft actions from /admin (behind the Basic Auth proxy).
//   approve      — draft -> approved (the next send run sends it)
//   approve_all  — approve every waiting draft at once
//   redraft      — recompose ONE draft from the restaurant's CURRENT fields,
//                  back to draft (use after fixing a bad signature dish / name)
//   redraft_all  — recompose EVERY waiting draft against the CURRENT template
//                  (used by /admin/photo/templates after a template edit, so
//                  drafts already sitting in the review pile pick up the change
//                  instead of shipping with whatever copy was live when they
//                  were first composed)
//   set_content  — hand-edit this draft's subject/body; the edit wins until you
//                  redraft (which overwrites it from the restaurant fields)
//   skip         — delete the draft AND hold the restaurant (won't re-draft until
//                  unheld)

// Reads the SAME app_settings-backed template + identity the worker uses (see
// lib/settings.ts) — this route runs on the web service, and env vars don't
// cross Railway's per-service boundary, which used to mean a redrafted email
// could ship with a missing postal address even when the worker's own env was
// fully configured.
async function loadTemplateAndIdentity(): Promise<{ template: Touch1Template; identity: ComposeIdentity }> {
  const [template, senderNameSetting, postalAddressSetting] = await Promise.all([
    getSetting("outreach_touch1_template"),
    getSetting("outreach_sender_name"),
    getSetting("outreach_postal_address"),
  ]);
  return { template, identity: { senderName: senderNameSetting, postalAddress: postalAddressSetting } };
}

type RedraftResult =
  | { ok: true; subject: string; body: string }
  | { ok: false; reason: string };

function redraftOne(r: Restaurant, template: Touch1Template, identity: ComposeIdentity): RedraftResult {
  if (!r.signatureDish) return { ok: false, reason: "no signature dish on file" };
  try {
    const composed = composeTouch1({
      restaurantName: r.name,
      firstName: r.contactFirstName,
      dish: r.signatureDish,
      city: r.city,
      language: normalizeLanguage(r.language),
      subjectVariant: r.id,
      template,
      identity,
    });
    return { ok: true, ...composed };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "template error" };
  }
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const action = String(form.get("action") ?? "");

  if (action === "approve_all") {
    const updated = await db
      .update(outreachJobs)
      .set({ status: "approved", approvedAt: new Date() })
      .where(and(eq(outreachJobs.status, "draft"), eq(outreachJobs.kind, "touch1")))
      .returning({ id: outreachJobs.id });
    return NextResponse.json({ ok: true, count: updated.length });
  }

  if (action === "redraft_all") {
    const { template, identity } = await loadTemplateAndIdentity();
    // Only rows still awaiting approval — an already-approved-but-unsent draft
    // is left alone (redrafting it would silently change what a human already
    // signed off on).
    const pending = await db
      .select({ job: outreachJobs, r: restaurants })
      .from(outreachJobs)
      .innerJoin(restaurants, eq(outreachJobs.restaurantId, restaurants.id))
      .where(
        and(
          eq(outreachJobs.status, "draft"),
          eq(outreachJobs.touchNumber, 1),
          eq(outreachJobs.kind, "touch1"),
          isNull(outreachJobs.sentAt)
        )
      );

    let updated = 0;
    const skipped: string[] = [];
    for (const { job, r } of pending) {
      const result = redraftOne(r, template, identity);
      if (!result.ok) {
        skipped.push(`${r.name} (${result.reason})`);
        continue;
      }
      await db
        .update(outreachJobs)
        .set({ subject: result.subject, emailContent: result.body, draftedAt: new Date() })
        .where(eq(outreachJobs.id, job.id));
      updated++;
    }
    return NextResponse.json({ ok: true, updated, skipped: skipped.length, skippedNames: skipped });
  }

  const id = Number(form.get("outreachJobId"));
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad outreachJobId" }, { status: 400 });

  const [job] = await db.select().from(outreachJobs).where(eq(outreachJobs.id, id)).limit(1);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (action === "approve") {
    if (job.status !== "draft") {
      return NextResponse.json({ error: `Can only approve a draft (this is ${job.status}).` }, { status: 409 });
    }
    await db.update(outreachJobs).set({ status: "approved", approvedAt: new Date() }).where(eq(outreachJobs.id, id));
    return NextResponse.json({ ok: true, status: "approved" });
  }

  if (action === "set_content") {
    if (job.status !== "draft" && job.status !== "approved") {
      return NextResponse.json({ error: `Can only edit a draft/approved row (this is ${job.status}).` }, { status: 409 });
    }
    const subject = String(form.get("subject") ?? "").trim();
    const body = String(form.get("body") ?? "").trim();
    if (!subject || !body) return NextResponse.json({ error: "Subject and body are both required." }, { status: 400 });
    // A hand-edit drops it back to draft so it's re-reviewed before it can send.
    await db
      .update(outreachJobs)
      .set({ subject, emailContent: body, status: "draft", approvedAt: null })
      .where(eq(outreachJobs.id, id));
    return NextResponse.json({ ok: true, status: "draft" });
  }

  // Pull an approved (but not-yet-sent) draft back to draft, so it stops before
  // the next send run without needing the global pause.
  if (action === "unapprove") {
    if (job.status !== "approved" || job.sentAt) {
      return NextResponse.json({ error: `Can only un-approve an unsent approved draft (this is ${job.status}).` }, { status: 409 });
    }
    await db.update(outreachJobs).set({ status: "draft", approvedAt: null }).where(eq(outreachJobs.id, id));
    return NextResponse.json({ ok: true, status: "draft" });
  }

  if (action === "redraft") {
    if (job.status !== "draft" && job.status !== "approved") {
      return NextResponse.json({ error: `Can only redraft a draft/approved row (this is ${job.status}).` }, { status: 409 });
    }
    // Guards against overwriting a bump/reply/etc. draft with Touch-1
    // boilerplate — this endpoint only knows how to recompose Touch 1.
    if (job.kind !== "touch1") {
      return NextResponse.json({ error: `Can only redraft a Touch 1 row (this is ${job.kind ?? "unknown"}).` }, { status: 409 });
    }
    if (job.restaurantId == null) return NextResponse.json({ error: "Draft has no restaurant" }, { status: 400 });
    const [r] = await db.select().from(restaurants).where(eq(restaurants.id, job.restaurantId)).limit(1);
    if (!r) return NextResponse.json({ error: "Restaurant not found" }, { status: 404 });

    const { template, identity } = await loadTemplateAndIdentity();
    const result = redraftOne(r, template, identity);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.reason === "no signature dish on file" ? "No signature dish on file — set one on the restaurant, then redraft." : `Couldn't redraft: ${result.reason}.` },
        { status: 400 }
      );
    }
    await db
      .update(outreachJobs)
      .set({ subject: result.subject, emailContent: result.body, draftedAt: new Date(), status: "draft", approvedAt: null })
      .where(eq(outreachJobs.id, id));
    return NextResponse.json({ ok: true, status: "draft" });
  }

  if (action === "skip") {
    await db.delete(outreachJobs).where(eq(outreachJobs.id, id));
    if (job.restaurantId != null) {
      await db.update(restaurants).set({ held: true }).where(eq(restaurants.id, job.restaurantId));
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
