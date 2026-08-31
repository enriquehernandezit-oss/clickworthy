// Tests for the pure header-encoding helper in worker/lib/gmail.ts. The rest
// of that module talks to the Gmail API and needs live credentials, so only
// the pure piece is covered here. Run with `bun test`.
//
// Added 2026-08-31 with the RFC 2047 fix: MIME headers are 7-bit ASCII only,
// so a raw accented Subject shipped as mojibake — bad for the recipient and a
// spam signal on a domain whose reputation is already being repaired.

import { expect, test, describe } from "bun:test";
import { encodeHeaderValue } from "./gmail";

describe("encodeHeaderValue (RFC 2047)", () => {
  test("plain ASCII is returned byte-for-byte unchanged", () => {
    // The common case must not change at all — every existing subject is ASCII.
    expect(encodeHeaderValue("quick question about Joe's Diner's photos")).toBe(
      "quick question about Joe's Diner's photos"
    );
    expect(encodeHeaderValue("")).toBe("");
  });

  test("accented text is encoded as a base64 encoded-word", () => {
    const out = encodeHeaderValue("Mi Ranchito Taquería");
    expect(out.startsWith("=?UTF-8?B?")).toBe(true);
    expect(out.endsWith("?=")).toBe(true);
    // Round-trips back to the original.
    const b64 = out.slice("=?UTF-8?B?".length, -"?=".length);
    expect(Buffer.from(b64, "base64").toString("utf-8")).toBe("Mi Ranchito Taquería");
  });

  test("encodes the real non-ASCII cases in the lead database", () => {
    // A curly apostrophe is non-ASCII too and is common in Places business
    // names — easy to miss when eyeballing for accents.
    for (const s of ["Mi Ranchito Taquería", "Brother’s Bakery Cafe", "El Rincón Criollo", "¿No le interesa?"]) {
      const out = encodeHeaderValue(s);
      expect(out.startsWith("=?UTF-8?B?")).toBe(true);
      const b64 = out.slice("=?UTF-8?B?".length, -"?=".length);
      expect(Buffer.from(b64, "base64").toString("utf-8")).toBe(s);
    }
  });

  test("output is pure ASCII, which is the whole point", () => {
    const out = encodeHeaderValue("Taquería Doña Ana — ¡hola!");
    expect(/^[\x00-\x7F]*$/.test(out)).toBe(true);
  });
});
