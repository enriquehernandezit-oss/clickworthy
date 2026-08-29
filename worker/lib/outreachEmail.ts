// Composes the outreach emails (subject + body + CAN-SPAM footer) from the
// admin-editable templates in app_settings (see lib/settings.ts and
// /admin/photo/templates). Merge fields: signature dish, owner first name
// (graceful fallback), restaurant name, city, sender identity. Touch 1 and the
// bump are deliberately link-free and price-free — the only ask is a reply.
//
// Compose functions are kept SYNCHRONOUS on purpose: callers fetch the
// template + identity settings once per job run and pass them in, rather than
// each function reading app_settings itself. That keeps this file pure and
// unit-testable, and means a single Promise.all covers the whole batch instead
// of one DB round-trip per restaurant.

import type { BumpTemplate, Touch1Template, Touch2Template } from "@/lib/settings";
import { PACKAGE_ORDER, formatCents, type PackageId, type PackageTier } from "@/lib/packages";
import { renderTemplate, sanitizeSubject, type TemplateVars } from "./renderTemplate";

// The only placeholders a template may reference. Shared with the settings
// validation route so "what can I use" and "what's allowed to save" can't drift.
export const OUTREACH_TEMPLATE_VARS = ["restaurant", "dish", "firstName", "greeting", "city", "senderName"] as const;

// Touch 2 adds three of its own on top of the shared set — all Touch-2-specific,
// so they're not offered on Touch 1 / bump (which are deliberately link-free
// and price-free).
export const TOUCH2_TEMPLATE_VARS = [...OUTREACH_TEMPLATE_VARS, "funnelUrl", "talkLine", "pricing"] as const;

export type Language = "en" | "es";

export function normalizeLanguage(value: string | null | undefined): Language {
  return value === "es" ? "es" : "en";
}

// Fallback for {{dish}} when a lead has no signature dish on file. Leads with a
// real dish still get the specific personalization; dish-less leads draft with a
// generic-but-grammatical word ("your food photo", "the food at X") so the email
// still reads cleanly and a human can tailor it before approving. Keeps dish-less
// but emailable leads in the pipeline instead of holding them.
const FALLBACK_DISH: Record<Language, string> = { en: "food", es: "comida" };

export type ComposeIdentity = { senderName: string; postalAddress: string; signature: string };

// Code-owned sign-off, appended outside the editable template body — same
// reasoning as complianceFooter below: the base "{{senderName}}\nClickworthy"
// line shouldn't live duplicated across 8 template bodies (touch1/bump/touch2
// x en/es), and `signature` (title, address, contact links — see Templates
// admin page) is free text the operator controls without touching a template
// at all. Gmail's own signature feature never applies to these emails: every
// send goes through the Gmail API's messages.send directly, bypassing the
// compose-window UI entirely.
export function signatureBlock(identity: ComposeIdentity): string {
  const extra = identity.signature.trim();
  return `\n\n${identity.senderName}\nClickworthy` + (extra ? `\n${extra}` : "");
}

function greeting(firstName: string | null, language: Language): string {
  if (firstName) return language === "es" ? `Hola ${firstName},` : `Hi ${firstName},`;
  return language === "es" ? "Hola," : "Hi there,";
}

// CAN-SPAM requires a valid physical postal address in every commercial email.
// This stays CODE-OWNED, appended outside the editable template body — if a
// template could own it, deleting it would be silent and unlawful. An unset
// address renders an obvious placeholder rather than a blank line, so it's
// caught by reading the email — and the pre-send assertion in sendOutreach.ts
// blocks the send outright regardless.
// The opt-out sentence, per language. CAN-SPAM requires a clear, working,
// single-step opt-out — it does NOT require any particular wording, and
// specifically not the literal word "STOP" (that's an SMS convention, not a
// statute). Dropped 2026-08-27: an uppercase command word in the middle of an
// otherwise conversational sign-off is the single clearest "a machine sent
// this" tell in the whole email, which is exactly what a cold open can't
// afford. "Just reply and say so" is the same promise in the sender's own
// voice, and asking for a plain reply is a LOWER-friction opt-out than asking
// for a keyword, so it reads as more compliant, not less.
//
// The tradeoff, accepted deliberately by the operator: without a keyword,
// isOptOut() below catches far fewer opt-outs automatically. Opt-outs are now
// handled by reading the reply on /admin/photo/outreach and suppressing the
// restaurant by hand. isOptOut() stays as a free safety net for anyone who
// happens to write "stop"/"unsubscribe"/"remove" unprompted.
const OPT_OUT_LINE: Record<Language, string> = {
  en: "Not interested? Just reply and say so — I won't write again.",
  es: "¿No le interesa? Respóndame y no le vuelvo a escribir — sin problema.",
};

