// Tests for the pure decision logic in lib/pipelineHealth.ts. The DB-backed
// functions (getRunHealth, getReplyPollHealth, etc.) aren't covered here —
// this file only tests logic that doesn't require a database. Run with
// `bun test`.

import { expect, test, describe } from "bun:test";
import { isReplyPollStale, REPLY_POLL_STALE_MINUTES } from "./pipelineHealth";

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
