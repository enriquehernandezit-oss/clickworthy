// NeverBounce single-email verification (API v4.2).
//   GET https://api.neverbounce.com/v4.2/single/check?key=...&email=...
//   -> { status, result: "valid"|"invalid"|"disposable"|"catchall"|"unknown" }
//
// NOTE: the auth param is `key`, NOT `api_key`. NeverBounce v4 silently ignores
// `api_key` and reports `auth_failure: Invalid API key ''` (empty) — which reads
// like a bad/empty key but actually means the key param was never seen.

import { requireKey } from "../config";

export type VerifyResult = "valid" | "invalid" | "disposable" | "catchall" | "unknown";

// The verdict + the diagnostic flags NeverBounce returns alongside it. Flags
// like "smtp_connectable" / "has_dns_mx" let us treat a strong-signal "unknown"
// as contactable (see isContactable) instead of dropping a real address.
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
//              business's info@ address.
//   unknown  — ONLY when the mailserver is reachable (smtp_connectable) and the
//              domain has mail records (has_dns_mx). NeverBounce returns
//              "unknown" when an accept-all/greylisting server won't confirm the
//              specific mailbox — but such a server ACCEPTS the message rather
//              than hard-bouncing it, so sending doesn't hurt sender reputation.
//              This recovers real addresses (a restaurant's info@/hello@) that
//              would otherwise be dropped. A longer NeverBounce timeout does NOT
//              resolve these — the server simply never gives a definitive answer.
// invalid / disposable are always dropped.
export function isContactable(v: VerifyVerdict): boolean {
  if (v.result === "valid" || v.result === "catchall") return true;
  if (v.result === "unknown" && v.flags.includes("smtp_connectable") && v.flags.includes("has_dns_mx")) {
    return true;
  }
  return false;
}
