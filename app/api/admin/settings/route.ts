import { NextRequest, NextResponse } from "next/server";
import { setSetting } from "@/lib/settings";

// Toggle the two boolean outreach settings from /admin/controls.
const TOGGLES = new Set(["outreach_paused", "outreach_autosend"]);

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const key = String(form.get("key") ?? "");
  const raw = String(form.get("value") ?? "");
  if (!TOGGLES.has(key)) return NextResponse.json({ error: "Unknown setting" }, { status: 400 });
  if (raw !== "true" && raw !== "false") return NextResponse.json({ error: "Value must be true/false" }, { status: 400 });

  await setSetting(key as "outreach_paused" | "outreach_autosend", raw === "true");
  return NextResponse.json({ ok: true, key, value: raw === "true" });
}
