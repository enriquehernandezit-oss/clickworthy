// NeverBounce single-email verification (API v4.2).
//   GET https://api.neverbounce.com/v4.2/single/check?api_key=...&email=...
//   -> { status, result: "valid"|"invalid"|"disposable"|"catchall"|"unknown" }

import { requireKey } from "../config";

export type VerifyResult = "valid" | "invalid" | "disposable" | "catchall" | "unknown";

export async function verifyEmail(email: string): Promise<VerifyResult> {
  const apiKey = requireKey("neverBounceApiKey", "NEVERBOUNCE_API_KEY");
  const url =
    `https://api.neverbounce.com/v4.2/single/check` +
    `?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`NeverBounce check failed (${res.status}) for ${email}`);
  }
  const body = (await res.json()) as { status?: string; result?: string; message?: string };
  if (body.status && body.status !== "success") {
    throw new Error(`NeverBounce error for ${email}: ${body.message ?? body.status}`);
  }
  return (body.result as VerifyResult) ?? "unknown";
}

// We accept an email as contactable if NeverBounce says valid or catchall.
// (catchall = the domain accepts anything, unverifiable but usually real for a
// business's info@ address — worth a send; invalid/disposable are dropped.)
export function isContactable(result: VerifyResult): boolean {
  return result === "valid" || result === "catchall";
}
