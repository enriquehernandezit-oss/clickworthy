import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { outreachJobs, restaurants } from "@/db/schema";
import { composeTouch1 } from "@/worker/lib/outreachEmail";

// Touch-1 draft actions from /admin (behind the Basic Auth proxy).
//   approve      — draft -> approved (the next send run sends it)
//   approve_all  — approve every waiting draft at once
//   redraft      — recompose from the restaurant's CURRENT fields, back to draft
//                  (use after fixing a bad signature dish / name)
//   set_content  — hand-edit this draft's subject/body; the edit wins until you
//                  redraft (which overwrites it from the restaurant fields)
//   skip         — delete the draft AND hold the restaurant (won't re-draft until
//                  unheld)

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const action = String(form.get("action") ?? "");

  if (action === "approve_all") {
    const updated = await db
      .update(outreachJobs)
      .set({ status: "approved", approvedAt: new Date() })
      .where(eq(outreachJobs.status, "draft"))
      .returning({ id: outreachJobs.id });
    return NextResponse.json({ ok: true, count: updated.length });
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
    if (job.restaurantId == null) return NextResponse.json({ error: "Draft has no restaurant" }, { status: 400 });
    const [r] = await db.select().from(restaurants).where(eq(restaurants.id, job.restaurantId)).limit(1);
    if (!r) return NextResponse.json({ error: "Restaurant not found" }, { status: 404 });
    if (!r.signatureDish) {
      return NextResponse.json(
        { error: "No signature dish on file — set one on the restaurant, then redraft." },
        { status: 400 }
      );
    }
    const { subject, body } = composeTouch1({
      restaurantName: r.name,
      firstName: r.contactFirstName,
      dish: r.signatureDish,
      language: r.language ?? "en",
      subjectVariant: r.id,
    });
    await db
      .update(outreachJobs)
      .set({ subject, emailContent: body, draftedAt: new Date(), status: "draft", approvedAt: null })
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
