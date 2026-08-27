# Changelog — pipeline & console

A dated record of **what changed and why**, for the outreach workflow (sourcing,
gates, sending) and the admin console. Code comments explain a single file; this
explains decisions that span files, and — just as important — **decisions we
considered and deliberately rejected**, so they don't get re-litigated from
scratch every few weeks.

Every entry should carry the measurement that justified it. "It felt slow" is
not a reason; "measured 2026-08-25: 41 leads, zero decisions changed" is.

Newest first.

---

## 2026-08-27

### Fixed: bounces were being counted as REPLIES
A delivery failure arrives in the same Gmail thread as the message that failed,
so `pollReplies` recorded it as `replied`. The pipeline's only "reply" across 44
sends was a mailer-daemon *"Address not found"* — so the **true reply rate was
0/44, not 1/44**, on the dashboard, the weekly email, and Insights. It also left
the dead address un-suppressed (invisible to the deliverability guard, which
counts suppressions) and queued a blank draft as if someone owed a human reply.

`isBounceNotification()` now runs *before* the `replied` write, suppresses the
address we actually sent to (read off the restaurant row — never the
mailer-daemon sender), marks the job `bounced`, and skips the draft. Backfilled
the one historical row.

**Calibration worth remembering:** that address was `source=guessed` and had
*passed* NeverBounce — the catch-all trap (a catch-all domain accepts at SMTP
time so NeverBounce answers `catchall`; the server rejects the unknown mailbox
later). Our current bar already produces bounces.

### Email-yield investigation — where the bottleneck actually is
Measured across all 140 leads stuck at `needs_manual_email`:
- **Extraction is not the bottleneck.** Only 13/140 (9%) have a scrapable
  address; the structured extractors barely fire (mailto 7, jsonld 1,
  cloudflare 0, meta 0). More parsers would be wasted effort.
- **54% have no MX record at all** — no mailbox exists on their domain.
  Permanently unreachable by email; correctly excluded.
- Of the 64 that *do* have a live mailbox, `info@` returns **69% "unknown"**,
  25% invalid, 6% valid/catchall. **We discard every "unknown"** — ~44 leads
  here, roughly 5/night ongoing.

### Rejected: the "unknown = greylisting, so retry" hypothesis
Greylisting resolves on retry, which would have made this a safe, easy win.
Retried 8 "unknown" addresses ~10 minutes later: **0 of 8 flipped.** The verdict
is stable, not transient. A retry system would have done nothing. Cost to find
out: $0.06 (total diagnostics ~$1.08).

### Deferred: the controlled unknown-email test batch
Approved in principle, sequenced *after* a baseline. Rationale: bounces were
invisible until today, and a NeverBounce-approved address already bounced — so
there is no observed bounce rate to judge an experiment against. Worse, before
the fix above, bounces registered as *replies*, which would have made a failing
experiment look like a winning one. Plan: run the bounce fix on normal traffic
for 3–4 nights to establish the verified-address baseline, then send the unknown
batch and compare against it.

### Dropped two classes of wrong-recipient address
Found by the backfill dry run on real leads:
- **Plus-addressed agency inboxes** (`proyectoweber+<client>.com@gmail.com`) — a
  web developer routing many clients into one mailbox. We'd have pitched the
  developer, not the restaurant.
- **Corporate loyalty/rewards/franchise mailboxes** (`loyalty@acfp.com`).
Tests pin that a plain gmail and `order_info@` still pass, so the filter doesn't
overreach.


### Reviewed: the `minReviews: 20` sourcing floor — **NO CHANGE**
"Too few reviews" is consistently the top rejection reason (29 of 34 free-filtered
leads on 2026-08-25), which reads alarming but is the filter working as designed:
those leads die at the **free** hard-filter stage and cost $0.

Considered lowering the floor 20 → 10 to recover volume. Measured why not:

| Reviews | Leads | Have a website |
|---|---|---|
| <10 | 86 | 27% |
| 10–19 | 38 | 34% |
| 20–49 | 61 | 48% |
| 50+ | 711 | 75% |

A website is required for email discovery. Lowering to 10 recovers 38 leads
all-time → ~34% have a site (13) → ~36% email yield ≈ **4–5 extra email-ready
leads across two weeks**, while paying enrichment cost on all 38. Rejected: the
bottleneck is email yield and website-having supply, not the review floor.

### Fixed: worker crash-loop on boot (production outage)
`pipeline-snapshot` was added to `ALL_QUEUES` and scheduled, but not to the
hand-maintained queue-creation map. pg-boss v12 throws at boot for a queue that
was never created, so the whole worker died on every start — sourcing, sending,
reply polling included. The creation map is now **derived from `ALL_QUEUES`**, so
this class of drift is structurally impossible.

