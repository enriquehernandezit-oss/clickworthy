// Tests the business-hours send gate against FIXED UTC instants, so no clock
// mocking is needed — isInLocalWindow() is pure. The point is to pin the
// timezone math: 11am AST is 6am PT (blocked) and 10am ET (allowed), and DST
// shifts the UTC offset without shifting the local window.

import { expect, test, describe } from "bun:test";
import { isInLocalWindow, resolveTimeZone, describeSendWindow, uncoveredCities, hasExplicitTimeZone, SENDER_TIME_ZONE } from "./sendWindow";
import { config } from "../config";

// A weekday during US Daylight Saving Time (summer): Wed 2026-08-26.
// ET = UTC-4, CT = UTC-5, MT = UTC-6, PT = UTC-7.
const AUG = (utcHour: number, min = 0) => Date.UTC(2026, 7, 26, utcHour, min);
// A weekday during Standard Time (winter): Wed 2026-01-14.
// ET = UTC-5, PT = UTC-8.
const JAN = (utcHour: number) => Date.UTC(2026, 0, 14, utcHour);

describe("resolveTimeZone", () => {
  test("maps target cities, with or without a state suffix", () => {
    expect(resolveTimeZone("Miami, FL")).toBe("America/New_York");
    expect(resolveTimeZone("Miami")).toBe("America/New_York");
    expect(resolveTimeZone("Los Angeles, CA")).toBe("America/Los_Angeles");
    expect(resolveTimeZone("Chicago")).toBe("America/Chicago");
    expect(resolveTimeZone("Denver, CO")).toBe("America/Denver");
  });

  test("falls back to the sender zone for an unknown or null city", () => {
    expect(resolveTimeZone(null)).toBe(SENDER_TIME_ZONE);
    expect(resolveTimeZone("Reykjavik")).toBe(SENDER_TIME_ZONE);
  });

  test("substring-matches a neighborhood that contains a known city", () => {
    expect(resolveTimeZone("New York — Brooklyn")).toBe("America/New_York");
  });
});

describe("isInLocalWindow — one instant, different answers per recipient zone", () => {
  // 15:00 UTC on the August weekday = 11am ET, 10am CT, 9am MT, 8am PT.
  const t = AUG(15);
  test("11am ET (Miami) is inside the 9–12 window", () => {
    expect(isInLocalWindow("Miami, FL", t)).toBe(true);
  });
  test("10am CT (Chicago) is inside", () => {
    expect(isInLocalWindow("Chicago, IL", t)).toBe(true);
  });
  test("9am MT (Denver) is inside (boundary — start is inclusive)", () => {
    expect(isInLocalWindow("Denver, CO", t)).toBe(true);
  });
  test("8am PT (Los Angeles) is too early — blocked", () => {
    expect(isInLocalWindow("Los Angeles, CA", t)).toBe(false);
  });
});

describe("isInLocalWindow — window edges", () => {
  test("12pm local is outside (end is exclusive)", () => {
    // 16:00 UTC Aug = 12pm ET.
    expect(isInLocalWindow("Miami, FL", AUG(16))).toBe(false);
  });
  test("8:59am local is outside; 9:00am is inside", () => {
    // 12:59 UTC Aug = 8:59am ET; 13:00 UTC = 9:00am ET.
    expect(isInLocalWindow("Miami, FL", AUG(12, 59))).toBe(false);
    expect(isInLocalWindow("Miami, FL", AUG(13, 0))).toBe(true);
  });
});

describe("isInLocalWindow — DST correctness (same wall-clock target, different UTC offset)", () => {
  test("11am ET is inside in BOTH summer (UTC-4) and winter (UTC-5)", () => {
    expect(isInLocalWindow("Miami, FL", AUG(15))).toBe(true); // 15Z = 11am EDT
    expect(isInLocalWindow("Miami, FL", JAN(16))).toBe(true); // 16Z = 11am EST
  });
  test("the SAME UTC instant flips as the offset shifts across DST", () => {
    // 13:00 UTC: 9am EDT (summer, allowed) vs 8am EST (winter, blocked).
    expect(isInLocalWindow("Miami, FL", AUG(13))).toBe(true);
    expect(isInLocalWindow("Miami, FL", JAN(13))).toBe(false);
  });
});

describe("isInLocalWindow — weekends are skipped", () => {
  // Sat 2026-08-29, 15:00 UTC = 11am ET on a Saturday.
  test("Saturday inside the hour window is still blocked", () => {
    expect(isInLocalWindow("Miami, FL", Date.UTC(2026, 7, 29, 15))).toBe(false);
  });
  // Sun 2026-08-30.
  test("Sunday is blocked", () => {
    expect(isInLocalWindow("Miami, FL", Date.UTC(2026, 7, 30, 15))).toBe(false);
  });
});

describe("describeSendWindow", () => {
  test("reads as a business-hours sentence", () => {
    expect(describeSendWindow()).toBe("9am–12pm local time, Mon–Fri (per recipient's city)");
  });
});

describe("timezone coverage — every target city must map, none silently fall back", () => {
  // Guards the drift hazard: CITY_TIME_ZONES (sendWindow.ts) and the target
  // city list (config) live in different files. This fails at CI if someone
  // adds a target city without a timezone, before it can send at ~6am local.
  test("the shipped default targetCities are all explicitly mapped", () => {
    const DEFAULT_CITIES = "Miami, FL; New York, NY; Chicago, IL; Los Angeles, CA; Nashville, TN; Denver, CO; San Diego, CA"
      .split(";")
      .map((c) => c.trim());
    expect(uncoveredCities(DEFAULT_CITIES)).toEqual([]);
  });

  test("the live config.targetCities are all mapped (catches an env override too)", () => {
    expect(uncoveredCities(config.targetCities)).toEqual([]);
  });

  test("an unmapped city is reported as uncovered", () => {
    expect(hasExplicitTimeZone("Phoenix, AZ")).toBe(false);
    expect(uncoveredCities(["Miami, FL", "Phoenix, AZ"])).toEqual(["Phoenix, AZ"]);
  });

  test("AST fallback actually gates a window for an unmapped city", () => {
    // 15:00 UTC = 11am AST (UTC-4) -> inside 9-12 for the fallback zone.
    expect(isInLocalWindow("Reykjavik", Date.UTC(2026, 7, 26, 15))).toBe(true);
    // 18:00 UTC = 2pm AST -> outside.
    expect(isInLocalWindow("Reykjavik", Date.UTC(2026, 7, 26, 18))).toBe(false);
  });
});
