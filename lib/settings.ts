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
  crons: { sourcing: string; send: string; replyPoll: string; package: string; stats: string; sourcingReport: string };
  cities: string[];
  bootedAt: string; // ISO — jsonb can't hold a Date
  // The nightly spend ceiling actually in force on the worker (config default,
  // or WORKER_NIGHTLY_ENRICH_CAP if Railway overrides it). Recorded because it
  // is the single most consequential number in the pipeline and was previously
  // invisible from the web side: after raising the default 50 -> 80 there was
  // no way to confirm which value the deployed worker was really using without
  // reading Railway logs. Optional — rows written before 2026-08-24 lack it.
  nightlyEnrichCap?: number;
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

// High-ticket offer tiers (see lib/packages.ts for the read side —
// getPackages() — and every consumer: checkout, the /l/[token] funnel card,
// the Touch 2 pricing block, and post-payment photo-limit enforcement all
// derive from this ONE setting, so a price/limit change is visible
// everywhere in the same request with no deploy and no drift between what
// the email promises and what checkout charges).
//
// `id` is permanent, never operator-editable — it's persisted in
// payments.packageId and magicLinks.packageSelected, and
// app/admin/photo/clients/page.tsx matches "always_fresh" directly in SQL.
// Defined here (not in lib/packages.ts) to avoid a circular import:
// lib/packages.ts needs getSetting() from this file, so this file can't
// import a value back from lib/packages.ts.
export type PackageId = "glow_up" | "grand_opening" | "always_fresh";

export type PackageTier = {
  id: PackageId;
  name: { en: string; es: string };
  priceCents: number;
  photoLimit: number; // max photos the customer may upload (per delivery / per month)
  blurb: { en: string; es: string };
  billingNote: { en: string; es: string };
  checkoutEnabled: boolean; // false => booking-call CTA instead of Stripe Checkout
};

export type SettingsMap = {
  outreach_paused: boolean; // panic button: blocks all Gmail sending
  outreach_autosend: boolean; // false = approval mode; true = drafts auto-approve + send
  // Override the daily ramp cap. `null` = use the ramp formula (start + step*days,
  // capped at cap). Any positive integer overrides the whole calculation.
  outreach_daily_cap: number | null;
  // Days to wait before sending the one-time Touch 1.5 bump.
  bump_after_days: number;
  // How many NEW Touch-1 drafts the nightly job stages for review in
  // manual-approval mode (autosend paces to the send cap instead). Read fresh
  // each run by worker/jobs/sendOutreach.ts.
  outreach_daily_draft_target: number;
  worker_boot_info: WorkerBootInfo | null;
  // ISO timestamp, written by runReplyPoll() (worker/jobs/pollReplies.ts) the
  // moment it successfully lists the Gmail inbox — i.e. proof the poller that
  // detects "STOP" replies is actually alive, not just that the worker process
  // booted. See getReplyPollHealth() in lib/pipelineHealth.ts.
  reply_poll_last_run: string | null;
  // ISO timestamp of the last staleness alert runReplyPoll() sent (see
  // sendAlert in pollReplies.ts). Debounces the alert so an outage lasting
  // hours pages once every REPLY_POLL_ALERT_COOLDOWN_MINUTES, not every
  // 4-minute tick; cleared back to null the moment the poller succeeds again.
  reply_poll_last_alert: string | null;

  // --- Outreach identity + copy (editable on /admin/photo/templates) ---------
  // Previously read from OUTREACH_SENDER_NAME/OUTREACH_POSTAL_ADDRESS, which were
  // scoped to the worker service only — but the "redraft" action composes on the
  // WEB service, so a redrafted email could silently ship without a real postal
  // address even with the worker's env fully configured. One DB-backed value
  // read by both services removes that failure mode entirely.
  outreach_sender_name: string; // signs every email + the Gmail From name — must match, or mail is signed by one name and sent as another
  outreach_postal_address: string; // CAN-SPAM requires a real physical address in every commercial email; empty renders a loud placeholder AND blocks sending (see sendApproved's pre-send assertion)
  // Free-text lines appended under "{{senderName}}\nClickworthy" on every outreach
  // email (touch1/bump/touch2/reply) — title, address, contact links, etc. Gmail's
  // own signature feature never applies here: every send goes through the Gmail
  // API's messages.send directly, which bypasses the compose-window UI entirely
  // (caught 2026-08-22 — Enrique's configured Gmail signature never appeared on
  // any outreach email, silently, since the mailbox went live). Empty = just the
  // bare "{{senderName}}\nClickworthy" line, same as before this setting existed.
  outreach_signature: string;
  outreach_touch1_template: Touch1Template; // the cold-open email (leads WITH a signature dish)
  outreach_touch1_nodish_template: Touch1Template; // cold-open for leads with NO signature dish — the dish-personalized copy would read wrong for them
  outreach_bump_template: BumpTemplate; // the one-time Touch 1.5 follow-up
  outreach_touch2_template: Touch2Template; // the enhanced-sample delivery + funnel link
  package_tiers: Record<PackageId, PackageTier>; // editable on /admin/photo/templates — see the PackageTier comment above

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
  // Fixed monthly subscriptions, ITEMIZED rather than one opaque total, so the
  // financials page can show what the money actually goes to (and so a price
  // change is a one-line edit against a named vendor). The total is derived —
  // see opexMonthlyCents() in lib/costs.ts — never stored separately.
  opex_items: OpexItem[];
};

