// Tests for email discovery v2 — the four extractors, the vendor-domain guard
// (the latofonts bug), and the guess generator. Run with `bun test`.
//
// These are the functions that decide WHO we email, so each extractor is pinned
// against HTML shaped like the real pages the crawler meets.

import { expect, test, describe } from "bun:test";
import {
  stripNonContentBlocks,
  isNonOwnedHost,
  decodeCfEmail,
  extractCfEmails,
  extractMailtoEmails,
  extractJsonLdEmails,
  extractMetaEmails,
  isAcceptableDomain,
  guessEmailCandidates,
} from "./emailDiscovery";

// ---------------------------------------------------------------------------
// Extractor 1 — Cloudflare email protection
// ---------------------------------------------------------------------------

// Build a real cfemail payload so the test proves the algorithm, not a fixture.
function cfEncode(email: string, key = 0x7a): string {
  let out = key.toString(16).padStart(2, "0");
  for (const ch of email) out += (ch.charCodeAt(0) ^ key).toString(16).padStart(2, "0");
  return out;
}

describe("Cloudflare de-obfuscation", () => {
  test("decodes a protected address", () => {
    expect(decodeCfEmail(cfEncode("info@joesdiner.com"))).toBe("info@joesdiner.com");
  });

  test("decodes with a different XOR key", () => {
    expect(decodeCfEmail(cfEncode("hola@taqueria.mx", 0x2b))).toBe("hola@taqueria.mx");
  });

  test("rejects garbage rather than emitting nonsense", () => {
    expect(decodeCfEmail("zz")).toBeNull();
    expect(decodeCfEmail("")).toBeNull();
    expect(decodeCfEmail("7a6f")).toBeNull(); // decodes, but has no "@"
  });

  test("pulls addresses out of both Cloudflare markups", () => {
    const enc = cfEncode("contact@bistro.com");
    const html = `
      <a class="__cf_email__" data-cfemail="${enc}">[email&#160;protected]</a>
      <a href="/cdn-cgi/l/email-protection#${enc}">Email us</a>`;
    const found = extractCfEmails(html);
    expect(found).toContain("contact@bistro.com");
    expect(found.length).toBe(2); // both forms matched
  });
});

// ---------------------------------------------------------------------------
// Extractor 2 — mailto:
// ---------------------------------------------------------------------------

