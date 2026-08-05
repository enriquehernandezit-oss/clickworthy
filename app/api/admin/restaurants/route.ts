import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, suppressions } from "@/db/schema";
import { addSuppression } from "@/worker/lib/suppression";

// Restaurant-row actions from the admin browser (behind the Basic Auth proxy).
//   set_email   — fill in a missing address; releases a `needs_manual_email`
//                 row back into the send queue
//   suppress    — never contact: flags the row AND adds the address to the
//                 shared suppression list the worker checks before every send
//   unsuppress  — undo both
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const id = Number(form.get("restaurantId"));
  const action = String(form.get("action") ?? "");
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad restaurantId" }, { status: 400 });

  const [row] = await db.select().from(restaurants).where(eq(restaurants.id, id)).limit(1);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (action === "set_email") {
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "That doesn't look like an email." }, { status: 400 });

    // Only a row that was blocked *on the missing email* should be released
    // into the queue — a `rejected` or already-`contacted` row keeps its status.
    const releasing = row.enrichmentStatus === "needs_manual_email";
    await db
      .update(restaurants)
      .set({
        email,
        emailSource: "manual",
        ...(releasing ? { enrichmentStatus: "queued" } : {}),
      })
      .where(eq(restaurants.id, id));

    return NextResponse.json({ ok: true, email, enrichmentStatus: releasing ? "queued" : row.enrichmentStatus });
  }

  if (action === "suppress") {
    await db.update(restaurants).set({ suppressed: true }).where(eq(restaurants.id, id));
    if (row.email) await addSuppression(row.email, "manual");
    return NextResponse.json({ ok: true, suppressed: true });
  }

  // Inline dossier edit: fix Vision-derived fields (dish/name/language) and/or
  // the email. Empty dish/first-name clears to null; email is only touched when
  // provided, and keeps the needs_manual_email -> queued release rule.
  if (action === "set_fields") {
    const patch: Record<string, unknown> = {};

    if (form.has("signatureDish")) {
      const v = String(form.get("signatureDish") ?? "").trim();
      patch.signatureDish = v || null;
    }
    if (form.has("contactFirstName")) {
      const v = String(form.get("contactFirstName") ?? "").trim();
      patch.contactFirstName = v || null;
    }
    if (form.has("language")) {
      const v = String(form.get("language") ?? "");
      if (v !== "en" && v !== "es") return NextResponse.json({ error: "Language must be en or es" }, { status: 400 });
      patch.language = v;
    }
    if (form.has("email")) {
      const email = String(form.get("email") ?? "").trim().toLowerCase();
      if (email) {
        if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "That doesn't look like an email." }, { status: 400 });
        patch.email = email;
        patch.emailSource = "manual";
      }
    }

    if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

    // Release a needs_manual_email row back to queued once BOTH blockers are
    // cleared — it can be held on a missing email OR a missing signature dish
    // (worker/jobs/sendOutreach.ts). The old code only requeued via the email
    // branch, so fixing just the dish left the row stuck.
    if (row.enrichmentStatus === "needs_manual_email") {
      const effEmail = (patch.email as string | undefined) ?? row.email;
      const effDish = "signatureDish" in patch ? (patch.signatureDish as string | null) : row.signatureDish;
      if (effEmail && effDish) patch.enrichmentStatus = "queued";
    }
    await db.update(restaurants).set(patch).where(eq(restaurants.id, id));
    return NextResponse.json({ ok: true });
  }

  // Put a rejected / needs_manual_email restaurant back in line to be drafted.
  if (action === "requeue") {
    await db.update(restaurants).set({ enrichmentStatus: "queued" }).where(eq(restaurants.id, id));
    return NextResponse.json({ ok: true, enrichmentStatus: "queued" });
  }

  if (action === "unsuppress") {
    await db.update(restaurants).set({ suppressed: false }).where(eq(restaurants.id, id));
    if (row.email) {
      await db.delete(suppressions).where(eq(suppressions.email, row.email.toLowerCase()));
    }
    return NextResponse.json({ ok: true, suppressed: false });
  }

  // Hold pulls a restaurant out of Touch-1 drafting without suppressing it (still
  // fine for replies/samples). Unhold makes it draftable again next run.
  if (action === "hold") {
    await db.update(restaurants).set({ held: true }).where(eq(restaurants.id, id));
    return NextResponse.json({ ok: true, held: true });
  }
  if (action === "unhold") {
    await db.update(restaurants).set({ held: false }).where(eq(restaurants.id, id));
    return NextResponse.json({ ok: true, held: false });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
