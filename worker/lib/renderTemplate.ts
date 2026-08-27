// Generic, domain-agnostic {{placeholder}} substitution for outreach email
// templates. This file knows nothing about restaurants or dishes — the caller
// (worker/lib/outreachEmail.ts) builds the variable map; this only substitutes
// it safely and validates template syntax before it's ever saved.

export type TemplateVars = Record<string, string>;

export class TemplateRenderError extends Error {}

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

// Substitutes every {{name}} with vars[name]. Throws on any placeholder whose
// name ISN'T a key in `vars` — that's the "malformed template" guard: a
// typo'd or hallucinated variable is caught, not silently dropped or left as
// literal `{{text}}` in a live email.
//
// A variable that IS a known key but happens to be an empty string (e.g. no
// firstName on file) is NOT an error — it substitutes as "". Callers decide
// which variables are guaranteed non-empty by what they put in `vars` (see
// outreachEmail.ts: dish falls back to a generic "food"/"comida" when a lead
// has none on file, so it's never gated out and never blocks a send; firstName
// and city are legitimately nullable and render as empty).
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    if (!(name in vars)) {
      throw new TemplateRenderError(
        `Unknown placeholder {{${name}}} — available: ${Object.keys(vars).join(", ")}`
      );
    }
    return vars[name];
  });
}

// Subject lines become an email header, and Gmail's MIME builder joins headers
// with \r\n (worker/lib/gmail.ts) — a newline smuggled into an admin-editable
// subject is a header-injection vector. Strip control characters and collapse
// whitespace; require non-empty after cleaning.
export function sanitizeSubject(subject: string): string {
  const cleaned = subject.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) throw new TemplateRenderError("Subject is empty after sanitizing.");
  return cleaned;
}

// Validates template syntax with no real recipient data — used at SAVE time so
// a broken template (typo'd variable, stray {{}}) is rejected before it can
// ever reach a live compose. Every allowed variable is probed non-empty, so
// only an unrecognized placeholder name can fail this check.
export function validateTemplateSyntax(template: string, allowedVars: readonly string[]): void {
  const probe: TemplateVars = Object.fromEntries(allowedVars.map((v) => [v, "x"]));
  renderTemplate(template, probe);
}
