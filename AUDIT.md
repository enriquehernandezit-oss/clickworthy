# Pre-launch audit — 2026-08-13

Four parallel audits (security, money, email/compliance, reliability) plus a live
production-DB check, run the night before real cold outreach was to begin. Every
CRITICAL finding below was personally re-verified against the actual code (and,
where possible, the live database) — not relayed from the audit unverified.

**The one that reframes everything:** lead sourcing had failed silently every
night for 5 nights (Places API (New) was disabled on the GCP project). The DB was
empty, so nothing downstream could fire. This bought time — none of the volume-
dependent findings could trigger on day one. Places API was re-enabled and
confirmed working with a live call during the audit. A *second* blocker remains:
`NEVERBOUNCE_API_KEY` is unset on the worker service, which forces every enriched
lead to `needs_manual_email` (never `queued`), so no drafts are produced — see
Phase 0.

Status legend: [ ] todo · [x] done · [~] in progress

---

## Phase 0 — operator actions (not code; do before 02:17 UTC sourcing)

- [ ] **`NEVERBOUNCE_API_KEY` on the Railway _worker_ service.** Without it,
  `verifyEmail()` throws → caught → `email=null` → every restaurant lands
  `needs_manual_email`, and `draftBatch()` only drafts `queued` rows. Result:
  sourcing succeeds, enrichment runs, **zero draftable leads**, silently.
  (`worker/lib/neverbounce.ts:10`, `worker/jobs/enrichRestaurant.ts:92-121`)
