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
import { renderTemplate, sanitizeSubject, type TemplateVars } from "./renderTemplate";

// The only placeholders a template may reference. Shared with the settings
// validation route so "what can I use" and "what's allowed to save" can't drift.
export const OUTREACH_TEMPLATE_VARS = ["restaurant", "dish", "firstName", "greeting", "city", "senderName"] as const;

// Touch 2 adds two of its own on top of the shared set — both Touch-2-specific,
// so they're not offered on Touch 1 / bump (which are deliberately link-free).
export const TOUCH2_TEMPLATE_VARS = [...OUTREACH_TEMPLATE_VARS, "funnelUrl", "talkLine"] as const;

export type Language = "en" | "es";

export function normalizeLanguage(value: string | null | undefined): Language {
  return value === "es" ? "es" : "en";
}

export type ComposeIdentity = { senderName: string; postalAddress: string };

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
export function complianceFooter(language: Language, postalAddress: string): string {
  const address = postalAddress.trim() || "[set your postal address on the Templates page]";
  if (language === "es") {
    return (
      `\n\n—\nClickworthy · ${address}\n` +
      `Si prefiere no recibir más mensajes, responda con STOP y no volveremos a escribirle.`
    );
  }
  return (
    `\n\n—\nClickworthy · ${address}\n` +
    `Prefer not to hear from us? Reply STOP and we won't email you again.`
  );
}

// Pre-send guard (worker/jobs/sendOutreach.ts sendApproved(), sendBumps.ts):
// confirms a composed body still carries the two CAN-SPAM-required markers
// this footer writes, and that the address wasn't left unconfigured. Catches a
// hand-edited draft that deleted the footer, or any other way the footer could
// go missing, before the email actually sends.
export function hasComplianceFooter(body: string): boolean {
  return body.includes("Clickworthy ·") && /\bSTOP\b/.test(body) && !body.includes("[set your postal address");
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
    dish: params.dish,
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
  const body = renderTemplate(t.body, vars) + complianceFooter(language, identity.postalAddress);
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
  return renderTemplate(t.body, vars) + complianceFooter(language, identity.postalAddress);
}

// --- Free-sample delivery / Touch 2 (solicited; sent the moment a human
// approves the finished sample and its email together) ----------------------
// Template-editable like Touch 1 / bump (see /admin/photo/templates). Unlike
// those two, every send is ALSO reviewed and hand-editable in the moment (see
// app/api/admin/sample/route.ts) — the template here only sets the SEED text,
// not what actually ships.

export function composeTouch2(params: {
  restaurantName: string;
  firstName: string | null;
  dish: string;
  city: string | null;
  funnelUrl: string;
  bookingUrl: string | null;
  language: Language;
  template: Touch2Template;
  identity: ComposeIdentity;
}): OutreachEmail {
  const { language, template, identity, funnelUrl, bookingUrl } = params;
  const t = template[language] ?? template.en;

  // Precomputed, not a template conditional — renderTemplate is flat
  // {{var}} substitution only (see renderTemplate.ts). Empty string when no
  // booking URL is configured, so {{funnelUrl}}{{talkLine}} degrades cleanly.
  const talkLine = bookingUrl
    ? language === "es"
      ? `\n\nO si prefiere hablar primero: ${bookingUrl} — 15 minutos, sin discurso de ventas.`
      : `\n\nOr if you'd rather talk first: ${bookingUrl} — 15 minutes, no pitch marathon.`
    : "";

  const vars: TemplateVars = { ...baseVars({ ...params, senderName: identity.senderName }), funnelUrl, talkLine };

  const subject = sanitizeSubject(renderTemplate(t.subject, vars));
  const body = renderTemplate(t.body, vars) + complianceFooter(language, identity.postalAddress);
  return { subject, body };
}

// Detects a "STOP"/opt-out reply (plain, case-insensitive, tolerant of
// surrounding whitespace/punctuation). Kept conservative so a genuine reply
// that merely contains the word "stop" mid-sentence isn't misread. Coupled to
// the footer's opt-out instruction above — if that copy ever stops saying
// "STOP", this list needs to move with it.
export function isOptOut(replyText: string): boolean {
  const firstLine = replyText.trim().split(/\r?\n/)[0]?.trim().toLowerCase() ?? "";
  const normalized = firstLine.replace(/[.!,]/g, "");
  return ["stop", "unsubscribe", "baja", "no", "remove"].includes(normalized);
}
