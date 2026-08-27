// NeverBounce single-email verification (API v4.2).
//   GET https://api.neverbounce.com/v4.2/single/check?key=...&email=...
//   -> { status, result: "valid"|"invalid"|"disposable"|"catchall"|"unknown" }
//
// NOTE: the auth param is `key`, NOT `api_key`. NeverBounce v4 silently ignores
// `api_key` and reports `auth_failure: Invalid API key ''` (empty) — which reads
// like a bad/empty key but actually means the key param was never seen.

import { requireKey } from "../config";

export type VerifyResult = "valid" | "invalid" | "disposable" | "catchall" | "unknown";

// The verdict plus the diagnostic flags NeverBounce returns alongside it
// (e.g. "smtp_connectable", "has_dns_mx", "role_account") — kept for logging
// and future tuning. The contactable decision itself (isContactable) rests on
// `result` only; the flags are not a safe substitute for a definitive verdict.
export type VerifyVerdict = { result: VerifyResult; flags: string[] };

export async function verifyEmail(email: string): Promise<VerifyVerdict> {
  const apiKey = requireKey("neverBounceApiKey", "NEVERBOUNCE_API_KEY");
  const url =
    `https://api.neverbounce.com/v4.2/single/check` +
    `?key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`NeverBounce check failed (${res.status}) for ${email}`);
  }
  const body = (await res.json()) as { status?: string; result?: string; flags?: string[]; message?: string };
  if (body.status && body.status !== "success") {
    throw new Error(`NeverBounce error for ${email}: ${body.message ?? body.status}`);
  }
  return { result: (body.result as VerifyResult) ?? "unknown", flags: body.flags ?? [] };
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
