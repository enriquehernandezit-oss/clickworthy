// Static reference content for /admin/guide. Kept as typed data (the
// app/l/[token]/copy.ts pattern) so it's version-controlled and reviewable in
// a diff, rather than editable-and-forgotten in the database like the outreach
// templates are. The live parts of the guide (queue counts) come from
// lib/photoStats.ts's getNeedsAttention() instead — see page.tsx.

export type DailyStep = { title: string; detail: string; href: string };

export const DAILY_STEPS: DailyStep[] = [
  {
    title: "Clear Approvals",
    detail: "Touch 1, the bump, a reply, and a payment confirmation all land here as drafts. Nothing sends until you approve, edit, deny — or for a reply, write it yourself and send. Once you approve, it goes out on its own within about 20 minutes; you no longer have to trigger a send.",
    href: "/admin/photo/approvals",
  },
  {
    title: "Edit & approve samples",
    detail: "A reply with a photo becomes a free sample here. Finish it by hand (Claid's first pass is a starting point, not the final version), then review the Touch 2 email and Approve & Send — both together, right here.",
    href: "/admin/photo/samples",
  },
  {
    title: "Finish & deliver paid orders",
    detail: "Paid orders land in the production queue. Finish every photo, review the delivery email, then send it — that's what unlocks the customer's page.",
    href: "/admin/photo/orders",
  },
];

export type SaleStep = { title: string; detail: string };

export const COLD_OUTREACH_FLOW: SaleStep[] = [
  { title: "Sourced & enriched", detail: "The worker finds restaurants nightly, scores their photos, and picks a signature dish to personalize the email." },
  { title: "Touch 1 drafted", detail: "Composed from the current template (Templates tab), waiting in Approvals." },
  { title: "You approve", detail: "Nothing sends without this — unless autosend is on (Controls). Once approved, it sends automatically on the next send cycle (about every 20 minutes), no manual trigger needed." },
  { title: "A bump if silent", detail: "One follow-up, drafted 3 days later by default if there's no reply — also waits for your approval in Approvals, same as Touch 1." },
  { title: "They reply with a photo", detail: "Creates a free sample here, awaiting your edit." },
  { title: "You edit, review & send", detail: "Finish the photo by hand, then review and send the Touch 2 email — both together, one screen." },
  { title: "They pay on the funnel page", detail: "Touch 2 links to /l/[token] — they pick a package and check out." },
  { title: "They upload the rest of their photos", detail: "Redirected there automatically after paying, or via the confirmation email once you send it from Approvals." },
  { title: "You finish & deliver", detail: "Same production queue as everything else." },
];

export const ADMIN_INITIATED_FLOW: SaleStep[] = [
  { title: "The deal is agreed off-pipeline", detail: "A call, a referral, a reply that never went through the automated flow — however it happened." },
  { title: "Open their restaurant page", detail: "Leads tab → search or click through." },
  { title: "Send a payment link", detail: "Pick the package, optionally type a negotiated amount, generate, copy the link — it doesn't expire." },
  { title: "Paste it into your own email or message", detail: "This app never sends it for you." },
  { title: "They pay", detail: "Redirected straight to their upload page, and emailed the same link in case they close the tab." },
  { title: "They upload — or just email you a folder", detail: "Very normal. Use \"Upload photos for them\" on their restaurant page if they do." },
  { title: "You finish & deliver", detail: "Same production queue as everything else." },
];

export type TabDoc = { label: string; href: string; detail: string };

