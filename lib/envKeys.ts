// Every environment variable the go-live checklist tracks.
// The checklist reports whether each is SET or MISSING — value is never read.
//
// `scope` says which Railway service needs it:
//   web    → the Next app only (Stripe, admin session, download proxy origin)
//   worker → the background service only (Google Places, NeverBounce, Gmail SA)
//   both   → both services (Anthropic for moderation + Vision; alerts; postal)
//
// `blocks` is the plain-English "what breaks if this is missing" — shown to
// the operator so it's clear why to bother filling one in.

export type EnvKey = {
  name: string;
  scope: "web" | "worker" | "both";
  required: boolean; // false = optional (soft-degrades)
  blocks: string;
};

export const ENV_KEYS: EnvKey[] = [
  // --- Core plumbing (both services) -----------------------------------------
  { name: "DATABASE_URL", scope: "both", required: true, blocks: "Everything — the app can't start." },
  { name: "ANTHROPIC_API_KEY", scope: "both", required: true, blocks: "Photo scoring, moderation, and every Claude-generated copy — sourcing halts without it." },
  { name: "APP_ORIGIN", scope: "both", required: true, blocks: "Photo URLs stored in Postgres blob fallback point at localhost — Claid can't fetch them." },
  { name: "SESSION_SECRET", scope: "web", required: true, blocks: "Admin console fails closed — nobody can log in." },

  // --- Payments (web) --------------------------------------------------------
  { name: "STRIPE_SECRET_KEY", scope: "web", required: true, blocks: "Stripe Checkout — no self-serve or package purchases can start." },
  { name: "STRIPE_PUBLISHABLE_KEY", scope: "web", required: false, blocks: "Documented but not currently read by any code." },
  { name: "STRIPE_WEBHOOK_SECRET", scope: "web", required: true, blocks: "The Stripe webhook rejects requests — paid orders never enter the pipeline." },

  // --- Image enhancement -----------------------------------------------------
  { name: "CLAID_API_KEY", scope: "both", required: true, blocks: "The actual photo enhancement." },

  // --- R2 storage (all five required together, or all missing) ---------------
  { name: "R2_ACCESS_KEY_ID", scope: "both", required: false, blocks: "R2 storage — all five R2 keys must be set together, or storage falls back to Postgres blobs (works locally, fails in prod because Claid can't reach localhost)." },
  { name: "R2_SECRET_ACCESS_KEY", scope: "both", required: false, blocks: "R2 storage (see R2_ACCESS_KEY_ID)." },
  { name: "R2_BUCKET_NAME", scope: "both", required: false, blocks: "R2 storage (see R2_ACCESS_KEY_ID)." },
  { name: "R2_ACCOUNT_ID", scope: "both", required: false, blocks: "R2 storage (see R2_ACCESS_KEY_ID)." },
  { name: "R2_PUBLIC_URL_BASE", scope: "both", required: false, blocks: "R2 storage (see R2_ACCESS_KEY_ID)." },

  // --- Lead sourcing (worker) ------------------------------------------------
  { name: "GOOGLE_MAPS_API_KEY", scope: "worker", required: true, blocks: "Nightly lead sourcing (Google Places)." },
  { name: "NEVERBOUNCE_API_KEY", scope: "worker", required: true, blocks: "Email verification during enrichment — rows get 'needs_manual_email' by default." },

  // --- Gmail (worker + web for manual compose) ------------------------------
  { name: "GOOGLE_SERVICE_ACCOUNT_JSON", scope: "both", required: true, blocks: "All Gmail sending + reply polling (Touch 1/2, bump, manual compose). Web needs it too for the compose form." },
  { name: "GMAIL_SENDER", scope: "both", required: true, blocks: "Gmail service account has nothing to impersonate — same failure mode as no key." },

  // --- Transactional email (Resend) -----------------------------------------
  { name: "RESEND_API_KEY", scope: "both", required: true, blocks: "Operator alerts + the customer 'photos are ready' email — both fail silently." },
  { name: "ALERT_EMAIL_TO", scope: "both", required: true, blocks: "You never learn a restaurant replied or an order failed." },
  { name: "ALERT_EMAIL_FROM", scope: "both", required: false, blocks: "Falls back to alerts@clickworthytool.com — fine if that's a real mailbox." },

  // --- Compliance + funnel booking ------------------------------------------
  { name: "OUTREACH_POSTAL_ADDRESS", scope: "worker", required: true, blocks: "CAN-SPAM footer ships a visible '[set OUTREACH_POSTAL_ADDRESS]' placeholder — every cold email is out of compliance." },
  { name: "NEXT_PUBLIC_BOOKING_URL", scope: "web", required: false, blocks: "Always Fresh tier's 'Book a call' button hidden — the tier still shows in the funnel." },
  { name: "OUTREACH_SENDER_NAME", scope: "worker", required: false, blocks: "Email signature falls back to 'Enrique'." },
];

// The list of names the worker checks on boot, published to the checklist.
export const WORKER_ENV_KEYS: readonly string[] = ENV_KEYS.filter((k) => k.scope !== "web").map((k) => k.name);
export const WEB_ENV_KEYS: readonly string[] = ENV_KEYS.filter((k) => k.scope !== "worker").map((k) => k.name);

// Never sends values — just booleans.
export function envPresence(names: readonly string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const n of names) out[n] = Boolean(process.env[n] && process.env[n]!.trim());
  return out;
}
