// Tests for the date-range resolver (lib/financeStats.ts) — specifically the
// custom from/to filter added 2026-08-24. The boundary handling (inclusive
// `to`, open-ended sides, inverted input, clamping the future) is exactly where
// a date filter silently returns the wrong window, so it's pinned here.
// Run with `bun test`.

import { expect, test, describe } from "bun:test";
import { resolveRange, rangeParams } from "./financeStats";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe("resolveRange — presets still work", () => {
  test("a known preset resolves to its key", () => {
    const r = resolveRange({ range: "90d" });
    expect(r.key).toBe("90d");
    expect(r.fromInput).toBeNull();
    expect(r.toInput).toBeNull();
    expect(r.days).toBe(90);
  });

  test("no params defaults to 30d", () => {
    expect(resolveRange({}).key).toBe("30d");
  });

  test("an unknown range value falls back to 30d, never throws", () => {
    expect(resolveRange({ range: "bogus" }).key).toBe("30d");
  });
});

describe("resolveRange — custom from/to", () => {
  test("both dates → custom window, `to` inclusive of the chosen day", () => {
    const r = resolveRange({ from: "2026-08-01", to: "2026-08-15" });
    expect(r.key).toBe("custom");
    expect(ymd(r.from)).toBe("2026-08-01");
    // inclusive: the window must extend into Aug 16 00:00 to cover all of Aug 15
    expect(r.to.toISOString()).toBe("2026-08-16T00:00:00.000Z");
    expect(r.fromInput).toBe("2026-08-01");
    expect(r.toInput).toBe("2026-08-15");
  });

  test("a single day spans exactly one day", () => {
    const r = resolveRange({ from: "2026-08-15", to: "2026-08-15" });
    expect(r.days).toBe(1);
    expect(r.from.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-08-16T00:00:00.000Z");
  });

  test("open start → from EPOCH up to the chosen day", () => {
    const r = resolveRange({ to: "2026-08-15" });
    expect(r.key).toBe("custom");
    expect(r.from.getUTCFullYear()).toBe(2020);
    expect(r.toInput).toBe("2026-08-15");
  });

  test("open end → from the chosen day up to now", () => {
    const r = resolveRange({ from: "2026-08-01" });
    expect(r.key).toBe("custom");
    expect(r.fromInput).toBe("2026-08-01");
    // `to` is clamped to now; just assert it's after the start
    expect(r.to.getTime()).toBeGreaterThan(r.from.getTime());
  });

  test("inverted input (from after to) normalizes to the correct order", () => {
    const inv = resolveRange({ from: "2026-08-15", to: "2026-08-01" });
    const ok = resolveRange({ from: "2026-08-01", to: "2026-08-15" });
    expect(inv.fromInput).toBe(ok.fromInput);
    expect(inv.toInput).toBe(ok.toInput);
    expect(inv.days).toBe(ok.days);
    expect(inv.from.getTime()).toBe(ok.from.getTime());
    expect(inv.to.getTime()).toBe(ok.to.getTime());
  });

  test("a future `to` is clamped to now, not an empty forward window", () => {
    const r = resolveRange({ from: "2026-08-01", to: "2099-01-01" });
    expect(r.to.getTime()).toBeLessThanOrEqual(Date.now());
    expect(r.days).toBeGreaterThan(0);
  });

  test("garbage dates fall back to the preset path", () => {
    expect(resolveRange({ from: "not-a-date" }).key).toBe("30d");
    expect(resolveRange({ from: "2026-13-40" }).key).toBe("30d");
  });

  test("explicit dates win over a stale range param", () => {
    const r = resolveRange({ range: "all", from: "2026-08-20", to: "2026-08-22" });
    expect(r.key).toBe("custom");
    expect(r.fromInput).toBe("2026-08-20");
  });
});

describe("rangeParams — round-trips the active window into a URL", () => {
  test("a preset carries range=<key> and no dates", () => {
    expect(rangeParams(resolveRange({ range: "90d" }))).toEqual({ range: "90d" });
  });

  test("a custom window carries from/to and NO range (which would win at 30d)", () => {
    const p = rangeParams(resolveRange({ from: "2026-08-01", to: "2026-08-15" }));
    expect(p).toEqual({ from: "2026-08-01", to: "2026-08-15" });
    expect(p.range).toBeUndefined();
  });

  test("re-resolving rangeParams output reproduces the same window", () => {
    const first = resolveRange({ from: "2026-08-01", to: "2026-08-15" });
    const second = resolveRange(rangeParams(first));
    expect(second.from.getTime()).toBe(first.from.getTime());
    expect(second.to.getTime()).toBe(first.to.getTime());
  });
});
