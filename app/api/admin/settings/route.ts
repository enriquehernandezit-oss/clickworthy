import { NextRequest, NextResponse } from "next/server";
import { setSetting, type SettingsMap, type Touch1Template, type BumpTemplate, type Touch2Template } from "@/lib/settings";
import { COST_KEYS } from "@/lib/costs";
import { OUTREACH_TEMPLATE_VARS, TOUCH2_TEMPLATE_VARS } from "@/worker/lib/outreachEmail";
import { validateTemplateSyntax, TemplateRenderError } from "@/worker/lib/renderTemplate";

// Editable settings from /admin/photo/controls, /admin/photo/financials, and
// /admin/photo/templates. Each key has its own validation because the value
// types differ (boolean, positive int, nullable int, non-negative number,
// short text, or a whole bilingual template object).
const BOOLEAN_KEYS = new Set(["outreach_paused", "outreach_autosend"]);
const POSITIVE_INT_KEYS = new Set(["bump_after_days", "outreach_daily_draft_target"]);
const NULLABLE_INT_KEYS = new Set(["outreach_daily_cap"]);
// Cost assumptions (lib/costs.ts): cents, may be fractional and may be 0.
const NON_NEG_NUMBER_KEYS = new Set<string>(COST_KEYS);
// Outreach identity: short strings, editable to empty (postal address starts
// unset; sender name could legitimately be cleared to fall back to nothing).
const TEXT_KEYS = new Set(["outreach_sender_name", "outreach_postal_address"]);
const MAX_TEXT_LEN = 300;
// Whole template objects, sent as a JSON-encoded string in the `value` field.
const TEMPLATE_KEYS = new Set(["outreach_touch1_template", "outreach_touch1_nodish_template", "outreach_bump_template", "outreach_touch2_template"]);

function templateErrorMessage(err: unknown): string {
  return err instanceof TemplateRenderError || err instanceof Error ? err.message : "Invalid template.";
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const key = String(form.get("key") ?? "");
  const raw = String(form.get("value") ?? "");

  if (BOOLEAN_KEYS.has(key)) {
    if (raw !== "true" && raw !== "false") return NextResponse.json({ error: "Value must be true/false" }, { status: 400 });
    await setSetting(key as "outreach_paused" | "outreach_autosend", raw === "true");
    return NextResponse.json({ ok: true, key, value: raw === "true" });
  }

  if (POSITIVE_INT_KEYS.has(key)) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return NextResponse.json({ error: "Value must be a positive integer" }, { status: 400 });
    await setSetting(key as "bump_after_days" | "outreach_daily_draft_target", n);
    return NextResponse.json({ ok: true, key, value: n });
  }

  if (NULLABLE_INT_KEYS.has(key)) {
    // Empty string = clear (use the built-in formula). Any other value must be a positive integer.
    if (raw === "" || raw === "null") {
      await setSetting(key as "outreach_daily_cap", null);
      return NextResponse.json({ ok: true, key, value: null });
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return NextResponse.json({ error: "Value must be a positive integer, or empty to clear." }, { status: 400 });
    await setSetting(key as "outreach_daily_cap", n);
    return NextResponse.json({ ok: true, key, value: n });
  }

  if (NON_NEG_NUMBER_KEYS.has(key)) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "Value must be zero or a positive number." }, { status: 400 });
    }
    await setSetting(key as keyof SettingsMap & (typeof COST_KEYS)[number], n);
    return NextResponse.json({ ok: true, key, value: n });
  }

  if (TEXT_KEYS.has(key)) {
    const trimmed = raw.trim();
    if (trimmed.length > MAX_TEXT_LEN) {
      return NextResponse.json({ error: `Value is too long (max ${MAX_TEXT_LEN} characters).` }, { status: 400 });
    }
    await setSetting(key as "outreach_sender_name" | "outreach_postal_address", trimmed);
    return NextResponse.json({ ok: true, key, value: trimmed });
  }

  if (TEMPLATE_KEYS.has(key)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Template value must be valid JSON." }, { status: 400 });
    }

    // Rejected here, at SAVE time, means a malformed template can never reach a
    // live compose — the worker's own try/catch around compose is a backstop,
    // not the primary defense.
    try {
      if (key === "outreach_touch1_template" || key === "outreach_touch1_nodish_template") {
        const t = parsed as Partial<Touch1Template> | null;
        for (const lang of ["en", "es"] as const) {
          const branch = t?.[lang];
          if (!branch || typeof branch.body !== "string" || !branch.body.trim()) {
            throw new TemplateRenderError(`${lang.toUpperCase()} body is required.`);
          }
          if (
            !Array.isArray(branch.subjects) ||
            branch.subjects.length !== 3 ||
            branch.subjects.some((s) => typeof s !== "string" || !s.trim())
          ) {
            throw new TemplateRenderError(`${lang.toUpperCase()} needs exactly 3 non-empty subject lines.`);
          }
          validateTemplateSyntax(branch.body, OUTREACH_TEMPLATE_VARS);
          for (const s of branch.subjects) validateTemplateSyntax(s, OUTREACH_TEMPLATE_VARS);
        }
      } else if (key === "outreach_touch2_template") {
        const t = parsed as Partial<Touch2Template> | null;
        for (const lang of ["en", "es"] as const) {
          const branch = t?.[lang];
          if (!branch || typeof branch.body !== "string" || !branch.body.trim()) {
            throw new TemplateRenderError(`${lang.toUpperCase()} body is required.`);
          }
          if (typeof branch.subject !== "string" || !branch.subject.trim()) {
            throw new TemplateRenderError(`${lang.toUpperCase()} needs a subject line.`);
          }
          validateTemplateSyntax(branch.body, TOUCH2_TEMPLATE_VARS);
          validateTemplateSyntax(branch.subject, TOUCH2_TEMPLATE_VARS);
        }
      } else {
        const t = parsed as Partial<BumpTemplate> | null;
        for (const lang of ["en", "es"] as const) {
          const branch = t?.[lang];
          if (!branch || typeof branch.body !== "string" || !branch.body.trim()) {
            throw new TemplateRenderError(`${lang.toUpperCase()} body is required.`);
          }
          validateTemplateSyntax(branch.body, OUTREACH_TEMPLATE_VARS);
        }
      }
    } catch (err) {
      return NextResponse.json({ error: templateErrorMessage(err) }, { status: 400 });
    }

    await setSetting(
      key as "outreach_touch1_template" | "outreach_touch1_nodish_template" | "outreach_bump_template" | "outreach_touch2_template",
      parsed as never
    );
    return NextResponse.json({ ok: true, key });
  }

  return NextResponse.json({ error: "Unknown setting" }, { status: 400 });
}
