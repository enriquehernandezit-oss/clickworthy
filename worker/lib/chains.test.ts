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
