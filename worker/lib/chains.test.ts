// Tests for the franchise denylist (worker/lib/chains.ts). The matcher must be
// aggressive on real franchise names (with store numbers / location suffixes)
// but must NOT swallow independent restaurants that merely contain a food word.
// Run with `bun test`.

import { expect, test, describe } from "bun:test";
import { isKnownChain } from "./chains";

describe("isKnownChain — catches franchises", () => {
  test("bare franchise names", () => {
    for (const n of ["McDonald's", "Pizza Hut", "Subway", "Chipotle", "Panda Express", "Dunkin'", "KFC", "Wendy's"]) {
      expect(isKnownChain(n), n).toBe(true);
    }
  });

  test("franchise names with store numbers and location suffixes", () => {
    expect(isKnownChain("Subway #2841")).toBe(true);
    expect(isKnownChain("McDonald's Times Square")).toBe(true);
    expect(isKnownChain("Pizza Hut - Little Havana")).toBe(true);
    expect(isKnownChain("Domino's Pizza (Hialeah)")).toBe(true);
  });

  test("punctuation/case/diacritic variants normalize the same", () => {
    expect(isKnownChain("wendys")).toBe(true);
    expect(isKnownChain("WENDY’S")).toBe(true); // curly apostrophe
    expect(isKnownChain("Chick-fil-A")).toBe(true);
  });
});

describe("isKnownChain — spares independents", () => {
  test("local names that merely contain a food word are NOT chains", () => {
    for (const n of ["Havana Pizza", "El Exquisito", "AHI Sushi Bar", "Joe's Diner", "La Terraza Little Havana", "Taqueria El Rey"]) {
      expect(isKnownChain(n), n).toBe(false);
    }
  });

  test("a franchise word in the MIDDLE of a local name does not match", () => {
    // starts-with matching only — "Casa Subway Cafe" is contrived but proves we
    // don't substring-match anywhere in the name.
    expect(isKnownChain("Casa Domino Cubano")).toBe(false); // 'domino' mid-name, and not the franchise 'dominos'
  });

  test("empty / null / whitespace is not a chain", () => {
    expect(isKnownChain("")).toBe(false);
    expect(isKnownChain(null)).toBe(false);
    expect(isKnownChain(undefined)).toBe(false);
    expect(isKnownChain("   ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression: 4 real leads reached the "queued" (ready-to-email) pool in
// production before this fix — two 7-Eleven convenience-store locations, and
// two casual-dining chains (Lazy Dog, Foster's Freeze) not in the first pass.
// ---------------------------------------------------------------------------

describe("isKnownChain — production gaps (Aug 2026 backfill run)", () => {
  test("convenience stores Google tags as restaurants", () => {
    expect(isKnownChain("7-Eleven")).toBe(true);
    expect(isKnownChain("Circle K")).toBe(true);
    expect(isKnownChain("Wawa")).toBe(true);
  });

  test("regional casual-dining chains missed by the first pass", () => {
    expect(isKnownChain("Lazy Dog Restaurant & Bar")).toBe(true);
    expect(isKnownChain("Fosters Freeze")).toBe(true);
    expect(isKnownChain("Portillo's")).toBe(true);
  });

  test("Pollo Feliz — caught via a per-city franchise subdomain (chicago.pollofeliz.com)", () => {
    expect(isKnownChain("Pollo Feliz")).toBe(true);
  });

  test("Pure Green — caught via a franchise domain with per-location URL paths", () => {
    // puregreenfranchise.com/new-york/washington-heights/ — the domain guard
    // correctly allows the on-domain contact address; the gap was the chain
    // name list, not the domain check.
    expect(isKnownChain("Pure Green")).toBe(true);
    expect(isKnownChain("Pure Green - Juice Bar Washington Heights")).toBe(true);
  });

  test("a hotel-chain dining outlet is caught by its WEBSITE domain, not its name", () => {
    // "Noe Restaurant & Bar" itself is unbranded — only the website reveals it's
    // a corporate hotel-chain outlet (info@omnihotels.com).
    expect(isKnownChain("Noe Restaurant & Bar")).toBe(false); // name alone: no signal
    expect(isKnownChain("Noe Restaurant & Bar", "https://www.omnihotels.com/hotels/x/dining/noe-restaurant")).toBe(true);
  });

  test("other major hotel-chain domains are caught the same way", () => {
    for (const domain of ["https://www.marriott.com/x", "https://www.hilton.com/x", "https://www.hyatt.com/x"]) {
      expect(isKnownChain("Some Hotel Restaurant", domain), domain).toBe(true);
    }
  });

  test("an independent restaurant's own domain is never mistaken for a hotel chain", () => {
    expect(isKnownChain("Joe's Diner", "https://joesdiner.com")).toBe(false);
  });

  test("a malformed website never throws, just contributes no domain signal", () => {
    expect(isKnownChain("Some Place", "not a url")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression: on 2026-08-24 an Anthropic outage took the LLM chain check
// offline (it fails open), and these reached `queued` with nothing to stop
// them — exactly the big, unambiguous names this FREE list exists to catch so
// they never depend on a paid API call.
// ---------------------------------------------------------------------------

describe("isKnownChain — names that slipped through during the Anthropic outage", () => {
  test("the three that actually reached the queue", () => {
    expect(isKnownChain("sweetgreen - Healthy Salads, Wraps, and Bowls")).toBe(true);
    expect(isKnownChain("Lou Malnati's Pizzeria")).toBe(true);
    expect(isKnownChain("Big Bad Breakfast-Nashville")).toBe(true);
  });

  test("other national fast-casual names added in the same pass", () => {
    for (const n of ["CAVA", "Dave's Hot Chicken", "The Halal Guys", "Nando's", "Pollo Tropical"]) {
      expect(isKnownChain(n), n).toBe(true);
    }
  });

  test("still spares independents whose names merely start similarly", () => {
    // "Cava" is a real word (and a wine) — make sure we only match it standing
    // alone or as a leading token, not buried in a local name.
    expect(isKnownChain("La Cava del Tequila")).toBe(false);
    expect(isKnownChain("Sweetgreens Family Diner")).toBe(false); // 'sweetgreens' != 'sweetgreen'
  });
});