describe("mailto: extraction", () => {
  test("finds an address behind a text label", () => {
    const html = `<a href="mailto:owner@lataqueria.com">Email us</a>`;
    expect(extractMailtoEmails(html)).toEqual(["owner@lataqueria.com"]);
  });

  test("strips query params and decodes escapes", () => {
    const html = `<a href="mailto:hi%40cafe.com?subject=Hello%20there">Contact</a>`;
    expect(extractMailtoEmails(html)).toEqual(["hi@cafe.com"]);
  });

  test("ignores a mailto with no address", () => {
    expect(extractMailtoEmails(`<a href="mailto:">x</a>`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Extractor 3 — JSON-LD
// ---------------------------------------------------------------------------

describe("JSON-LD extraction", () => {
  test("reads email from a schema.org Restaurant block", () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Restaurant","name":"Casa Luz","email":"casa@casaluz.com","telephone":"305-555-1212"}
    </script>`;
    expect(extractJsonLdEmails(html)).toEqual(["casa@casaluz.com"]);
  });

  test("walks @graph arrays and nested objects", () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"WebSite"},{"@type":"LocalBusiness","contactPoint":{"email":"mailto:deep@nested.com"}}]}
    </script>`;
    expect(extractJsonLdEmails(html)).toEqual(["deep@nested.com"]); // mailto: prefix stripped
  });

  test("malformed JSON-LD never throws", () => {
    expect(() => extractJsonLdEmails(`<script type="application/ld+json">{oops,,}</script>`)).not.toThrow();
    expect(extractJsonLdEmails(`<script type="application/ld+json">{oops,,}</script>`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Extractor 4 — meta tags
// ---------------------------------------------------------------------------

describe("meta tag extraction", () => {
  test("reads og:email", () => {
    expect(extractMetaEmails(`<meta property="og:email" content="hi@spot.com">`)).toEqual(["hi@spot.com"]);
  });
  test("ignores unrelated meta tags", () => {
    expect(extractMetaEmails(`<meta name="description" content="best tacos">`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The vendor-domain guard — the latofonts bug
// ---------------------------------------------------------------------------

describe("isAcceptableDomain — vendor guard", () => {
  test("REJECTS a font-foundry address scraped off the CSS (the real bug)", () => {
    expect(isAcceptableDomain("latofonts.com", "penelopesvegantaqueria.com")).toBe(false);
  });

  test("rejects agency / platform / analytics domains", () => {
    for (const d of ["squarespace.com", "google-analytics.com", "someagency.io", "wpengine.com"]) {
      expect(isAcceptableDomain(d, "joesdiner.com"), d).toBe(false);
    }
  });

  test("accepts the restaurant's own domain", () => {
    expect(isAcceptableDomain("joesdiner.com", "joesdiner.com")).toBe(true);
  });

  test("accepts consumer mailbox hosts (common for small independents)", () => {
    expect(isAcceptableDomain("gmail.com", "joesdiner.com")).toBe(true);
    expect(isAcceptableDomain("yahoo.com", "joesdiner.com")).toBe(true);
  });

  test("accepts a clearly related domain", () => {
    expect(isAcceptableDomain("joesdinergroup.com", "joesdiner.com")).toBe(true);
  });

  test("with no site domain, only consumer hosts pass", () => {
    expect(isAcceptableDomain("gmail.com", null)).toBe(true);
    expect(isAcceptableDomain("randomvendor.com", null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guess generator
// ---------------------------------------------------------------------------

describe("guessEmailCandidates", () => {
  test("generates standard mailboxes on the restaurant's own domain", () => {
    expect(guessEmailCandidates("https://www.joesdiner.com/menu")).toEqual([
      "info@joesdiner.com",
      "contact@joesdiner.com",
      "hello@joesdiner.com",
    ]);
  });

  test("refuses to guess on someone else's platform", () => {
    for (const url of [
      "https://joesdiner.wixsite.com/home",
      "https://www.facebook.com/joesdiner",
      "https://joes.square.site",
      "https://order.toasttab.com/joes",
    ]) {
      expect(guessEmailCandidates(url), url).toEqual([]);
    }
  });

  test("refuses to guess on a consumer mailbox host or a bad URL", () => {
    expect(guessEmailCandidates("https://gmail.com")).toEqual([]);
    expect(guessEmailCandidates("not a url")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression: CSS/JS attribution text must not be scraped as a contact address
// (impallari@gmail.com — the Lato font designer's email — was pulled from a
// restaurant site's <style> block via a font license comment).
// ---------------------------------------------------------------------------

describe("stripNonContentBlocks — the font-designer bug", () => {
  test("removes emails hidden in <style> (font/theme attributions)", () => {
    const html = `<html><head>
      <style>/* Lato by Pablo Impallari, impallari@gmail.com */ body{font:Lato}</style>
      </head><body><p>Contact: info@realrestaurant.com</p></body></html>`;
    const stripped = stripNonContentBlocks(html);
    expect(stripped).not.toContain("impallari@gmail.com");
    expect(stripped).toContain("info@realrestaurant.com");
  });

  test("removes emails in non-JSON-LD <script> but KEEPS JSON-LD scripts intact", () => {
    const html = `<html><body>
      <script>var analytics = "tracking@vendor.io";</script>
      <script type="application/ld+json">{"email":"owner@spot.com"}</script>
      </body></html>`;
    const stripped = stripNonContentBlocks(html);
    expect(stripped).not.toContain("tracking@vendor.io");
    expect(stripped).toContain("owner@spot.com"); // JSON-LD block preserved for extractJsonLdEmails
  });

  test("removes HTML comments", () => {
    const html = `<!-- built by agency@webshop.com --><p>hi@thediner.com</p>`;
    const stripped = stripNonContentBlocks(html);
    expect(stripped).not.toContain("agency@webshop.com");
    expect(stripped).toContain("hi@thediner.com");
  });
});

// ---------------------------------------------------------------------------
// Regression: a listing/menu PLATFORM must never be treated as the restaurant's
// own domain, even when Places records it as the restaurant's "website"
// (hello@findaloco.com — a menu-listing platform, not the restaurant).
// ---------------------------------------------------------------------------

describe("isNonOwnedHost / isAcceptableDomain — the platform-mailbox bug", () => {
  test("a listing-platform mailbox is rejected even though it's the recorded website domain", () => {
    expect(isNonOwnedHost("findaloco.com")).toBe(true);
    // Even matching the "site domain" doesn't save it — a platform is never owned.
    expect(isAcceptableDomain("findaloco.com", "findaloco.com")).toBe(false);
  });

  test("a subdomain of a platform is also rejected", () => {
    expect(isNonOwnedHost("joesdiner.square.site")).toBe(true);
  });

  test("the restaurant's real domain still passes", () => {
    expect(isAcceptableDomain("joesdiner.com", "joesdiner.com")).toBe(true);
  });

  // Caught live 2026-08-23: Places listed white-label ordering pages as the
  // restaurant's website, so the guess fallback burned NeverBounce checks on
  // mailboxes like info@ordertaqueriamorelia.mobile-webview4.com. The numbered
  // shards (mobile-webview2/4/6.com) can't be enumerated in a static list, so
  // they match by pattern.
  test("white-label ordering hosts caught in production are non-owned", () => {
    expect(isNonOwnedHost("qmenu.us")).toBe(true);
    expect(isNonOwnedHost("ordertaqueriamorelia.mobile-webview4.com")).toBe(true);
    expect(isNonOwnedHost("ordertaqueraaelbosqueil.mobile-webview2.com")).toBe(true);
    expect(isNonOwnedHost("orderlacarreta.mobile-webview6.com")).toBe(true);
  });

  test("the shard pattern doesn't swallow a real domain that merely mentions webview", () => {
    expect(isNonOwnedHost("mobilewebview.com")).toBe(false); // no dot/hyphen shape match
    expect(isNonOwnedHost("webviewcafe.com")).toBe(false);
  });

  test("guessing is skipped entirely on the pattern-matched hosts", () => {
    expect(guessEmailCandidates("https://ordertaqueriamorelia.mobile-webview4.com")).toEqual([]);
    expect(guessEmailCandidates("https://qmenu.us/#/tacos-el-rey")).toEqual([]);
  });
});