// One fixed cost line — recurring monthly by default.
export type OpexItem = {
  label: string;
  cents: number; // per month, or the total charge when oneTimeOn is set
  note?: string; // optional context shown under the label
  // Set to make this a ONE-TIME charge (a setup/onboarding fee) counted only in
  // the reporting window containing this date, instead of every month forever.
  // Without it a $30 setup fee would silently become $360/yr of phantom opex.
  oneTimeOn?: string; // 'YYYY-MM-DD'
};

const DEFAULTS: SettingsMap = {
  outreach_paused: false,
  outreach_autosend: false,
  outreach_daily_cap: null,
  bump_after_days: 3,
  outreach_daily_draft_target: 20,
  worker_boot_info: null,
  reply_poll_last_run: null,
  reply_poll_last_alert: null,

  // Calibrated 2026-08-18 against measured API usage and the real subscription
  // list (was: provisional order-of-magnitude guesses). Every line says where
  // its number came from; anything still unmeasured is marked PROVISIONAL.
  cost_source_per_lead_cents: 0.2, // Text Search ~$0.035 ÷ 20 results, spread over the wide-net pass rate; the search itself is rounding error — photo scoring is the real per-lead cost
  // The chain check (Claude + up to 3 web searches) is the only paid Claude call
  // in enrichment. This was 0.0 on the assumption the check was OFF — stale since
  // 2026-08-21 when it was enabled, so Financials reported $0 for what was
  // actually the single largest line item (~$4-5/night, measured Aug 20-23: 273
  // checks over 4 days at ~$0.06-0.08 each).
  //
  // 7.0 = ~$0.07 per CHECKED lead. Note this is charged per lead that reaches
  // the check, and since 2026-08-24 the check only runs on leads that got a
  // verified email (enrichRestaurant step 4) — roughly 1 in 8 of what reaches
  // enrichment. lib/costs.ts applies it per enriched lead, so this slightly
  // OVERSTATES spend; that's the safe direction, and it beats the old $0.
  // Recalibrate against a real Anthropic invoice when there's a month of data.
  // NeverBounce stays out of here — flat subscription, in opex_items below.
  cost_enrich_per_lead_cents: 7.0,
  // MEASURED 2026-08-18: one Claude Vision call = 846 input + 132 output tokens
  // on claude-sonnet-5 ≈ $0.0030, plus a Places Photo fetch ~$0.007 ≈ $0.010.
  // NOTE: Sonnet 5 intro pricing ($2/$10 per MTok) ends 2026-08-31 → standard
  // ($3/$15) puts the Vision half at ~$0.0045, so raise this to ~1.15 then.
  cost_photo_score_per_photo_cents: 1.0,
  cost_email_per_send_cents: 0.0, // Gmail API is free; knob exists so swapping to a paid ESP is one edit
  // Revenue-impact copy ONLY (~300 output tokens ≈ $0.005). This was 7.0 on the
  // assumption that every reply also cost "one Claid first pass" — but that pass
  // is a MANUAL button on the Samples page (app/api/admin/sample/route.ts), so
  // it does not happen just because a reply arrived. Caught 2026-08-24: the one
  // sample on file (Johnny's Shrimp Boat) had free_sample_first_pass_url = null,
  // i.e. Claid had never run, yet Financials billed 7¢ for it. Real first passes
  // are now counted from that column and billed at cost_claid_per_photo_cents
  // (see the `fs` CTE in lib/financeStats.ts), so nothing is lost — it is just
  // charged when it actually happens instead of assumed.
  cost_sample_per_reply_cents: 0.5,
  cost_claid_per_photo_cents: 6.0, // 2 billable ops/photo. PROVISIONAL — no photo has been enhanced yet, so this has never met an invoice. Drives $0 today (0 photos delivered) and starts costing the moment the first order ships.
  cost_storage_per_photo_cents: 0.2, // nothing is ever deleted — rough NPV of storing one photo forever
  // Real costs as of 2026-08-18. Anthropic and Google Places are NOT here —
  // they're usage-based and already priced per-event above. Cloudflare R2 is
  // absent on purpose: egress is free and storage sits inside the 10 GB free
  // tier at this volume, so it bills $0 (cost_storage_per_photo_cents carries
  // the long-run placeholder).
  opex_items: [
    { label: "Railway", cents: 1000, note: "worker + web services" },
    { label: "Google Workspace", cents: 2400, note: "sending mailbox" },
    { label: "NeverBounce", cents: 800, note: "1,000 verification credits/mo" },
    { label: "Domain", cents: 100, note: "clickworthytool.com" },
    // One-time setup, first month only. VERIFY: Lemwarm normally bills monthly
    // (~$30/mo) — if the card is charged again, drop oneTimeOn to make it
    // recurring, which raises fixed opex from $43 to ~$73/mo.
    { label: "Lemwarm", cents: 3000, note: "one-time setup fee", oneTimeOn: "2026-08-01" },
  ],

  outreach_sender_name: "Enrique",
  outreach_postal_address: "", // unset — footer shows a placeholder and sending is blocked until this is filled in
  outreach_signature: "", // unset — emails sign off with just "{{senderName}}\nClickworthy" until this is filled in

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
        "Want to see it on your own food? Reply with one photo of any dish — even a phone shot — and I'll send it back enhanced within a day. Free, no strings. If you don't love it, delete it and that's that.",
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
        "¿Quiere verlo con su propia comida? Responda con una foto de cualquier plato — aunque sea del celular — y se la devuelvo mejorada en un día. Gratis, sin compromiso. Si no le encanta, la borra y ya.",
    },
  },
  // Cold-open for leads with NO signature dish on file. Same offer and shape as
  // outreach_touch1_template, but every {{dish}} reference is gone — it leans on
  // the restaurant name instead, so it reads naturally when there's no dish to
  // name. sendOutreach picks this automatically when a lead has no dish.
  outreach_touch1_nodish_template: {
    en: {
      subjects: [
        "your photos at {{restaurant}}",
        "quick question about {{restaurant}}'s photos",
        "the food photos at {{restaurant}}",
      ],
      body:
        "{{greeting}}\n\n" +
        "I was looking at {{restaurant}} online and your food looks great — but honestly, the photos don't do it justice. And photos are doing more selling than menus these days.\n\n" +
        "I run a small studio that enhances real food photos for independent restaurants (no stock images, no fake AI food — your actual dishes, made to look the way they do in person).\n\n" +
        "Want to see it on your own food? Reply with one photo of any dish — even a phone shot — and I'll send it back enhanced within a day. Free, no strings. If you don't love it, delete it and that's that.",
    },
    es: {
      subjects: [
        "sus fotos en {{restaurant}}",
        "una pregunta sobre las fotos de {{restaurant}}",
        "las fotos de comida de {{restaurant}}",
      ],
      body:
        "{{greeting}}\n\n" +
        "Estaba viendo {{restaurant}} en línea y su comida se ve muy bien — pero honestamente, las fotos no le hacen justicia. Y hoy en día las fotos venden más que el menú.\n\n" +
        "Tengo un estudio pequeño que mejora fotos reales de comida para restaurantes independientes (nada de fotos de banco ni comida falsa de IA — sus platos reales, con el aspecto que tienen en persona).\n\n" +
        "¿Quiere verlo con su propia comida? Responda con una foto de cualquier plato — aunque sea del celular — y se la devuelvo mejorada en un día. Gratis, sin compromiso. Si no le encanta, la borra y ya.",
    },
  },
  outreach_bump_template: {
    en: {
      body:
        "{{greeting}}\n\n" +
        "Quick bump in case this got buried.\n\n" +
        "The offer stands: send me one photo of a dish and I'll send it back professionally enhanced, free. Takes you 30 seconds, costs you nothing, and you keep the photo either way.\n\n" +
        "If it's a no, no worries — just say so and I won't follow up again.",
    },
    es: {
      body:
        "{{greeting}}\n\n" +
        "Un recordatorio rápido por si esto quedó enterrado.\n\n" +
        "La oferta sigue en pie: mándeme una foto de un plato y se la devuelvo mejorada profesionalmente, gratis. Le toma 30 segundos, no cuesta nada, y la foto es suya de todos modos.\n\n" +
        "Si no le interesa, sin problema — dígamelo y no vuelvo a escribir.",
    },
  },
  // Character-for-character today's hardcoded composeTouch2() prose, with the
  // literal interpolations swapped for {{placeholders}} — same "ships changing
  // nothing" guarantee as the touch1/bump defaults above. {{funnelUrl}} and
  // {{talkLine}} are Touch-2-specific (talkLine is precomputed empty-or-not by
  // whether a booking URL is configured — see worker/lib/outreachEmail.ts).
  // Subject dropped {{dish}} 2026-08-27 (operator: "we're not using dish
  // anymore, but it's optional") — a fixed subject reads fine whether or not
  // a lead has a signature dish on file, and {{dish}} stays available in the
  // body for anyone who wants to use it (baseVars still substitutes a
  // "food"/"comida" fallback when there's none, same as before).
  //
  // {{pricing}} replaces the old hardcoded price prose — it's now RENDERED
  // from the live package_tiers setting (see composeTouch2's pricingBlock
  // param in worker/lib/outreachEmail.ts), so this template can never quote a
  // number the funnel page won't actually charge. Edit prices in the "Package
  // pricing" box on this page, not here.
  outreach_touch2_template: {
    en: {
      subject: "your photo, enhanced",
      body:
        "{{greeting}}\n\n" +
        "Here it is — your {{dish}}, enhanced. Same photo you sent, nothing invented.\n\n" +
        "That photo is yours. Use it anywhere, no charge, no catch.\n\n" +
        "Here's something worth a second look, and totally understandable if it's never come up before: the delivery apps take 15–30% of every order — closer to 30–40% once promos and fees pile on — while your own website, Google profile, and Instagram pay you 100%. But for most restaurants, the apps' listings just look better than their own channels, so that's naturally where people end up ordering.\n\n" +
        "We fix that. We take your top dishes, enhance them like the one above, and deliver them sized and ready for your website, Google Business Profile, Instagram, and Yelp — so your own channels finally outsell your DoorDash page. A photographer charges $1,200–$3,500 for a session like that. We do it for a fraction, using photos you already have or shoot on your phone.\n\n" +
        "Here's how it works if you want more:\n\n" +
        "{{pricing}}\n\n" +
        "Everything's here, including your before/after: {{funnelUrl}}{{talkLine}}\n\n" +
        "Either way, enjoy the photo.",
    },
    es: {
      subject: "su foto, mejorada",
      body:
        "{{greeting}}\n\n" +
        "Aquí está — su {{dish}}, mejorado. La misma foto que envió, nada inventado.\n\n" +
        "Esa foto es suya. Úsela donde quiera, sin costo, sin trampa.\n\n" +
        "Algo que vale la pena mirar de nuevo, y es entendible si nunca lo había pensado: las apps de delivery se quedan con 15–30% de cada orden — más bien 30–40% cuando suman promociones y cargos — mientras que su propio sitio web, perfil de Google e Instagram le pagan el 100%. Pero en la mayoría de los restaurantes, las apps simplemente se ven mejor que los canales propios, y por eso la gente termina ordenando por ahí.\n\n" +
        "Eso es lo que arreglamos. Tomamos sus platos principales, los mejoramos como el de arriba, y se los entregamos listos para su sitio web, Google Business Profile, Instagram y Yelp — para que sus propios canales vendan más que su página de DoorDash. Un fotógrafo cobra $1,200–$3,500 por una sesión así. Nosotros lo hacemos por una fracción, con fotos que ya tiene o que toma con su celular.\n\n" +
        "Así funciona si quiere más:\n\n" +
        "{{pricing}}\n\n" +
        "Todo está aquí, incluyendo su antes y después: {{funnelUrl}}{{talkLine}}\n\n" +
        "De cualquier forma, disfrute la foto.",
    },
  },

  // Fallback until an operator saves the price box on /admin/photo/templates
  // for the first time. Values as of 2026-08-27 — see the PackageTier comment
  // above for why `id` is not editable.
  package_tiers: {
    glow_up: {
      id: "glow_up",
      name: { en: "Menu Glow-Up", es: "Renovación de Menú" },
      priceCents: 49900,
      photoLimit: 30,
      blurb: {
        en: "Up to 30 dishes enhanced, sized for your site, Google, Instagram & Yelp",
        es: "Hasta 30 platos mejorados, listos para su sitio, Google, Instagram y Yelp",
      },
      billingNote: { en: "one-time", es: "pago único" },
      checkoutEnabled: true,
    },
    grand_opening: {
      id: "grand_opening",
      name: { en: "Grand Opening Package", es: "Paquete de Apertura" },
      priceCents: 89900,
      photoLimit: 40,
      blurb: {
        en: "Up to 40 photos — dishes plus interior & exterior, social-ready",
        es: "Hasta 40 fotos — platos más interior y exterior, listas para redes",
      },
      billingNote: { en: "one-time", es: "pago único" },
      checkoutEnabled: true,
    },
    always_fresh: {
      id: "always_fresh",
      name: { en: "Always Fresh", es: "Siempre Fresco" },
      priceCents: 24900,
      photoLimit: 8,
      blurb: {
        en: "8 photos/month — specials & seasonal items kept looking their best",
        es: "8 fotos al mes — especiales y platos de temporada siempre impecables",
      },
      billingNote: { en: "per month · 3-month minimum", es: "por mes · mínimo 3 meses" },
      checkoutEnabled: false,
    },
  },
};

export async function getSetting<K extends keyof SettingsMap>(key: K): Promise<SettingsMap[K]> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  if (!row || row.value == null) return DEFAULTS[key];
  return row.value as SettingsMap[K];
}

// The live package tiers — thin wrapper kept HERE, not in lib/packages.ts.
// lib/packages.ts is imported by client components (FunnelClient.tsx,
// PaymentLinkForm.tsx) for its pure/sync exports (PACKAGE_ORDER, isPackageId,
// formatCents); this file's `db` import (via getSetting) is a real module-load
// side effect (db/index.ts calls postgres(...) at module scope) that a bundler
// can't tree-shake away — confirmed the hard way: even a dynamic import()
// inside packages.ts still pulled db/postgres into the client bundle and broke
// the production build ("Module not found: Can't resolve 'tls'"). Nothing
// client-side has ever imported a runtime value from THIS file (only
// `import type` for the template types), so defining getPackages here instead
// keeps that invariant intact. Callers: `import { getPackages } from
// "@/lib/settings"`, alongside `import { isPackageId, ... } from
// "@/lib/packages"` for the sync pieces.
export async function getPackages(): Promise<Record<PackageId, PackageTier>> {
  return getSetting("package_tiers");
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