// Short, distinctive fragments of the lines above. hasComplianceFooter matches
// these rather than the full sentence so it survives trivial punctuation
// differences — but it is still deliberately strict: the ONLY place a human
// edits a composed body is the Touch 2 hand-edit on the Samples page, and if
// someone rewords the opt-out away entirely the send SHOULD be blocked. That
// is the guard doing its job, not brittleness.
const OPT_OUT_MARKERS = ["reply and say so", "no le vuelvo a escribir"] as const;

export function complianceFooter(language: Language, postalAddress: string): string {
  const address = postalAddress.trim() || "[set your postal address on the Templates page]";
  return `\n\n—\nClickworthy · ${address}\n${OPT_OUT_LINE[language]}`;
}

// Pre-send guard (worker/jobs/sendOutreach.ts sendApproved(), sendBumps.ts):
// confirms a composed body still carries the two CAN-SPAM-required markers
// this footer writes, and that the address wasn't left unconfigured. Catches a
// hand-edited draft that deleted the footer, or any other way the footer could
// go missing, before the email actually sends.
export function hasComplianceFooter(body: string): boolean {
  const hasOptOut = OPT_OUT_MARKERS.some((marker) => body.includes(marker));
  return body.includes("Clickworthy ·") && hasOptOut && !body.includes("[set your postal address");
}

export type OutreachEmail = { subject: string; body: string };

function baseVars(params: {
  restaurantName: string;
  firstName: string | null;
  dish: string;
  city: string | null;
  language: Language;
  senderName: string;
}): TemplateVars {
  return {
    restaurant: params.restaurantName,
    dish: params.dish.trim() || FALLBACK_DISH[params.language],
    firstName: params.firstName ?? "",
    greeting: greeting(params.firstName, params.language),
    city: params.city ?? "",
    senderName: params.senderName,
  };
}

// --- Touch 1 (cold, approved) ------------------------------------------------

export function composeTouch1(params: {
  restaurantName: string;
  firstName: string | null;
  dish: string;
  city: string | null;
  language: Language;
  subjectVariant: number; // rotate deterministically across restaurants
  template: Touch1Template;
  identity: ComposeIdentity;
}): OutreachEmail {
  const { language, template, identity } = params;
  const t = template[language] ?? template.en;
  const v = ((params.subjectVariant % 3) + 3) % 3;

  const vars = baseVars({ ...params, senderName: identity.senderName });
  const subjectTemplate = t.subjects[v] ?? t.subjects[0];

  const subject = sanitizeSubject(renderTemplate(subjectTemplate, vars));
  const body = renderTemplate(t.body, vars) + signatureBlock(identity) + complianceFooter(language, identity.postalAddress);
  return { subject, body };
}

// --- Touch 1.5 bump (approved; sent in-thread, no new subject) --------------
// Widened vs. the original (firstName + language only) so an edited template
// can reference the restaurant and dish too — the caller already has the full
// restaurant row loaded, so this costs nothing extra upstream.

export function composeBump(params: {
  restaurantName: string;
  firstName: string | null;
  dish: string;
  city: string | null;
  language: Language;
  template: BumpTemplate;
  identity: ComposeIdentity;
}): string {
  const { language, template, identity } = params;
  const t = template[language] ?? template.en;
  const vars = baseVars({ ...params, senderName: identity.senderName });
  return renderTemplate(t.body, vars) + signatureBlock(identity) + complianceFooter(language, identity.postalAddress);
}