- [ ] **Verify all five `R2_*` vars on the Railway _web_ service.** If any one is
  missing, storage silently falls back to serving photos by sequential integer
  ID with no auth (`GET /api/enhance/photo/1,2,3…`). The go-live checklist shows
  a missing R2 var as gray "optional," not red. (security #3)
- [ ] Delete stale `ADMIN_USER` / `ADMIN_PASSWORD` from Railway (retired Basic
  Auth; no code reads them).

---

## Phase 1 — customer-facing harm (before ANY real customer touches it)

- [ ] **Double-charge.** `outreach/checkout/route.ts:22` and `app/l/[token]/page.tsx`
  never check `paidAt`. A paid customer reopening their emailed link sees live
  pricing and can pay again; the 2nd payment can't even be fulfilled (upload
  route 409s on `packageStatus`). Fix: 409 if `link.paidAt` in the checkout
  route; redirect the funnel page to `/upload` when paid. (money #3)
- [ ] **Manual compose bypasses every compliance guard.** `app/api/admin/compose/route.ts`
  checks no suppression, no CAN-SPAM footer, no pause. Can email a STOP'd
  recipient with no postal address / no opt-out. Fix: reject on
  `r.suppressed || isSuppressed`, require/append `complianceFooter`, honor
  `outreach_paused`. Gate the form render on `!r.suppressed` too. (email #1)
- [ ] **Bump has no send cap** *(introduced this session).* `sendApprovedBumps()`
  in `worker/jobs/sendBumps.ts` has no `.limit()`; `sendApproved()` does. Bumps
  also carry `touchNumber:1` so they eat Touch 1's budget while being unbounded.
  Approve 30 → all 30 send in one 4-min tick. Fix: `remaining = cap - sentToday()`
  and `.limit(remaining)`; decide + `kind`-scope the shared/separate cap. (email #2)
- [ ] **`approve`/`set_content`/`skip` have no `kind` guard** *(introduced this
  session; `redraft` got the guard, these didn't).* `app/api/admin/outreach/route.ts:116`.
  Flipping a `reply`/`payment_confirmation` draft to `approved` strands it (gone
  from Approvals, refused by `*_send`). Not an unapproved send. Fix: `if
  (job.kind !== "touch1") 409`. (email #5)
- [ ] **Delivery send-failure reported as success** *(introduced this session — I
  changed `sendCustomerEmail` to return a boolean FOR this, then discarded it).*
  `app/api/admin/package/route.ts:105` does `await sendDelivery(...)` and returns
  `{ok:true}` regardless. If Resend is down, operator sees a clean refresh,
  `deliveredAt` is set, order leaves the "not delivered" list, customer never
  told. Fix: return `emailSent`, show a persistent "Resend delivery" warning when
  false, add a Needs-Attention item for `kind='delivery' AND status='cancelled'`. (reliability #3)
- [ ] **`NULL NOT IN (...)` hides paid-not-yet-uploaded customers.** `lib/photoStats.ts:144` —
  `package_status not in ('ready_for_review','failed')` is NULL (not true) when
  `package_status` is NULL, which is the normal paid→uploaded state. **Verified
  against the live DB.** A $499 customer who hasn't uploaded is in ZERO work
  lists. Fix: `(package_status is null or package_status not in (...))`. (reliability #2)

---

## Phase 2 — the console lies to the operator (do before trusting tomorrow's drafts)

The unifying theme of this whole audit: **Gmail breaking stops the business while
every indicator stays green.** Jose runs ops and does not read logs.

- [ ] **Gmail failure is invisible.** `pollReplies.ts:44`, `sendOutreach.ts:321`,
  `sendBumps.ts:205` swallow into `console.warn` — no alert, no DB state, no UI.
  Poller throwing → handler still "completes" → Controls shows `reply-cycle: 1m
  ago`, zero failures. Replies (incl. photos) silently never processed; Needs
  Attention says "queues are clear." Fix: `sendAlert` (throttled) on list/send
  failure. (reliability #1)
- [ ] **"Approved but unsent >24h" appears nowhere.** `getNeedsAttention()` counts
  only `status='draft'`. A stuck-approved row (Gmail down, or the no-cap bump
  fallout) is invisible. Add the bucket. (reliability #1)
- [ ] **Stuck `processing` self-serve orders appear nowhere.** Add a
  `status='processing' AND createdAt < now-1h` bucket. (reliability #7)
- [ ] **Daily-batch failure has no operator signal.** pg-boss `this.fail()` doesn't
  emit `events.error`, so `boss.on("error")` never fires; only `REPLY_QUEUE` gets
  the staleness banner. Extend the banner to `SEND_QUEUE`/`SOURCE_QUEUE` (>30h)
  and surface a Needs-Attention item for any `pgboss.job` failure in 24h.
  **Note: this is exactly how the 5-night sourcing outage went unnoticed.** (reliability #6)

---

## Phase 3 — money integrity (before trusting the financials page)

- [ ] **`ledgerKey` unstable → double-counted revenue.** `lib/paymentLedger.ts:83`
  keys on `chargeId ?? "session:{id}"`, depending on whether a 5s Stripe lookup
  succeeded. Same payment, two keys, two rows, no unique on session/PI to catch
  it. The documented "safe to run twice" backfill is the trigger. Fix: key on
  `stripe:cs:{session.id}` (known before any Stripe call); charge id becomes a
  plain column. Needs a one-time rekey migration. (money #1, reliability #9)
- [ ] **Backfill double-writes a list-priced manual row for every Payment-Link
  sale.** Payment Links never set `stripeSessionId`, so the backfill's package
  loop falls to `recordManualPayment` at list price alongside the webhook's
  correct row. Fix: skip when a `payments` row already exists for that
  `magic_link_id`. (money #2)
- [ ] **`dispute.closed` non-idempotent.** `stripe/route.ts:83` does
  `refundedCents + dispute.amount`; a redelivery double-subtracts. Fix: guard on
  `stripe_dispute_id` or track disputed amount in its own column (assignment, not
  increment). (money #4)
- [ ] **Refunds/chargebacks silently no-op on NULL-charge-id rows.** `stripe/route.ts:50,84`
  match `WHERE stripeChargeId=...` and never check row count; estimate-path and
  manual rows have NULL charge id. Fix: `.returning()` + `sendAlert` on zero
  match; fall back to `stripePaymentIntentId`. (money #5)
- [ ] **Stuck-order recovery fulfills but never records the payment.** `processEnhancementOrders.ts:101`
  verifies paid + delivers, but nothing in `worker/` calls `recordStripePayment`.
  If the webhook is down for a stretch, those orders are enhanced + delivered with
  **zero ledger trace** while their Claid cost lands — margin appears to collapse.
  Fix: call `recordStripePayment` after the `advanced.length>0` check. (money #6)
- [ ] **Outreach payment with no matching link: no record, no alert.** `stripe/route.ts:126`
  wraps in `if(link)` with no `else`; self-serve alerts, outreach doesn't. Fix:
  mirror the `sendAlert`. (money #7, reliability #10)
- [ ] **`/admin` "Total revenue" ignores refunds/fees** while `/financials` uses
  net. `lib/photoStats.ts:60` — two pages disagree, contradicting the file's own
  docstring. Fix: subtract `refunded_cents` or relabel as gross. (money #9)
- [ ] **"All time" range is wrong.** `EPOCH=2020` → ~$2,870 phantom opex; the
  24-month cap on `getMonthlySeries` buckets 2020–21 so real months filter out →
  "No activity." Fix: `range.from = min(paid_at)`; build months backward from
  `range.to`. (money #8)

---

## Phase 4 — security hardening

- [ ] **Login endpoint DoS + brute force.** `lib/auth.ts:24` uses **sync** scrypt
  (~73ms blocked event loop/attempt, measured), on an endpoint exempt from the
  gate with no rate limit/lockout. ~15 req/s saturates the single Node process →
  Stripe webhooks stop responding. Also unlimited password guessing. Fix: async
  scrypt; per-IP+per-email rate limit + lockout; consider edge IP-allowlist (2
  founders). (security #1)
- [ ] **Public upload has no caps.** `create-checkout-session/route.ts` — only
  `photos.length===0` checked. No count/size/rate limit; writes R2 pre-payment;
  no abandoned-session cleanup. Fix: cap count (~25) + per-file + total bytes;
  per-IP rate limit; 24h sweeper. (security #2)
- [ ] **`Host` header trusted for redirect/photo URLs.** 6 call sites use
  `request.headers.get("host")` to build `success_url` etc. → phishing-laundering
  via a real Stripe page redirecting to `evil.com`. Fix: use `APP_ORIGIN`
  (already set). (security #4)
- [ ] Stateless sessions, no revocation — add `sessionVersion` on `admin_users`,
  bump on logout/password change. (security #5)
- [ ] `sanitizeSubject` + `To`/`From` CRLF strip inside `sendEmail` itself (not
  just callers). Low, but one-line at the right layer. (security #6, email #11)
- [ ] Add a 2-line `requireAdmin()` to the 12 admin routes that lack it (proxy
  works today; this is defense against a future route added outside `/api/admin`). (security #10)

---

## Phase 5 — worker robustness

- [ ] **`PACKAGE_QUEUE` 30-min expiry → concurrent double Claid billing.** pg-boss
  fails the job at `expireInSeconds:1800` but doesn't cancel the handler; the loop
  starts a queued run over rows the first is still processing (no lease). A
  40-photo package re-enhances from scratch, last-write clobbers, 2 "order ready"
  alerts. Fix: raise expiry past worst-case batch; add a `claimedAt`/`enhancing`
  lease via `.where(...packageStatus='processing').returning()`. (reliability #4)
- [ ] **Stuck-pending poll unbounded → cost + permanent false alarm.** `processEnhancementOrders.ts:101`
  — abandoned carts stay `pending` forever, each Stripe-retrieved every minute
  forever; `getNeedsAttention()` counts them, so the ONE webhook-broken alarm
  becomes permanent noise nobody reads. Fix: `gt(createdAt, now-3d)` + `.limit(50)`;
  mark checked-unpaid as `abandoned`. (reliability #5)
- [ ] **One approved draft can send twice** (retry-after-delivery via
  `withRetry(attempts:2)` around a non-idempotent send; post-send update failure;
  2 replicas). Fix: claim `UPDATE ... SET status='sending' WHERE status='approved'
  RETURNING`, skip if none; drop `withRetry` around `sendEmail`. (email #6)
- [ ] Incremental `packageResults` (persist per photo, skip already-done) so a
  Railway redeploy mid-batch doesn't reburn ~25 min of Claid. (reliability #12)
- [ ] **`startOfToday()` is a UTC day → "Run now" after 8pm DR doubles the cap.**
  Operator in UTC-4; a post-8pm-local manual run sees `sentToday()=0` and sends a
  second full cap. Fix: compute the window from a fixed DR offset, or rolling 24h. (reliability #8)

---

## Phase 6 — correctness polish

- [ ] `isOptOut()` too narrow ("please remove me", "unsubscribe me" miss) AND too
  broad (bare "no" mid-convo auto-suppresses with no alert). Regex tier + alert
  on auto-suppression + bare-"no" only on first reply. (email #4)
- [ ] Empty `Subject:` on bump/reply when `getThreadTail` fails → unthreaded,
  subject-less spam-signal email. Fall back to stored Touch 1 subject + `Re:`. (email #7)
- [ ] Subjects never RFC 2047 encoded → mojibake on the Spanish accented cold
  opens ("El Rincón Criollo"). Encode non-ASCII as `=?UTF-8?B?...?=`. (email #8)
- [ ] Deliverability-guard numerator counts ALL suppressions incl. `manual`;
  denominator is sends → a few manual suppressions during launch week can
  auto-pause outreach AND fire the alert every 4 min (~360/day). Filter numerator
  to `reason in ('opt_out','bounce','complaint')`; debounce the alert. (email #9)
- [ ] Replies to `manual` threads dropped (poller matches `kind='touch1'` only;
  compose sends unthreaded `kind='manual'`). Incl. STOP replies. Also: nothing
  ever reads the `contact@` mailbox that customer email says "reply to." Widen
  poller match to `['touch1','manual']` + fallback alert on no-match. (email #3)
- [ ] HTML-only replies → empty `bodyText` → empty alert/draft, STOP undetected.
  Fall back to stripped `text/html`. (reliability #11)
- [ ] Fully-`failed` package shows the paying customer a broken "photos ready"
  page. Treat `failed` as still-in-progress on the customer page. (reliability #13)
- [ ] `resend_delivery` fallback branch sends un-reviewed text (no prior audit
  row). Return the composed draft for confirmation instead. (email #10)
- [ ] Segment roll-up double-counts multi-package clients across every segment;
  Orders queue shows list price not negotiated price; refunds retro-reduce prior
  months; `newPayers` undercount inflates CAC; 100%-off coupon → order fulfilled
  with no ledger row. (money low + finance)

---

## Confirmed clean (highest-stakes questions — do NOT re-investigate)

- Stripe webhook signature verification: correct, unbypassable, fails closed.
- No SQL injection anywhere; every raw `sql\`\`` template is parameterized.
- No XSS surface; zero `dangerouslySetInnerHTML`; `renderTemplate` is allowlisted.
- No secrets ever committed (full git history checked); none reach the browser;
  none logged.
- Session tokens: HMAC-SHA256, timing-safe, expiry enforced, not forgeable; cookie
  flags correct (httpOnly/secure/sameSite=lax).
- Magic-link tokens: 192-bit random, not enumerable.
- Pricing server-computed both flows; can't be tampered.
- The `kind` migration is thorough — `sendApproved()` cannot grab a non-touch1 row
  (the disaster case); all 8 insert sites set `kind`; the backfill CASE is order-correct.
- Refund-copy removal complete — no money-back promise survives anywhere customer-facing.
- Webhook idempotency for the guarded paths (`paidAt` CAS, `status='pending'` CAS,
  cumulative `amount_refunded`) genuinely holds.
- Cron self-overlap under normal completion cannot happen (pg-boss concurrency=1,
  awaits onFetch) — the only overlap is the PACKAGE_QUEUE expiry path (Phase 5).
- Per-message reply dedup (`lastReplyMessageId` committed before risky work) is correct.