export const PHOTO_TABS: TabDoc[] = [
  { label: "Overview", href: "/admin/photo", detail: "Revenue, the sent→replied→sample→viewed→paid funnel, pipeline counts by status, per-city breakdown, and a live activity feed." },
  { label: "Approvals", href: "/admin/photo/approvals", detail: "The single approve / edit / deny / send surface for every email that needs a human first — Touch 1, the bump, a reply, and a payment confirmation. Approve one and it sends on its own within ~20 minutes (no \"Run now\"); the daily cap and the pause switch still apply. Sort the queue by date, restaurant, or city. Touch 2 and delivery aren't here — both are reviewed and sent in one screen where they're triggered (Samples / Orders)." },
  { label: "Outreach", href: "/admin/photo/outreach", detail: "The cold-outreach track's historical log — Touch 1, the bump, and manual sends, with exact bodies and Gmail links. Read-only; drafts awaiting your decision are on Approvals." },
  { label: "Samples", href: "/admin/photo/samples", detail: "The free-sample edit queue, plus approved/rejected history. Un-reject to recover a mis-classified reply." },
  { label: "Orders", href: "/admin/photo/orders", detail: "The production queue up top (finish & deliver), then every package and self-serve order. Retry lives here for anything that failed." },
  { label: "Templates", href: "/admin/photo/templates", detail: "Edit the Touch 1, Touch 1.5, and Touch 2 seed copy, plus the sender name, postal address, and signature every email carries. The signature is set here because Gmail's own signature never applies — outreach goes out through the API, not the Gmail compose window. Touch 2 is still reviewed per-send on Samples — this only sets its starting text." },
  { label: "Financials", href: "/admin/photo/financials", detail: "Full P&L, unit economics, and a ranked list of which clients are actually worth what they cost to acquire and serve. Pick a preset period or a custom from/to date range." },
  { label: "Leads", href: "/admin/photo/restaurants", detail: "Every restaurant — search, filter, add a walk-in. Click through to a restaurant for the full dossier, payment links, and manual email." },
  { label: "Call list", href: "/admin/photo/call-list", detail: "Restaurants with no website — they can't be emailed, so phone is the only channel. Click-to-call numbers, filterable by city, sorted busiest-first. These aren't lesser leads; a no-website spot most likely needs the photos AND (later) a website." },
  { label: "Website leads", href: "/admin/photo/website-leads", detail: "Prospects for the future website product, banked automatically — no website, a free subdomain / ordering page / social page (they never bought a domain), or a weak site. The Platform column shows what each is running. Nothing here is contacted by the current pipeline; it's a call/pitch sheet that fills on its own." },
  { label: "Clients", href: "/admin/photo/clients", detail: "Everyone who has paid, grouped by client, with lifetime value — and, most usefully, who has gone quiet. The retention view: an Always Fresh subscriber with no recent charge is the one to reach out to." },
  { label: "Suppressions", href: "/admin/photo/suppressions", detail: "The do-not-contact list. Bounces land here automatically; opt-outs are yours to make — read the reply, then hit Suppress on that restaurant. Add or remove manually any time." },
  { label: "Controls", href: "/admin/photo/controls", detail: "The panic button (pause all sending), approval↔autosend toggle, daily send cap, bump timing, and worker health." },
  { label: "Setup", href: "/admin/photo/setup", detail: "The go-live checklist — every environment variable, which service needs it, and what breaks if it's missing." },
];

export const CONSOLE_TABS: TabDoc[] = [
  { label: "Overview", href: "/admin", detail: "Cross-venture KPIs and the Needs Attention list — the best first stop each day." },
  { label: "Financials", href: "/admin/financials", detail: "Company-wide roll-up across every venture (only Photo Enhancement is live today). Preset periods or a custom from/to date range." },
  { label: "Guide", href: "/admin/guide", detail: "This page." },
];

export const RULES: string[] = [
  "We enhance real photos — we never generate food. Never use the phrase \"AI-generated\" anywhere customer-facing.",
  "Spanish is neutral-formal (usted) in outreach and admin-facing copy. The /l/[token] funnel page is the one exception — it uses informal tú throughout; match whichever surface you're editing.",
  "Packages (Menu Glow-Up, Grand Opening, Always Fresh) are outreach-only. Never put them on the public landing page.",
  "Nothing auto-sends to a prospect without a human approving it first, unless autosend is deliberately turned on in Controls (Touch 1 and the bump only).",
  "Every customer-facing email — not just the cold-outreach sequence — needs a human's approval and edit before it sends. No exceptions elsewhere, and no LLM-drafted replies: you write every reply yourself.",
  "A human finishes every photo. Claid's first pass is a starting point, never the final product a customer sees.",
  "Every commercial email needs a real postal address and a working opt-out line — the system refuses to send one that's missing either, but the address itself (Templates tab) has to stay accurate. Honour an opt-out within 10 business days: suppress the restaurant as soon as you read the reply.",
  "We never promise a refund to a customer. If a photo doesn't land, we re-edit it — as many times as it takes, at no extra cost.",
];

export type TroubleshootRow = { symptom: string; whatsHappening: string; whatToDo: string };

