import { NextRequest, NextResponse } from "next/server";
import { setSetting, type SettingsMap } from "@/lib/settings";
import { COST_KEYS } from "@/lib/costs";

// Editable settings from /admin/photo/controls and /admin/photo/financials. Each
// key has its own validation because the value types differ (boolean, positive
// int, nullable int, non-negative number).
const BOOLEAN_KEYS = new Set(["outreach_paused", "outreach_autosend"]);
const POSITIVE_INT_KEYS = new Set(["bump_after_days"]);
const NULLABLE_INT_KEYS = new Set(["outreach_daily_cap"]);
// Cost assumptions (lib/costs.ts): cents, may be fractional and may be 0.
const NON_NEG_NUMBER_KEYS = new Set<string>(COST_KEYS);

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
    await setSetting(key as "bump_after_days", n);
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

  return NextResponse.json({ error: "Unknown setting" }, { status: 400 });
}