// --- Free-sample delivery / Touch 2 (solicited; sent the moment a human
// approves the finished sample and its email together) ----------------------
// Template-editable like Touch 1 / bump (see /admin/photo/templates). Unlike
// those two, every send is ALSO reviewed and hand-editable in the moment (see
// app/api/admin/sample/route.ts) — the template here only sets the SEED text,
// not what actually ships.

// Renders the {{pricing}} block from the LIVE package tiers (lib/settings.ts's
// getPackages()) — never a hardcoded constant — so Touch 2 can't quote a price
// the funnel/checkout won't actually charge. Takes the tiers as a plain
// argument rather than fetching them itself: this file stays synchronous/pure
// (see the file header) so the Templates page can live-preview with no
// network round-trip. Callers (samples/page.tsx's real send, the test-send
// route, Touch2Editor's preview) all call getPackages() once and pass the
// same map in here.
export function formatPricingBlock(packages: Record<PackageId, PackageTier>, language: Language): string {
  return PACKAGE_ORDER.map((id) => {
    const pkg = packages[id];
    const price = formatCents(pkg.priceCents);
    const billing = pkg.billingNote[language]?.trim();
    const headline = `${pkg.name[language]} — up to ${pkg.photoLimit} photos, ${price}${billing ? ` (${billing})` : ""}`;
    return `${headline}\n${pkg.blurb[language]}`;
  }).join("\n\n");
}

export function composeTouch2(params: {
  restaurantName: string;
  firstName: string | null;
  dish: string;
  city: string | null;
  funnelUrl: string;
  bookingUrl: string | null;
  pricingBlock: string;
  language: Language;
  template: Touch2Template;
  identity: ComposeIdentity;
}): OutreachEmail {
  const { language, template, identity, funnelUrl, bookingUrl, pricingBlock } = params;
  const t = template[language] ?? template.en;

  // Precomputed, not a template conditional — renderTemplate is flat
  // {{var}} substitution only (see renderTemplate.ts). Empty string when no
  // booking URL is configured, so {{funnelUrl}}{{talkLine}} degrades cleanly.
  const talkLine = bookingUrl
    ? language === "es"
      ? `\n\nO si prefiere hablar primero: ${bookingUrl} — 15 minutos, sin discurso de ventas.`
      : `\n\nOr if you'd rather talk first: ${bookingUrl} — 15 minutes, no pitch marathon.`
    : "";

  const vars: TemplateVars = {
    ...baseVars({ ...params, senderName: identity.senderName }),
    funnelUrl,
    talkLine,
    pricing: pricingBlock,
  };

  const subject = sanitizeSubject(renderTemplate(t.subject, vars));
  const body = renderTemplate(t.body, vars) + signatureBlock(identity) + complianceFooter(language, identity.postalAddress);
  return { subject, body };
}

// Detects a delivery-failure notification (a "bounce") rather than a human
// reply. Bounces land in the SAME Gmail thread as the message that failed, so
// without this the reply poller records them as `replied` — which is exactly
// what happened: on 2026-08-27 the pipeline's one and only recorded "reply"
// across 42 sends was a mailer-daemon "Address not found", making the reply
// rate read 1/42 when the true figure was 0/42. A bounce mistaken for a reply
// also skips suppression, so the dead address stays live and the
// deliverability guard (which counts suppressions) never sees the failure.
//
// Two independent signals, either is enough: the sender is a mail-system
// robot, or the body carries standard DSN wording. Deliberately broad on the
// sender check and conservative on the body wording — a false positive here
// silently discards a real reply, so body phrases must be ones a restaurant
// owner would never write.
const BOUNCE_SENDERS = ["mailer-daemon", "postmaster", "no-reply@", "noreply@"];
const BOUNCE_BODY_MARKERS = [
  "address not found",
  "delivery status notification",
  "undeliverable",
  "wasn't delivered",
  "was not delivered",
  "couldn't be delivered",
  "could not be delivered",
  "delivery incomplete",
  "recipient address rejected",
  "user unknown",
  "mailbox unavailable",
  "does not exist",
];