export const TROUBLESHOOTING: TroubleshootRow[] = [
  {
    symptom: "Nothing is sending at all",
    whatsHappening: "Either the panic button is on, or outreach isn't enabled yet on the worker.",
    whatToDo: "Check Controls for the pause toggle. If that's off, check Setup for OUTREACH_ENABLED.",
  },
  {
    symptom: "Drafts are piling up, never getting sent",
    whatsHappening: "They're waiting on your approval, or the daily send cap is already used up for today. Approved drafts send on their own within ~20 minutes — so if an APPROVED one hasn't gone after that, it's the cap or the pause switch, not a stuck queue.",
    whatToDo: "Approve them in Approvals. If approved ones aren't sending, check the daily cap and the pause toggle in Controls.",
  },
  {
    symptom: "A reply came in with no photo attached",
    whatsHappening: "The pipeline only auto-handles a photo reply — anything else, including someone asking to be left alone, needs a person.",
    whatToDo: "You'll get an alert email, and a blank draft is waiting in Approvals — write your reply there and send.",
  },
  {
    symptom: "Someone replied again in a thread you already handled",
    whatsHappening: "A genuine back-and-forth conversation, not something the pipeline auto-processes further.",
    whatToDo: "You'll get an alert (\"New message in an existing reply thread\") and another draft in Approvals — continue there.",
  },
  {
    symptom: "A paid PACKAGE order shows \"failed\"",
    whatsHappening: "Every photo errored on the first Claid pass — this happens sometimes, and it's recoverable.",
    whatToDo: "Find it in Orders and click Retry. Nothing was lost — a failed order never actually billed for a success.",
  },
  {
    symptom: "A self-serve order is stuck on \"pending\"",
    whatsHappening: "Usually means the Stripe webhook didn't fire for that payment.",
    whatToDo: "The system checks Stripe directly and auto-recovers anything that actually got paid, within about an hour. If it's still stuck after that, check Setup for the Stripe webhook keys.",
  },
  {
    symptom: "A customer says they paid but never got an email",
    whatsHappening: "The payment-confirmation draft may just be sitting in Approvals waiting on you — Stripe's own redirect still gets them to the upload page, so this is the backup, not their only way there. Could also be no email on file, or a bounce.",
    whatToDo: "Check Approvals first — send the draft if it's still there. If it already sent, check their email on the restaurant page, send a fresh payment link, or use \"Upload photos for them\" if they already sent you the photos directly.",
  },
  {
    symptom: "A customer emailed you a folder of photos instead of uploading",
    whatsHappening: "Normal — plenty of restaurant owners will do this regardless of what the upload page says.",
    whatToDo: "Open their restaurant page and use \"Upload photos for them\" on the relevant magic link.",
  },
  {
    symptom: "A dispute / chargeback alert lands in your inbox",
    whatsHappening: "A customer disputed a charge with their bank — this has a hard response deadline.",
    whatToDo: "Go to the Stripe dashboard and respond with evidence before the date in the alert. This console can't do that part for you.",
  },
];

export type JudgmentRow = { action: string; note: string };

export const JUDGMENT_ROUTINE: JudgmentRow[] = [
  { action: "Approving, editing, denying, or skipping drafts", note: "The whole point of Approvals — just do it." },
  { action: "Editing & sending samples (Touch 2), finishing & delivering orders", note: "The daily loop." },
  { action: "Sending a payment link, marking a manual payment paid", note: "Standard sales operations." },
  { action: "Retrying a failed order, uploading photos on a customer's behalf", note: "Recovery, not a policy change." },
  { action: "Small price adjustments on a payment link", note: "A few dollars either way to close a deal." },
];

export const JUDGMENT_CHECK_IN: JudgmentRow[] = [
  { action: "Turning on autosend", note: "Removes the human-approval step entirely — worth a heads-up first." },
  { action: "Pulling the panic button (pausing all sending)", note: "Let Enrique know why, so it doesn't stay paused by accident." },
  { action: "Issuing a refund", note: "Money out — flag it either way." },
  { action: "Rewriting the Touch 1 / Touch 1.5 / Touch 2 templates in a big way", note: "Small copy tweaks are fine solo; a full rewrite affects every future lead." },
  { action: "A meaningfully discounted price (well below list)", note: "Worth a quick sanity check on margin — see Financials." },
];

export type GlossaryEntry = { term: string; definition: string };

export const GLOSSARY: GlossaryEntry[] = [
  { term: "Touch 1", definition: "The first cold email to a restaurant — link-free, price-free, just asking for a reply." },
  { term: "Touch 1.5 (the bump)", definition: "One-time follow-up, drafted automatically a few days after Touch 1 if there's no reply. Same approve/edit/deny step as Touch 1, in Approvals." },
  { term: "Touch 2", definition: "The email with their finished free-sample photo and the funnel link — reviewed and sent together, right on the Samples page, the moment you approve their sample." },
  { term: "Magic link", definition: "The unique /l/[token] link tied to one restaurant, carrying them from viewing their sample through paying and uploading." },
  { term: "Free sample", definition: "The one photo you hand-edit as a taste of the work, before they've paid anything." },
  { term: "First pass", definition: "Claid's automatic rough enhancement — a starting point you finish by hand, never the final delivered version." },
  { term: "Suppression", definition: "An email address on the do-not-contact list, from a hard bounce or from you suppressing a restaurant after reading its reply. Outreach skips these automatically." },
  { term: "Signature dish", definition: "The standout dish Claude picks out while enriching a lead — it's what personalizes the Touch 1 email." },
  { term: "Deliverability guard", definition: "Automatic pause on sending if too many recent recipients opt out or bounce, to protect the sending domain's reputation." },
  { term: "Payment link", definition: "A Stripe link you generate for a specific restaurant + package, for a deal already agreed off-pipeline. Doesn't expire." },
];
