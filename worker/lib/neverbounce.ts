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
//   valid    — confirmed deliverable.
//   catchall — domain accepts anything; unverifiable but usually real for a
//              business's info@ address, and an accept-all server takes the
//              message rather than hard-bouncing it.
// Everything else — invalid, disposable, and unknown — is dropped.
//
// We deliberately do NOT send to "unknown". A genuine accept-all server is
// reported as `catchall` (handled above); an "unknown" is the case NeverBounce
// could NOT resolve — most often greylisting, where the server DEFERS and only
// later accepts or REJECTS based on whether the mailbox exists. Sending to those
// risks a hard bounce on a nonexistent mailbox, which is exactly the sender-
// reputation damage verification exists to prevent. `smtp_connectable` +
// `has_dns_mx` only prove the server is reachable and the domain has MX — not
// that the mailbox exists — so they are not a safe green light. (A longer
// NeverBounce timeout doesn't help; the server just never gives an answer.)
export function isContactable(v: VerifyVerdict): boolean {
  return v.result === "valid" || v.result === "catchall";
}