export function isBounceNotification(fromAddress: string | null | undefined, bodyText: string): boolean {
  const from = (fromAddress ?? "").toLowerCase();
  if (BOUNCE_SENDERS.some((s) => from.includes(s))) return true;
  const body = bodyText.toLowerCase();
  return BOUNCE_BODY_MARKERS.some((m) => body.includes(m));
}

// Pulls the address that FAILED out of a bounce notification's body.
//
// Why this exists: the original bounce handler identified the dead address by
// looking up the Gmail thread the DSN arrived in, on the assumption that a
// bounce always threads with the message it's reporting on. It doesn't — the
// three DSNs sitting in the mailbox on 2026-08-27 (info@tauropizza.com,
// info@pinkyringpizza.com, info@zatar.nyc) each arrived as their OWN thread, so
// the lookup matched nothing and the handler was skipped before it ever ran.
// Across 79 sends the poller had matched exactly one inbound message, and even
// that one came from a local dev run rather than production. Reading the victim
// out of the DSN itself removes the dependency on threading entirely.
//
// Two formats, most reliable first:
//   1. RFC 3464 `Final-Recipient: rfc822; someone@example.com` — the machine-
//      readable part every standards-compliant DSN carries.
//   2. Gmail's prose: "Your message wasn't delivered to someone@example.com
//      because the address couldn't be found."
// Returns null rather than guessing when neither matches — the caller logs that
// instead of suppressing an address it isn't sure about. Suppression is
// effectively permanent for a lead, so a wrong guess here costs a real prospect.
// Both captures are GREEDY and stop only on a character that genuinely can't
// appear in an address (whitespace, angle brackets, comma, semicolon). A lazy
// quantifier with "." among its terminators truncates a@b.example to a@b — the
// dot is a normal domain character, so a trailing SENTENCE period has to be
// stripped afterwards rather than excluded during the match.
const FINAL_RECIPIENT_RE = /Final-Recipient:\s*rfc822\s*;\s*<?([^\s<>,;]+@[^\s<>,;]+)>?/i;
const PROSE_RECIPIENT_RE =
  /\b(?:was ?n[o']t|was not|could ?n[o']t be|could not be|has ?n[o']t been|has not been)\s+deliver(?:ed)?\s+to\s+<?([^\s<>,;]+@[^\s<>,;]+)>?/i;

export function extractBouncedRecipient(bodyText: string): string | null {
  for (const re of [FINAL_RECIPIENT_RE, PROSE_RECIPIENT_RE]) {
    const hit = bodyText.match(re)?.[1];
    // Trim a trailing sentence period ("...delivered to a@b.com.") without
    // eating a legitimate final character.
    const cleaned = hit?.replace(/\.+$/, "").trim().toLowerCase();
    if (cleaned && cleaned.includes("@") && !cleaned.endsWith("@")) return cleaned;
  }
  return null;
}

// Best-effort opt-out detector (plain, case-insensitive, tolerant of
// surrounding whitespace/punctuation). Kept conservative so a genuine reply
// that merely contains the word "stop" mid-sentence isn't misread.
//
// NO LONGER the primary opt-out path. The footer stopped instructing people to
// reply "STOP" on 2026-08-27 (see OPT_OUT_LINE above), so almost nobody will
// send one of these keywords now — they'll write a sentence. Opt-outs are
// handled by a human reading the reply on /admin/photo/outreach and hitting
// Suppress, which is also what the operator wants: see the reply first, decide
// per restaurant. This list stays because catching an unprompted "unsubscribe"
// for free is strictly better than not, not because anything depends on it.
export function isOptOut(replyText: string): boolean {
  const firstLine = replyText.trim().split(/\r?\n/)[0]?.trim().toLowerCase() ?? "";
  const normalized = firstLine.replace(/[.!,]/g, "");
  return ["stop", "unsubscribe", "baja", "no", "remove"].includes(normalized);
}
