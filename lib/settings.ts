// Typed key/value settings on the app_settings table, read at run time by both
// the worker (per job run — never cached at module load, so a toggle in /admin
// takes effect on the next run) and the admin UI.
//
// Only the keys in SettingsMap exist; every read falls back to DEFAULTS when the
// row is absent, so a fresh database behaves correctly with no seeding.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";

// Snapshot of the worker service's env, written on every worker boot. The web
// app can't see the worker's Railway env directly, so this is how /admin shows
// the truth about OUTREACH_ENABLED / dry-run / ramp / crons / cities.
export type WorkerBootInfo = {
  outreachEnabled: boolean;
  dryRun: boolean;
  ramp: { start: number; step: number; cap: number };
  crons: { sourcing: string; send: string; replyPoll: string; package: string; stats: string };
  cities: string[];
  bootedAt: string; // ISO — jsonb can't hold a Date
  // Booleans only — the go-live checklist uses this to know which keys the
  // WORKER service can see. Values themselves are never sent through settings.
  envPresent?: Record<string, boolean>;
};

export type SettingsMap = {
  outreach_paused: boolean; // panic button: blocks all Gmail sending
  outreach_autosend: boolean; // false = approval mode; true = drafts auto-approve + send
  // Override the daily ramp cap. `null` = use the ramp formula (start + step*days,
  // capped at cap). Any positive integer overrides the whole calculation.
  outreach_daily_cap: number | null;
  // Days to wait before sending the one-time Touch 1.5 bump.
  bump_after_days: number;
  worker_boot_info: WorkerBootInfo | null;

  // --- Financials: editable unit-cost assumptions (all in CENTS, decimals ok) ---
  // These drive /admin/photo/financials. Every one is an ESTIMATE — Clickworthy
  // instruments no API call — so calibrate each against the matching monthly
  // invoice. Cents (not dollars) to sit beside the codebase's *_cents convention;
  // fractional because most unit costs are sub-cent, and jsonb stores exact
  // numeric so there's no float drift. See lib/costs.ts for how each is applied.
  cost_source_per_lead_cents: number; // Google Places Text Search, amortized over survivors
  cost_enrich_per_lead_cents: number; // Claude chain-check + web search + NeverBounce
  cost_photo_score_per_photo_cents: number; // Places Photo media fetch + Claude Vision
  cost_email_per_send_cents: number; // Gmail = $0 (Workspace seat is fixed opex)
  cost_sample_per_reply_cents: number; // revenue-impact copy + free-sample Claid pass
  cost_claid_per_photo_cents: number; // AI-Edit + upscale, incl. typical retry waste
  cost_storage_per_photo_cents: number; // R2 + egress, charged once at delivery
  opex_monthly_cents: number; // Railway + Workspace + Resend + domain, apportioned by days
};

const DEFAULTS: SettingsMap = {
  outreach_paused: false,
  outreach_autosend: false,
  outreach_daily_cap: null,
  bump_after_days: 3,
  worker_boot_info: null,

  // Provisional defaults — order-of-magnitude, meant to be replaced with real
  // invoice numbers. Rationale for each is on the SettingsMap field above.
  cost_source_per_lead_cents: 0.4, // ~$0.035/Text Search ÷ 20 results ÷ ~40% filter pass
  cost_enrich_per_lead_cents: 4.0, // Sonnet ~1.5k in/300 out ≈ $0.009 + up to 3 web searches + NeverBounce ~$0.008
  cost_photo_score_per_photo_cents: 0.6, // Places Photo ~$0.007 + Sonnet vision on one image
  cost_email_per_send_cents: 0.0, // Gmail API is free; knob exists so swapping to a paid ESP is one edit
  cost_sample_per_reply_cents: 30.0, // revenue-impact copy + the optional Claid first pass
  cost_claid_per_photo_cents: 6.0, // 2 billable ops/photo. PROVISIONAL — the 3-way Claid test (HANDOFF §C.2) sets the real number
  cost_storage_per_photo_cents: 0.2, // nothing is ever deleted — rough NPV of storing one photo forever
  opex_monthly_cents: 3620, // ~$36.20/mo: Railway ~$10 + Workspace (3 seats) $25.20 + domain ~$1; Resend free, Lemwarm dropped
};

export async function getSetting<K extends keyof SettingsMap>(key: K): Promise<SettingsMap[K]> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  if (!row || row.value == null) return DEFAULTS[key];
  return row.value as SettingsMap[K];
}

export async function setSetting<K extends keyof SettingsMap>(key: K, value: SettingsMap[K]): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

// One round-trip for the whole map, merged over DEFAULTS, plus per-key updatedAt
// (used by the controls panel to show "worker booted Xh ago").
export async function getAllSettings(): Promise<{
  values: SettingsMap;
  updatedAt: Partial<Record<keyof SettingsMap, Date>>;
}> {
  const rows = await db.select().from(appSettings);
  const values: SettingsMap = { ...DEFAULTS };
  const updatedAt: Partial<Record<keyof SettingsMap, Date>> = {};
  for (const row of rows) {
    if (row.key in DEFAULTS) {
      const key = row.key as keyof SettingsMap;
      if (row.value != null) (values[key] as SettingsMap[typeof key]) = row.value as SettingsMap[typeof key];
      if (row.updatedAt) updatedAt[key] = row.updatedAt;
    }
  }
  return { values, updatedAt };
}