### Migrated every `window.confirm()` to an in-page `ConfirmDialog`
11 call sites. Three of them now require typing a word to proceed
(`requireText`), which a browser confirm can't do — chosen for the actions a
second operator could not undo:
- **Send delivery email** (`SEND`) — unlocks the customer's page, no edits after.
- **Turn ON autosend** (`AUTOSEND`) — removes the human approval step entirely.
- **Remove a suppression** (`REMOVE`) — can re-contact someone who opted out.

---

## 2026-08-26

### Insights tab + frozen nightly snapshots
Each completed night's metrics are frozen into `pipeline_night_snapshots` the
morning after (~5:27am), once enrichment has settled, so numbers can't shift
retroactively when a lead's status later changes. Findings and cross-night
patterns are **derived on read** from the frozen numbers (rule-based, no LLM), so
their logic can improve without re-snapshotting.

Queries live in `lib/pipelineHealth.ts` and are imported by **both** the page and
`scripts/nightly-analysis.ts` — deliberately, because four separate measurement
bugs in one day (2026-08-25) all traced to the same metric being computed in two
places that disagreed.

### Fixed: funnel drop-percentage was on the wrong arrow
The % was computed for a step's *incoming* transition but drawn on its *outgoing*
arrow, so an 80→46 drop of −43% rendered between 46 and 9 (whose real drop is
−91%). Also labelled: email-ready is "leads verified the night they were sourced",
which is **not** the Approvals count — drafts come from the whole accumulated
queued pool, so "9 sourced vs 15 drafted" is expected, not a bug.

### Business-hours send window
Approved Touch 1 + bumps now send only 9am–12pm **in the recipient's** local time,
Mon–Fri (target cities span ET→PT, so one clock can't serve all seven).

Two bugs found in the follow-up audit and fixed:
- Bumps reused Touch 1's `SEND_BATCH_PER_TICK=6`, but run on the 4-min reply cron
  vs the 20-min send cron — 5× faster, draining a 50/day cap in ~36 minutes. Now
  `BUMP_BATCH_PER_TICK=2`, sized for that cadence.
- Bumps shared the daily cap and could consume it before Touch 1's slower tick
  fired (zero Touch 1 sent that day). Bumps now reserve headroom for every
  already-approved Touch 1 — Touch 1 is the priority metric.

`startOfToday()` also now buckets in AST; it was using server-local UTC, so the
daily cap rolled over at 8pm local.

### Console redesign: dark theme, grouped IA, briefing overview
Unified two clashing visual dialects onto one token system. Nav regrouped to
match the documented daily loop (WORK → PIPELINE → MONEY → SYSTEM). Overview
rebuilt as a morning briefing (run health, email-ready vs target, why-leads-died,
yield, anomaly alerts); revenue and the 30-day funnel moved to Financials, which
owns the range picker.

Accessibility fixes from the audit: `--c-text-faint` lifted to pass AA on raised
surfaces, and form inputs got a dedicated `--line-input` border (the decorative
divider color was ~1.2:1 and effectively invisible on an input).

---

## 2026-08-25

### Cut spend, raised yield
- **Fetcher hardened** — real Chrome UA + one retry. ~21% of website-having leads
  were fetch-failing, which *also* silently skipped the photo gate and the
  contact-page crawl. Email-discovery yield moved from a ~29% baseline into the
  33–40% band and has held there.
- **Vision skipped for `unclear` band** — `decidePhotoFit` can only reject `rich`,
  so scoring `unclear` was spend that could never change a decision (41 leads had
  paid for it).
- **`emailGuessLimit` 3 → 1** — all 11 verified guesses ever were `info@`;
  `contact@`/`hello@` had verified zero.
- **Social/ordering pages routed to `call_list`** — 15 of 119 `needs_manual_email`
  leads had an Instagram/Facebook/ordering URL as their "website", where no
  mailbox can exist.
- **Manually entered emails now NeverBounce-verified** before entering the send
  queue.

### The gates fail open — and that's deliberate
Both quality gates (photo-fit Vision, chain check) hit the Anthropic API and
**pass the lead through on failure** rather than stranding it. The consequence:
an API outage or depleted balance makes a poisoned night *look* like a clean one.
This is why the anomaly detectors exist (`getAnomalies`) — a run with zero
chain/group rejections, or an abnormally high pass rate, is the signature.
`scripts/rescreen-outage.ts` buys back the skipped checks for a time window.
