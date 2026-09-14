// Tests for the pure fair-share allocator in sendAllocation.ts. No DB, no
// clock reads — every case is a plain ZoneDay[] + cap + rotation. Run with
// `bun test`.

import { expect, test, describe } from "bun:test";
import { zoneQuotas, touch1ReservedToday, pickTouch1, type ZoneDay } from "./sendAllocation";

const zone = (zone: string, phase: ZoneDay["phase"], pending: number, sent = 0): ZoneDay => ({
  zone,
  phase,
  pending,
  sent,
});

describe("zoneQuotas — max-min water-filling", () => {
  test("equal demand across 4 zones splits the cap as evenly as possible, remainder rotates", () => {
    const zones = [zone("ET", "open", 10), zone("CT", "before", 10), zone("MT", "before", 10), zone("PT", "before", 10)];
    const q0 = zoneQuotas(5, zones, 0);
    // floor(5/4)=1 each, 1 left over -> exactly one zone gets 2, the rest get 1.
    expect([...q0.values()].sort()).toEqual([1, 1, 1, 2]);
    expect([...q0.values()].reduce((a, b) => a + b, 0)).toBe(5); // the whole cap is allocated, none wasted
    // Rotation shifts WHICH zone gets the extra slot.
    const q1 = zoneQuotas(5, zones, 1);
    const zoneWithExtra = (q: Map<string, number>) => [...q.entries()].find(([, v]) => v === 2)?.[0];
    expect(zoneWithExtra(q0)).not.toBe(zoneWithExtra(q1));
  });

  test("a low-demand zone gets fully satisfied and the rest flows to the others — the original bug scenario", () => {
    // ET has 10 pending, PT has only 1. A naive equal split would give ET 2 and
    // PT 2 (wasting 1), or (worse) ET could claim the whole cap first. Water-
    // filling gives PT exactly what it can use (1) and ET the rest (4).
    const zones = [zone("ET", "open", 10), zone("PT", "open", 1)];
    const q = zoneQuotas(5, zones, 0);
    expect(q.get("PT")).toBe(1);
    expect(q.get("ET")).toBe(4);
  });

  test("a zone whose window already closed today gets 0 additional quota, even with unsent pending", () => {
    const zones = [zone("ET", "closed", 20, 3), zone("PT", "open", 5)];
    const q = zoneQuotas(5, zones, 0);
    // ET's pending doesn't count (window closed) — only its already-sent 3
    // counts as claimed demand, so it doesn't compete for the remaining cap.
    expect(q.get("ET")).toBe(3);
    expect(q.get("PT")).toBe(2);
  });

  test("a weekend zone (not_today) has zero demand", () => {
    const zones = [zone("ET", "not_today", 20), zone("CT", "open", 3)];
    const q = zoneQuotas(5, zones, 0);
    expect(q.get("ET")).toBe(0);
    expect(q.get("CT")).toBe(3);
  });

  test("total allocated never exceeds the cap", () => {
    const zones = [zone("ET", "open", 3), zone("CT", "before", 3), zone("MT", "before", 3), zone("PT", "before", 3)];
    for (const cap of [0, 1, 2, 5, 11, 12, 50]) {
      const q = zoneQuotas(cap, zones, 0);
      const total = [...q.values()].reduce((a, b) => a + b, 0);
      expect(total, `cap ${cap}`).toBeLessThanOrEqual(cap);
    }
  });

  test("zero cap gives every zone zero", () => {
    const zones = [zone("ET", "open", 5), zone("PT", "before", 5)];
    const q = zoneQuotas(0, zones, 0);
    expect(q.get("ET")).toBe(0);
    expect(q.get("PT")).toBe(0);
  });

  test("over 4 consecutive days, every zone gets the extra slot exactly once (cap 3, 4 zones)", () => {
    const zones = [zone("A", "open", 10), zone("B", "open", 10), zone("C", "open", 10), zone("D", "open", 10)];
    const winners = new Set<string>();
    for (let day = 0; day < 4; day++) {
      const q = zoneQuotas(3, zones, day);
      // floor(3/4)=0 base, so exactly 3 zones get 1 and one gets 0 each day.
      const withOne = [...q.entries()].filter(([, v]) => v === 1).map(([z]) => z);
      expect(withOne.length).toBe(3);
      const withZero = [...q.entries()].find(([, v]) => v === 0)?.[0]!;
      winners.add(withZero);
    }
    expect(winners.size).toBe(4); // each zone was the one left out exactly once
  });
});

