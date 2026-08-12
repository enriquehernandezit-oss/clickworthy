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

// Exactly 3 subject lines — sendOutreach.ts rotates across them with
// `subjectVariant % 3`, deterministic per restaurant.
export type OutreachSubjectSet = [string, string, string];

export type Touch1Template = {
  en: { subjects: OutreachSubjectSet; body: string };
  es: { subjects: OutreachSubjectSet; body: string };
};

// No subject: the bump replies into the original Touch 1 thread (see
// worker/jobs/sendBumps.ts), so it never needs one of its own.
export type BumpTemplate = {
  en: { body: string };
  es: { body: string };
};

// One subject (not 3 rotating variants like Touch 1) — Touch 2 is solicited,
// sent once someone's already replied with a photo, so there's no cold-open
// A/B need.
export type Touch2Template = {
  en: { subject: string; body: string };
  es: { subject: string; body: string };
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

  // --- Outreach identity + copy (editable on /admin/photo/templates) ---------
  // Previously read from OUTREACH_SENDER_NAME/OUTREACH_POSTAL_ADDRESS, which were
  // scoped to the worker service only — but the "redraft" action composes on the
  // WEB service, so a redrafted email could silently ship without a real postal
  // address even with the worker's env fully configured. One DB-backed value
  // read by both services removes that failure mode entirely.
  outreach_sender_name: string; // signs every email + the Gmail From name — must match, or mail is signed by one name and sent as another
  outreach_postal_address: string; // CAN-SPAM requires a real physical address in every commercial email; empty renders a loud placeholder AND blocks sending (see sendApproved's pre-send assertion)
  outreach_touch1_template: Touch1Template; // the cold-open email
  outreach_bump_template: BumpTemplate; // the one-time Touch 1.5 follow-up
  outreach_touch2_template: Touch2Template; // the enhanced-sample delivery + funnel link

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
  // ~$36.20/mo: Railway ~$10 + Workspace (3 seats) $25.20 + domain ~$1; Resend free.
  // TODO: Lemwarm is active (confirmed 2026-08-12, not dropped as previously assumed
  // here) and its real monthly cost isn't folded into this figure yet — update once
  // known, on /admin/photo/financials or directly here.
  opex_monthly_cents: 3620,

  outreach_sender_name: "Enrique",
  outreach_postal_address: "", // unset — footer shows a placeholder and sending is blocked until this is filled in

  // Defaults are today's live copy, character-for-character, with the literal
  // interpolations swapped for {{placeholders}}. Shipping this changes nothing
  // until someone edits it on /admin/photo/templates.
  outreach_touch1_template: {
    en: {
      subjects: [
        "your {{dish}} photo",
        "quick question about {{restaurant}}'s photos",
        "the {{dish}} at {{restaurant}}",
      ],
      body:
        "{{greeting}}\n\n" +
        "I was looking at {{restaurant}} online and your {{dish}} caught my eye — but honestly, the photo doesn't do it justice. And photos are doing more selling than menus these days.\n\n" +
        "I run a small studio that enhances real food photos for independent restaurants (no stock images, no fake AI food — your actual dishes, made to look the way they do in person).\n\n" +
        "Want to see it on your own food? Reply with one photo of any dish — even a phone shot — and I'll send it back enhanced within a day. Free, no strings. If you don't love it, delete it and that's that.\n\n" +
        "{{senderName}}\nClickworthy",
    },
    es: {
      subjects: [
        "la foto de su {{dish}}",
        "una pregunta sobre las fotos de {{restaurant}}",
        "el {{dish}} de {{restaurant}}",
      ],
      body:
        "{{greeting}}\n\n" +
        "Estaba viendo {{restaurant}} en línea y el {{dish}} me llamó la atención — pero honestamente, la foto no le hace justicia. Y hoy en día las fotos venden más que el menú.\n\n" +
        "Tengo un estudio pequeño que mejora fotos reales de comida para restaurantes independientes (nada de fotos de banco ni comida falsa de IA — sus platos reales, con el aspecto que tienen en persona).\n\n" +
        "¿Quiere verlo con su propia comida? Responda con una foto de cualquier plato — aunque sea del celular — y se la devuelvo mejorada en un día. Gratis, sin compromiso. Si no le encanta, la borra y ya.\n\n" +
        "{{senderName}}\nClickworthy",
    },
  },
  outreach_bump_template: {
    en: {
      body:
        "{{greeting}}\n\n" +
        "Quick bump in case this got buried.\n\n" +
        "The offer stands: send me one photo of a dish and I'll send it back professionally enhanced, free. Takes you 30 seconds, costs you nothing, and you keep the photo either way.\n\n" +
        "If it's a no, no worries — just say so and I won't follow up again.\n\n" +
        "{{senderName}}",
    },
    es: {
      body:
        "{{greeting}}\n\n" +
        "Un recordatorio rápido por si esto quedó enterrado.\n\n" +
        "La oferta sigue en pie: mándeme una foto de un plato y se la devuelvo mejorada profesionalmente, gratis. Le toma 30 segundos, no cuesta nada, y la foto es suya de todos modos.\n\n" +
        "Si no le interesa, sin problema — dígamelo y no vuelvo a escribir.\n\n" +
        "{{senderName}}",
    },
  },
  // Character-for-character today's hardcoded composeTouch2() prose, with the
  // literal interpolations swapped for {{placeholders}} — same "ships changing
  // nothing" guarantee as the touch1/bump defaults above. {{funnelUrl}} and
  // {{talkLine}} are Touch-2-specific (talkLine is precomputed empty-or-not by
  // whether a booking URL is configured — see worker/lib/outreachEmail.ts).
  outreach_touch2_template: {
    en: {
      subject: "your {{dish}}, enhanced",
      body:
        "{{greeting}}\n\n" +
        "Here it is — your {{dish}}, enhanced. Same photo you sent, nothing invented.\n\n" +
        "That photo is yours. Use it anywhere, no charge, no catch.\n\n" +
        "Here's the part most owners haven't done the math on: the delivery apps take 15–30% of every order — closer to 30–40% once promos and fees pile on — while your own website, Google profile, and Instagram pay you 100%. But for most restaurants, the apps' listings look better than their own channels. So that's where people order.\n\n" +
        "We fix that. We take your top 20–30 dishes, enhance them like the one above, and deliver them sized and ready for your website, Google Business Profile, Instagram, and Yelp — so your own channels finally outsell your DoorDash page. A photographer charges $1,200–$3,500 for a session like that. We do it for a fraction, using photos you already have or shoot on your phone.\n\n" +
        "Everything's here, including your before/after: {{funnelUrl}}{{talkLine}}\n\n" +
        "Either way, enjoy the photo.\n\n" +
        "{{senderName}}\nClickworthy",
    },
    es: {
      subject: "su {{dish}}, mejorado",
      body:
        "{{greeting}}\n\n" +
        "Aquí está — su {{dish}}, mejorado. La misma foto que envió, nada inventado.\n\n" +
        "Esa foto es suya. Úsela donde quiera, sin costo, sin trampa.\n\n" +
        "Ahora, la parte que pocos dueños han calculado: las apps de delivery se quedan con 15–30% de cada orden — más bien 30–40% cuando suman promociones y cargos — mientras que su propio sitio web, perfil de Google e Instagram le pagan el 100%. Pero en la mayoría de los restaurantes, las apps se ven mejor que los canales propios. Y por eso la gente ordena por ahí.\n\n" +
        "Eso es lo que arreglamos. Tomamos sus 20–30 platos principales, los mejoramos como el de arriba, y se los entregamos listos para su sitio web, Google Business Profile, Instagram y Yelp — para que sus propios canales vendan más que su página de DoorDash. Un fotógrafo cobra $1,200–$3,500 por una sesión así. Nosotros lo hacemos por una fracción, con fotos que ya tiene o que toma con su celular.\n\n" +
        "Todo está aquí, incluyendo su antes y después: {{funnelUrl}}{{talkLine}}\n\n" +
        "De cualquier forma, disfrute la foto.\n\n" +
        "{{senderName}}\nClickworthy",
    },
  },
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
