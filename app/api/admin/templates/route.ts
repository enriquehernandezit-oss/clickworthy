import { NextRequest, NextResponse } from "next/server";
import { desc, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { getCurrentUser } from "@/lib/currentUser";
import { sendEmail } from "@/worker/lib/gmail";
import {
  composeTouch1,
  composeBump,
  hasComplianceFooter,
  normalizeLanguage,
  type ComposeIdentity,
} from "@/worker/lib/outreachEmail";
import type { Touch1Template, BumpTemplate } from "@/lib/settings";

// test_send — composes the SUBMITTED (possibly unsaved) template against a
// real restaurant and sends it to the signed-in admin's own inbox, so a
// template can be proven out before it ever reaches a prospect. Deliberately
// does NOT go through worker/jobs/sendOutreach.ts: it ignores OUTREACH_ENABLED
// (a test send should work even pre-launch), writes no outreach_jobs row, and
// never counts toward the daily ramp.
//
// Auth: behind the same proxy.ts session gate as every /api/admin/* route.

const FALLBACK_RESTAURANT = {
  name: "Casa del Sol",
  contactFirstName: "Maria",
  signatureDish: "ropa vieja",
  city: "Miami, FL",
};

async function pickPreviewRestaurant() {
  const [r] = await db
    .select()
    .from(restaurants)
    .where(isNotNull(restaurants.signatureDish))
    .orderBy(desc(restaurants.createdAt))
    .limit(1);
  return r
    ? { name: r.name, contactFirstName: r.contactFirstName, signatureDish: r.signatureDish!, city: r.city }
    : FALLBACK_RESTAURANT;
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  if (action !== "test_send") return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const which = String(form.get("which") ?? "");
  const language = normalizeLanguage(String(form.get("language") ?? "en"));
  const senderName = String(form.get("senderName") ?? "").trim() || "Enrique";
  const postalAddress = String(form.get("postalAddress") ?? "").trim();
  const identity: ComposeIdentity = { senderName, postalAddress };

  let templateJson: unknown;
  try {
    templateJson = JSON.parse(String(form.get("template") ?? ""));
  } catch {
    return NextResponse.json({ error: "Template value must be valid JSON." }, { status: 400 });
  }

  const r = await pickPreviewRestaurant();

  let subject: string;
  let body: string;
  try {
    if (which === "touch1") {
      const composed = composeTouch1({
        restaurantName: r.name,
        firstName: r.contactFirstName,
        dish: r.signatureDish,
        city: r.city,
        language,
        subjectVariant: 0,
        template: templateJson as Touch1Template,
        identity,
      });
      subject = composed.subject;
      body = composed.body;
    } else if (which === "bump") {
      subject = `Re: [test] Touch 1.5 bump preview`;
      body = composeBump({
        restaurantName: r.name,
        firstName: r.contactFirstName,
        dish: r.signatureDish,
        city: r.city,
        language,
        template: templateJson as BumpTemplate,
        identity,
      });
    } else {
      return NextResponse.json({ error: "`which` must be 'touch1' or 'bump'." }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Template error: ${err instanceof Error ? err.message : "invalid template"}.` },
      { status: 400 }
    );
  }

  // Same compliance check the live send path applies — a test send should
  // surface a missing footer, not hide it.
  const complianceWarning = !hasComplianceFooter(body)
    ? " ⚠ This body is missing the postal address or STOP line — it would be blocked from a real send."
    : "";

  try {
    await sendEmail({
      to: user.email,
      subject: `[TEST] ${subject}`,
      body: `(Test send — previewed against "${r.name}". Not counted toward any real send.)\n\n${body}`,
      fromName: identity.senderName,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not configured|GOOGLE_SERVICE_ACCOUNT_JSON|GMAIL_SENDER/i.test(msg)) {
      return NextResponse.json(
        { error: "Gmail isn't configured on the web service — set GOOGLE_SERVICE_ACCOUNT_JSON + GMAIL_SENDER." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: `Send failed: ${msg}` }, { status: 502 });
  }

  return NextResponse.json({ ok: true, sentTo: user.email, previewedAgainst: r.name, complianceWarning });
}
