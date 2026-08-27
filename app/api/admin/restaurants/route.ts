import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, suppressions } from "@/db/schema";
import { addSuppression } from "@/worker/lib/suppression";
import { verifyEmail, isContactable } from "@/worker/lib/neverbounce";

// Restaurant-row actions from the admin browser (behind the Basic Auth proxy).
//   set_email   — fill in a missing address; releases a `needs_manual_email`
//                 row back into the send queue (NeverBounce-verified first —
//                 see verifyManualEmail)
//   suppress    — never contact: flags the row AND adds the address to the
//                 shared suppression list the worker checks before every send
//   unsuppress  — undo both
//   create      — add a walk-in lead by hand; drops in as `queued` if it has an
//                 email, else `needs_manual_email` (like an enriched sourced row).
//                 NOT verified — a walk-in is typically hand-confirmed already,
//                 and this is a rare, deliberate operator action, not a bulk path.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Both set_email and set_fields can flip a needs_manual_email row to `queued`
// — the moment an email actually enters the send pipeline. Until now that
// happened on a shape-regex check alone: worker/jobs/enrichRestaurant.ts's own
// discovery pipeline runs every scraped/guessed address through NeverBounce
// before ever queuing it, but a HAND-typed address here never touched it. One
// bounce on a hand-typed address risks the sending domain's reputation for
// every other lead in flight. Verify only at the moment of release (not on
// every edit to an already-terminal row) — that's the only point a bad address
// can reach an inbox.
//
// Fails OPEN on a NeverBounce outage — same philosophy as the chain check
// (worker/lib/anthropic.ts): a human reviews every draft before it sends
// regardless, so blocking Jose entirely because NeverBounce is unreachable is
// worse than letting one unverified address through this one time.
async function verifyManualEmail(email: string): Promise<{ contactable: true } | { contactable: false; result: string }> {
  try {
    const v = await verifyEmail(email);
    return isContactable(v) ? { contactable: true } : { contactable: false, result: v.result };
  } catch (err) {
    console.warn(
      `[admin] NeverBounce unreachable verifying "${email}" — failing open (treated as contactable):`,
      err instanceof Error ? err.message : err
    );
    return { contactable: true };
  }
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const action = String(form.get("action") ?? "");

  if (action === "create") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return NextResponse.json({ error: "Name is required." }, { status: 400 });
    const city = String(form.get("city") ?? "").trim() || null;
    const dishRaw = String(form.get("signatureDish") ?? "").trim();
    const firstRaw = String(form.get("contactFirstName") ?? "").trim();
    const lang = String(form.get("language") ?? "en");
    if (lang !== "en" && lang !== "es") return NextResponse.json({ error: "Language must be en or es." }, { status: 400 });
    const email: string | null = String(form.get("email") ?? "").trim().toLowerCase() || null;
    if (email && !EMAIL_RE.test(email)) return NextResponse.json({ error: "That doesn't look like an email." }, { status: 400 });
    // Same qualification the auto pipeline uses: no dish OR no email = held back
    // for a human to complete before it's eligible to draft.
    const status = email && dishRaw ? "queued" : "needs_manual_email";
    const [created] = await db
      .insert(restaurants)
      .values({
        name,
        city,
        email,
        emailSource: email ? "manual" : null,
        signatureDish: dishRaw || null,
        contactFirstName: firstRaw || null,
        language: lang,
        enrichmentStatus: status,
      })
      .returning({ id: restaurants.id });
    return NextResponse.json({ ok: true, id: created.id, enrichmentStatus: status });
  }

  const id = Number(form.get("restaurantId"));
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad restaurantId" }, { status: 400 });

  const [row] = await db.select().from(restaurants).where(eq(restaurants.id, id)).limit(1);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (action === "set_email") {
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "That doesn't look like an email." }, { status: 400 });

    // Only a row that was blocked *on the missing email* should be released
    // into the queue — a `rejected` or already-`contacted` row keeps its status.
    const releasing = row.enrichmentStatus === "needs_manual_email";
    if (releasing) {
      const verdict = await verifyManualEmail(email);
      if (!verdict.contactable) {
        await db.update(restaurants).set({ email, emailSource: "manual" }).where(eq(restaurants.id, id));
        return NextResponse.json(
          {
            error: `Saved, but NeverBounce says this address is "${verdict.result}" — not queued. Try another address, or use Requeue to send anyway.`,
            email,
            enrichmentStatus: row.enrichmentStatus,
          },
          { status: 422 }
        );
      }
    }
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
      const effEmailSource = (patch.emailSource as string | undefined) ?? row.emailSource;
      if (effEmail && effDish) {
        // Verify before release whenever the effective address is a HAND-typed
        // one — whether typed in this request, or already sitting on the row
        // from an earlier set_email/set_fields call and only now unblocked by
        // fixing the dish (the bypass a dish-only edit would otherwise open).
        // A 'website'/'guessed' address was already NeverBounce-verified by
        // discoverEmail/findVerifiedEmail at enrichment time — no need to pay
        // for a second check.
        if (effEmailSource === "manual") {
          const verdict = await verifyManualEmail(effEmail);
          if (!verdict.contactable) {
            await db.update(restaurants).set(patch).where(eq(restaurants.id, id));
            return NextResponse.json(
              {
                error: `Saved, but NeverBounce says "${effEmail}" is "${verdict.result}" — not queued. Try another address, or use Requeue to send anyway.`,
              },
              { status: 422 }
            );
          }
        }
        patch.enrichmentStatus = "queued";
      }
    }
    await db.update(restaurants).set(patch).where(eq(restaurants.id, id));
    return NextResponse.json({ ok: true });
  }

  // Put a rejected / needs_manual_email restaurant back in line to be drafted.
  // Deliberately UNVERIFIED — this is the explicit operator override for when
  // set_email/set_fields blocked on a NeverBounce "not contactable" verdict and
  // the operator wants to send anyway (a real business's info@ can still read
  // "invalid" on some checks). One human decision, not a bulk/automated path.
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
