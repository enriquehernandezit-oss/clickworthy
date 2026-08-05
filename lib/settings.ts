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
};

export type SettingsMap = {
  outreach_paused: boolean; // panic button: blocks all Gmail sending
  outreach_autosend: boolean; // false = approval mode; true = drafts auto-approve + send
  worker_boot_info: WorkerBootInfo | null;
};

const DEFAULTS: SettingsMap = {
  outreach_paused: false,
  outreach_autosend: false,
  worker_boot_info: null,
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
