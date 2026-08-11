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

import type { BumpTemplate, Touch1Template } from "@/lib/settings";
import { renderTemplate, sanitizeSubject, type TemplateVars } from "./renderTemplate";

// The only placeholders a template may reference. Shared with the settings
// validation route so "what can I use" and "what's allowed to save" can't drift.
export const OUTREACH_TEMPLATE_VARS = ["restaurant", "dish", "firstName", "greeting", "city", "senderName"] as const;

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
function complianceFooter(language: Language, postalAddress: string): string {
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

// --- Free-sample delivery / Touch 2 (locked copy, not template-editable) ----
// Out of scope for the template editor (only Touch 1 / 1.5 were asked for),
// but it shares the same identity settings, so it takes `identity` instead of
// the old module-level senderName()/postalAddress() functions.

export function composeTouch2(params: {
  restaurantName: string;
  firstName: string | null;
  dish: string;
  funnelUrl: string;
  bookingUrl: string | null;
  language: Language;
  identity: ComposeIdentity;
}): OutreachEmail {
  const { firstName, dish, funnelUrl, bookingUrl, language, identity } = params;

  const subject = language === "es" ? `su ${dish}, mejorado` : `your ${dish}, enhanced`;

  const talkLine = bookingUrl
    ? language === "es"
      ? `\n\nO si prefiere hablar primero: ${bookingUrl} — 15 minutos, sin discurso de ventas.`
      : `\n\nOr if you'd rather talk first: ${bookingUrl} — 15 minutes, no pitch marathon.`
    : "";

  const body =
    language === "es"
      ? `${greeting(firstName, language)}\n\n` +
        `Aquí está — su ${dish}, mejorado. La misma foto que envió, nada inventado.\n\n` +
        `Esa foto es suya. Úsela donde quiera, sin costo, sin trampa.\n\n` +
        `Ahora, la parte que pocos dueños han calculado: las apps de delivery se quedan con 15–30% de cada orden — más bien 30–40% cuando suman promociones y cargos — mientras que su propio sitio web, perfil de Google e Instagram le pagan el 100%. Pero en la mayoría de los restaurantes, las apps se ven mejor que los canales propios. Y por eso la gente ordena por ahí.\n\n` +
        `Eso es lo que arreglamos. Tomamos sus 20–30 platos principales, los mejoramos como el de arriba, y se los entregamos listos para su sitio web, Google Business Profile, Instagram y Yelp — para que sus propios canales vendan más que su página de DoorDash. Un fotógrafo cobra $1,200–$3,500 por una sesión así. Nosotros lo hacemos por una fracción, con fotos que ya tiene o que toma con su celular.\n\n` +
        `Todo está aquí, incluyendo su antes y después: ${funnelUrl}${talkLine}\n\n` +
        `De cualquier forma, disfrute la foto.\n\n` +
        `${identity.senderName}\nClickworthy`
      : `${greeting(firstName, language)}\n\n` +
        `Here it is — your ${dish}, enhanced. Same photo you sent, nothing invented.\n\n` +
        `That photo is yours. Use it anywhere, no charge, no catch.\n\n` +
        `Here's the part most owners haven't done the math on: the delivery apps take 15–30% of every order — closer to 30–40% once promos and fees pile on — while your own website, Google profile, and Instagram pay you 100%. But for most restaurants, the apps' listings look better than their own channels. So that's where people order.\n\n` +
        `We fix that. We take your top 20–30 dishes, enhance them like the one above, and deliver them sized and ready for your website, Google Business Profile, Instagram, and Yelp — so your own channels finally outsell your DoorDash page. A photographer charges $1,200–$3,500 for a session like that. We do it for a fraction, using photos you already have or shoot on your phone.\n\n` +
        `Everything's here, including your before/after: ${funnelUrl}${talkLine}\n\n` +
        `Either way, enjoy the photo.\n\n` +
        `${identity.senderName}\nClickworthy`;

  return { subject, body: body + complianceFooter(language, identity.postalAddress) };
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
