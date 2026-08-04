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

  if (action === "unsuppress") {
    await db.update(restaurants).set({ suppressed: false }).where(eq(restaurants.id, id));
    if (row.email) {
      await db.delete(suppressions).where(eq(suppressions.email, row.email.toLowerCase()));
    }
    return NextResponse.json({ ok: true, suppressed: false });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
