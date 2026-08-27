// Tests for the contactable-verdict policy. The network call (verifyEmail) is
// not covered here — this is the decision that governs whether an address is
// allowed to be emailed at all, which is the part that burns sender reputation
// when it's wrong. Run with `bun test`.
//
// Added 2026-08-27 alongside the catch-all split: of 15 guessed addresses sent,
// at least 4 hard-bounced (~27%), against 0 across 49 scraped ones. Every one
// of those bounces was a `catchall` verdict on an invented info@ address.

import { expect, test, describe } from "bun:test";
import { isContactable, type VerifyVerdict } from "./neverbounce";

const verdict = (result: VerifyVerdict["result"]): VerifyVerdict => ({ result, flags: [] });

describe("isContactable", () => {
  test("valid is always contactable, guessed or not", () => {
    expect(isContactable(verdict("valid"))).toBe(true);
    expect(isContactable(verdict("valid"), { guessed: false })).toBe(true);
    expect(isContactable(verdict("valid"), { guessed: true })).toBe(true);
  });

  test("invalid / disposable / unknown are never contactable", () => {
    for (const r of ["invalid", "disposable", "unknown"] as const) {
      expect(isContactable(verdict(r))).toBe(false);
      expect(isContactable(verdict(r), { guessed: false })).toBe(false);
      expect(isContactable(verdict(r), { guessed: true })).toBe(false);
    }
  });

  test("catchall is accepted for a SCRAPED address — a human published it", () => {
    expect(isContactable(verdict("catchall"), { guessed: false })).toBe(true);
  });

  test("catchall is REJECTED for a GUESSED address — this is the bounce source", () => {
    // The exact shape of info@tauropizza.com / info@pinkyringpizza.com /
    // info@zatar.nyc: invented address, accept-all domain says yes to anything,
    // remote server rejects the unknown mailbox hours later.
    expect(isContactable(verdict("catchall"), { guessed: true })).toBe(false);
  });

  test("omitting opts keeps the permissive branch (admin + reverify callers)", () => {
    // app/api/admin/restaurants/route.ts and scripts/reverify-emails.ts verify
    // hand-typed or already-scraped addresses, never guesses — their behavior
    // must not change.
    expect(isContactable(verdict("catchall"))).toBe(true);
  });
});
