// Tests for the pure decision logic in lib/pipelineHealth.ts. The DB-backed
// functions (getRunHealth, getReplyPollHealth, etc.) aren't covered here —
// this file only tests logic that doesn't require a database. Run with
// `bun test`.

import { expect, test, describe } from "bun:test";
import { isReplyPollStale, REPLY_POLL_STALE_MINUTES, isSourcingBacklogDeep, SOURCING_BACKLOG_MAX_DAYS } from "./pipelineHealth";

// Fixed reference instant — deterministic regardless of when the test runs.
const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

describe("isReplyPollStale", () => {
  test("never run yet (null) is NOT stale — nothing to judge staleness against", () => {
    expect(isReplyPollStale(null, NOW)).toBe(false);
  });

  test("just under the default threshold is not stale", () => {
    expect(isReplyPollStale(minutesAgo(REPLY_POLL_STALE_MINUTES - 1), NOW)).toBe(false);
  });

  test("exactly at the default threshold IS stale (>=, not >)", () => {
    expect(isReplyPollStale(minutesAgo(REPLY_POLL_STALE_MINUTES), NOW)).toBe(true);
  });

  test("well past the default threshold is stale", () => {
    expect(isReplyPollStale(minutesAgo(REPLY_POLL_STALE_MINUTES * 5), NOW)).toBe(true);
  });

  test("a run moments ago is not stale", () => {
    expect(isReplyPollStale(minutesAgo(1), NOW)).toBe(false);
  });

  test("respects a custom threshold instead of the default", () => {
    expect(isReplyPollStale(minutesAgo(45), NOW, 30)).toBe(true);
    expect(isReplyPollStale(minutesAgo(45), NOW, 90)).toBe(false);
  });

  test("a lastRunAt in the future (clock skew) is not stale", () => {
    expect(isReplyPollStale(new Date(NOW + 5 * 60_000).toISOString(), NOW)).toBe(false);
  });
});

describe("isSourcingBacklogDeep", () => {
  test("today's real numbers (28 unsent / 5 per day = 5.6 days) do NOT trigger", () => {
    expect(isSourcingBacklogDeep(28, 5)).toBe(false);
  });

  test("just under the default ceiling is not deep", () => {
    // 14 days at cap 5 = 70; one lead under that is 69.
    expect(isSourcingBacklogDeep(69, 5)).toBe(false);
  });

  test("just over the default ceiling IS deep (strictly greater than, not >=)", () => {
    expect(isSourcingBacklogDeep(70, 5)).toBe(false); // exactly 14 days — not yet past it
    expect(isSourcingBacklogDeep(71, 5)).toBe(true); // just past it
  });

  test("a simulated triple-sized backlog (100 / 5/day = 20 days) is deep", () => {
    expect(isSourcingBacklogDeep(100, 5)).toBe(true);
  });

  test("a zero or negative daily cap never blocks — can't compute a meaningful ratio", () => {
    expect(isSourcingBacklogDeep(1000, 0)).toBe(false);
    expect(isSourcingBacklogDeep(1000, -1)).toBe(false);
  });

  test("zero backlog is never deep, regardless of cap", () => {
    expect(isSourcingBacklogDeep(0, 5)).toBe(false);
  });

  test("respects a custom maxDays instead of the default", () => {
    expect(isSourcingBacklogDeep(30, 5, 3)).toBe(true); // 6 days > 3-day ceiling
    expect(isSourcingBacklogDeep(30, 5, 10)).toBe(false); // 6 days < 10-day ceiling
  });

  test("the exported default matches the documented 14-day ceiling", () => {
    expect(SOURCING_BACKLOG_MAX_DAYS).toBe(14);
  });
});
