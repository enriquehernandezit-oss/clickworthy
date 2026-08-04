import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, suppressions } from "@/db/schema";
import { addSuppression } from "@/worker/lib/suppression";

// Do-not-contact list management (behind the Basic Auth proxy).
// Both actions keep `restaurants.suppressed` in sync with the suppression
// table: the worker checks BOTH before sending, so letting them disagree would
// mean a row that looks contactable in the browser but silently never sends
// (or worse, the reverse).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REASONS = new Set(["manual", "opt_out", "bounce", "complaint"]);

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  const email = String(form.get("email") ?? "").trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "That doesn't look like an email." }, { status: 400 });
  }

  if (action === "add") {
    const reason = String(form.get("reason") ?? "manual");
    if (!REASONS.has(reason)) return NextResponse.json({ error: "Unknown reason" }, { status: 400 });

    await addSuppression(email, reason);
    await db.update(restaurants).set({ suppressed: true }).where(eq(restaurants.email, email));
    return NextResponse.json({ ok: true });
  }

  if (action === "remove") {
    await db.delete(suppressions).where(eq(suppressions.email, email));
    await db.update(restaurants).set({ suppressed: false }).where(eq(restaurants.email, email));
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