describe("touch1ReservedToday", () => {
  test("bounded by cap — the original bug reserved every pending row regardless of cap", () => {
    // 15 approved pending across zones the reply-poll/bump job used to reserve
    // in full via approvedTouch1Pending(), even though only `cap` can ever
    // send today.
    const zones = [zone("ET", "open", 5), zone("CT", "open", 5), zone("MT", "open", 5)];
    expect(touch1ReservedToday(zones, 5, 0)).toBe(5); // never more than the cap itself
  });

  test("a zone with no window left today (Saturday) reserves nothing for bumps to wait on", () => {
    const zones = [zone("ET", "not_today", 10), zone("CT", "not_today", 5)];
    expect(touch1ReservedToday(zones, 5, 0)).toBe(0);
  });

  test("a zone that already got its full quota today reserves nothing further", () => {
    const zones = [zone("ET", "closed", 0, 4)];
    // ET is done for today (closed, nothing pending) — quota settles at
    // exactly what it already sent, so there's nothing left to reserve.
    expect(touch1ReservedToday(zones, 5, 0)).toBe(0);
  });

  test("a zone still mid-window with unsent approved rows reserves the gap between quota and sent-so-far", () => {
    const zones = [zone("ET", "open", 3, 1)]; // sent 1 already, 3 more pending, phase still open
    // demand = sent(1) + pending(3) = 4, cap 5 covers it fully -> quota 4,
    // reserved = quota(4) - sent(1) = 3 (the sends still to come this tick/day).
    expect(touch1ReservedToday(zones, 5, 0)).toBe(3);
  });
});

describe("pickTouch1", () => {
  type Row = { id: number; zone: string };

  test("regression: at 9am ET with 15 approved spread across 4 zones, ET must not take all 5", () => {
    // Only ET is "open" at this instant (the others haven't hit 9am local
    // yet) — the exact scenario that used to drain the whole cap into ET.
    const zones = [
      zone("ET", "open", 4),
      zone("CT", "before", 4),
      zone("MT", "before", 4),
      zone("PT", "before", 3),
    ];
    const inWindow: Row[] = Array.from({ length: 4 }, (_, i) => ({ id: i, zone: "ET" })); // only ET is in-window right now
    // rotation 1 sends the odd remainder slot to CT, not ET, so this isolates
    // ET's plain base share.
    const picked = pickTouch1(inWindow, zones, { cap: 5, perTick: 6, rotation: 1 });
    expect(picked.length).toBeLessThan(5); // ET's fair share, not the whole cap
    expect(picked.length).toBe(1); // floor(5/4)=1 base share, remainder goes elsewhere this rotation
  });

  test("respects perTick even when a zone's quota is larger", () => {
    const zones = [zone("ET", "open", 10)];
    const inWindow: Row[] = Array.from({ length: 10 }, (_, i) => ({ id: i, zone: "ET" }));
    const picked = pickTouch1(inWindow, zones, { cap: 50, perTick: 3, rotation: 0 });
    expect(picked.length).toBe(3);
  });

  test("a zone at its quota doesn't block later rows from a different zone", () => {
    const zones = [zone("ET", "open", 1), zone("PT", "open", 5)];
    // ET's single row comes first in approval order, then PT's rows.
    const inWindow: Row[] = [{ id: 1, zone: "ET" }, { id: 2, zone: "PT" }, { id: 3, zone: "PT" }];
    const picked = pickTouch1(inWindow, zones, { cap: 6, perTick: 6, rotation: 0 });
    // ET quota=1 (floor(6/2)=3 each but ET demand=1 so fully satisfied at 1,
    // remaining 5 cap all goes to PT) — ET's 1 row picked, both PT rows fit.
    expect(picked.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  test("preserves oldest-first order within a zone", () => {
    const zones = [zone("ET", "open", 5)];
    const inWindow: Row[] = [{ id: 10, zone: "ET" }, { id: 20, zone: "ET" }, { id: 30, zone: "ET" }];
    const picked = pickTouch1(inWindow, zones, { cap: 5, perTick: 2, rotation: 0 });
    expect(picked.map((r) => r.id)).toEqual([10, 20]);
  });

  test("an empty in-window list picks nothing", () => {
    expect(pickTouch1([], [zone("ET", "open", 5)], { cap: 5, perTick: 6, rotation: 0 })).toEqual([]);
  });
});
