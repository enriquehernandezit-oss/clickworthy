// NeverBounce single-email verification (API v4.2).
//   GET https://api.neverbounce.com/v4.2/single/check?key=...&email=...
//   -> { status, result: "valid"|"invalid"|"disposable"|"catchall"|"unknown" }
//
// NOTE: the auth param is `key`, NOT `api_key`. NeverBounce v4 silently ignores
// `api_key` and reports `auth_failure: Invalid API key ''` (empty) — which reads
// like a bad/empty key but actually means the key param was never seen.

import { requireKey } from "../config";
import { sendAlert } from "@/lib/alerts";

export type VerifyResult = "valid" | "invalid" | "disposable" | "catchall" | "unknown";

// The verdict plus the diagnostic flags NeverBounce returns alongside it
// (e.g. "smtp_connectable", "has_dns_mx", "role_account") — kept for logging
// and future tuning. The contactable decision itself (isContactable) rests on
// `result` only; the flags are not a safe substitute for a definitive verdict.
export type VerifyVerdict = { result: VerifyResult; flags: string[] };

// A depleted balance hits EVERY verification call, and findVerifiedEmail()
// catches each one individually and fails CLOSED (routes the lead to
// needs_manual_email rather than risk an unverified send — see findEmail.ts)
// — which is the right safety behavior, but it means a zero balance looks
// EXACTLY like a normal night with no verifiable addresses. That's exactly
// what happened 2026-09: credits ran out silently and 6 consecutive nights
// read as "queued: 0" with nothing distinguishing it from a bad night, until
// a live probe caught it by hand. Same in-memory-cooldown shape as
// maybeAlertApiError in anthropic.ts — the worker is long-lived, a reboot
// re-arming the alert is acceptable, and this is what turns a silent 2-week
// gap into a same-hour one.
let lastBalanceAlertAt = 0;
const BALANCE_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

async function maybeAlertLowBalance(err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/insufficient credit balance/i.test(msg)) return; // not this failure mode
  if (Date.now() - lastBalanceAlertAt < BALANCE_ALERT_COOLDOWN_MS) return;
  lastBalanceAlertAt = Date.now();
  await sendAlert(
    "NeverBounce credits exhausted — email verification is DOWN",
    `A NeverBounce call failed with an insufficient-credit error. Nothing can reach 'queued' while ` +
      `this is down — findVerifiedEmail() fails safe (never emails an unverified address), which means ` +
      `every lead routes to needs_manual_email instead, indistinguishable from a genuinely bad night ` +
      `unless you're looking for this specific alert.\n\n` +
      `Error: ${msg}\n\n` +
      `Add credits at app.neverbounce.com -> Pricing (NOT the "Growth Tier" list-sync upgrade banner, ` +
      `which is a different product and won't move the Credits balance in the top-right corner).`
  ).catch(() => {}); // never let an alert failure mask the original error
}

export async function verifyEmail(email: string): Promise<VerifyVerdict> {
  const apiKey = requireKey("neverBounceApiKey", "NEVERBOUNCE_API_KEY");
  const url =
    `https://api.neverbounce.com/v4.2/single/check` +
    `?key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;

  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`NeverBounce check failed (${res.status}) for ${email}`);
    await maybeAlertLowBalance(err);
    throw err;
  }
  const body = (await res.json()) as { status?: string; result?: string; flags?: string[]; message?: string };
  if (body.status && body.status !== "success") {
    const err = new Error(`NeverBounce error for ${email}: ${body.message ?? body.status}`);
    await maybeAlertLowBalance(err);
    throw err;
  }
  return { result: (body.result as VerifyResult) ?? "unknown", flags: body.flags ?? [] };
}

// Account credit balance — used only by the once-daily sourcing report
// (worker/jobs/sourcingReport.ts), never on a request path, so a slow or
// failing NeverBounce call can't add latency to a page render. Same auth/
// error shape as verifyEmail() (the `key` param trap applies here too).
//
// The nested shape NeverBounce's own docs describe (`result.credits_info`)
// does NOT match the live v4.2 response, confirmed by a real call 2026-09-09
// — credits_info sits at the TOP level. Parsed defensively for both shapes
// in case that changes again.
export type AccountBalance = { paidRemaining: number; freeRemaining: number };

export async function getAccountInfo(): Promise<AccountBalance> {
  const apiKey = requireKey("neverBounceApiKey", "NEVERBOUNCE_API_KEY");
  const url = `https://api.neverbounce.com/v4.2/account/info?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`NeverBounce account/info failed (${res.status})`);
  const body = (await res.json()) as {
    status?: string;
    message?: string;
    credits_info?: { paid_credits_remaining?: number; free_credits_remaining?: number };
    result?: { credits_info?: { paid_credits_remaining?: number; free_credits_remaining?: number } };
  };
  if (body.status && body.status !== "success") {
    throw new Error(`NeverBounce account/info error: ${body.message ?? body.status}`);
  }
  const credits = body.credits_info ?? body.result?.credits_info ?? {};
  return {
    paidRemaining: credits.paid_credits_remaining ?? 0,
    freeRemaining: credits.free_credits_remaining ?? 0,
  };
}

// Which verdicts we're willing to email:
//   valid    — confirmed deliverable. Always accepted.
//   catchall — the domain accepts ANY address at SMTP time, so NeverBounce
//              cannot tell whether this particular mailbox exists. Accepted
//              only when we know the address is real from another source (it
//              was published on the site) — see the split below.
// Everything else — invalid, disposable, and unknown — is dropped.
//
// The catch-all trap, measured 2026-08-27: an accept-all server takes the
// message and only THEN discovers the mailbox doesn't exist, so the rejection
// arrives hours later as an async DSN rather than at send time. Of 15 GUESSED
// addresses sent (all info@, since emailGuessLimit is 1), at least 4 hard-
// bounced this way — ~27%, against 0 bounces across 49 scraped addresses. The
// CHANGELOG had already logged the same trap on Johnny's Shrimp Boat without
// the policy changing.
//
// Hence `guessed`: a `catchall` verdict on a SCRAPED address still carries real
// information — a human published that mailbox on the restaurant's own site, so
// it exists. On a GUESSED address it carries none at all: we invented
// info@theirdomain, and an accept-all domain will say yes to anything we
// invent. Same verdict, opposite amount of evidence.
//
// We deliberately do NOT send to "unknown". An "unknown" is the case NeverBounce
// could NOT resolve — most often greylisting, where the server DEFERS and only
// later accepts or REJECTS based on whether the mailbox exists. Sending to those
// risks a hard bounce on a nonexistent mailbox, which is exactly the sender-
// reputation damage verification exists to prevent. `smtp_connectable` +
// `has_dns_mx` only prove the server is reachable and the domain has MX — not
// that the mailbox exists — so they are not a safe green light. (A longer
// NeverBounce timeout doesn't help; the server just never gives an answer.)
export function isContactable(v: VerifyVerdict, opts?: { guessed?: boolean }): boolean {
  if (v.result === "valid") return true;
  if (v.result !== "catchall") return false;
  // catchall: trustworthy for an address we actually found, worthless for one
  // we made up. Defaults to the permissive branch so hand-typed (admin) and
  // re-verified (scripts/reverify-emails.ts) addresses keep their old behavior.
  return !opts?.guessed;
}
