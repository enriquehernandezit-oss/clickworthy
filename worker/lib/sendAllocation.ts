// Fair-share allocation of the daily Touch 1 send cap across recipient time
// zones. Pure — no DB, no clock reads — so the fairness math is unit-tested
// directly (see sendAllocation.test.ts); the DB-backed snapshot that feeds it
// lives in sendOutreach.ts.
//
// THE BUG THIS FIXES: sendApproved() used to fill the daily cap in plain
// oldest-approved-first order. Every target city east of the Rockies opens
// its 9am-12pm window before Los Angeles/San Diego (Pacific) or Denver
// (Mountain) do, so at a 5/day cap the Eastern/Central backlog alone was
// enough to exhaust it before the Western zones ever got a chance — 0 sends
// to LA, San Diego, or Denver in 14 days, despite leads approved there since
// Aug 29 (caught 2026-09-13). A plain "give each zone cap/zoneCount, rounded
// up" doesn't work either: with 4 zones and a cap of 5, ceil(5/4)=2 each
// sums to 8 — over the cap — so the LAST zone to open would still starve
// under the real daily ceiling. Max-min water-filling is the standard fix:
// give every zone an equal share, and only let a zone with fewer approved
// leads than its share hand its unused portion to the others.
//
// WHY RECOMPUTE EVERY TICK, NOT PERSIST A PLAN: a zone's own approved pile
// changes as drafts get approved/denied, and its demand naturally drops to 0
// once its window closes for the day (see zoneDemand below) — the unused
// share of a closed zone then flows to whichever zones still have demand,
// with no separate "release" step needed. Cheap to compute (a handful of
// integers), so recomputing from the current DB snapshot each tick is
// simpler and can't drift from a stored plan.

import type { WindowPhase } from "./sendWindow";

export type ZoneDay = {
  zone: string; // an IANA tz string, e.g. "America/Los_Angeles" — the grouping key
  phase: WindowPhase;
  pending: number; // approved, unsent touch1 rows for this zone right now
  sent: number; // touch1 (not bump) sent today, this zone
};

// What a zone could still use out of today's cap: what it's already claimed
// (sent) plus what it still might send, but pending only counts while the
// zone's window hasn't already closed for the day — a zone that's done for
// today can't accept more, so it must not compete for any of what's left.
// `not_today` (weekend) and `closed` zones contribute only their `sent`
// (normally 0, since nothing should have sent there today either).
function zoneDemand(z: ZoneDay): number {
  const pendingCounts = z.phase === "before" || z.phase === "open";
  return z.sent + (pendingCounts ? z.pending : 0);
}

// Max-min water-filling: split `cap` across `demands` so no zone gets more
// than it can use, and unused capacity from a low-demand zone flows to the
// others. Ties (when the cap doesn't divide evenly) are broken by giving the
// +1 remainder to zones in `rotation`-shifted order, so which zone gets the
// odd slot changes day to day instead of always favoring the same one.
// Exported only for the allocator functions below to share; not part of the
// public API since it works on bare arrays, not ZoneDay.
function waterFill(cap: number, demands: number[], rotation: number): number[] {
  const n = demands.length;
  const alloc = new Array(n).fill(0);
  if (cap <= 0 || n === 0) return alloc;

  let remainingCap = cap;
  let active = demands.map((d, i) => i).filter((i) => demands[i]! > 0);
  const remaining = [...demands];

  while (remainingCap > 0 && active.length > 0) {
    const share = Math.floor(remainingCap / active.length);
    if (share > 0) {
      // Anyone whose demand fits inside an equal share is fully satisfied and
      // drops out, freeing their unused portion for the rest.
      const satisfied = active.filter((i) => remaining[i]! <= share);
      if (satisfied.length > 0) {
        for (const i of satisfied) {
          alloc[i] += remaining[i]!;
          remainingCap -= remaining[i]!;
          remaining[i] = 0;
        }
        active = active.filter((i) => remaining[i]! > 0);
        continue;
      }
      // Nobody left can be fully satisfied at this share — everyone still
      // active gets the same base share, then fall through to hand out
      // whatever's left over (< active.length, by definition of floor) one
      // at a time below.
      for (const i of active) {
        alloc[i] += share;
        remaining[i]! -= share;
      }
      remainingCap -= share * active.length;
    }
    // remainingCap is now < active.length (either it started that way, or
    // the base-share pass just made it so) — distribute the odd remainder
    // one slot each, rotation-ordered, only to zones that can still use one.
    if (remainingCap > 0) {
      for (let k = 0; k < remainingCap; k++) {
        const i = active[(rotation + k) % active.length]!;
        alloc[i] += 1;
      }
    }
    break;
  }
  return alloc;
}

// Today's target total (sent + still-to-send) for each zone, out of `cap`.
// `rotation` should change by exactly 1 each calendar day (e.g. a day
// index) so the odd remainder slot rotates through zones over time rather
// than always landing on the same one.
export function zoneQuotas(cap: number, zones: ZoneDay[], rotation: number): Map<string, number> {
  const demands = zones.map(zoneDemand);
  const alloc = waterFill(cap, demands, rotation);
  return new Map(zones.map((z, i) => [z.zone, alloc[i]!]));
}

// How much of `cap` is spoken for by Touch 1 today, across all zones — what
// the bump sender must leave untouched. Bounded by `cap` itself (unlike the
// bug this replaces, which reserved EVERY approved-pending touch1 regardless
// of the cap — 15 pending against a cap of 5 reserved all 5, every day,
// leaving bumps 0 forever even though only ~2 of those 15 could actually
// send today).
export function touch1ReservedToday(zones: ZoneDay[], cap: number, rotation: number): number {
  const quotas = zoneQuotas(cap, zones, rotation);
  return zones.reduce((sum, z) => sum + Math.max(0, (quotas.get(z.zone) ?? 0) - z.sent), 0);
}

// Selects which approved, in-window Touch 1 rows to send this tick: each
// zone gets at most its remaining quota (target minus already sent today),
// the whole selection is capped at `perTick`, and within those limits rows
// are taken in the given order (oldest-approved-first) — so a zone's own
// rows still send oldest-first, and a zone below its quota doesn't block
// rows from a different zone later in the list.
export function pickTouch1<T extends { zone: string }>(
  inWindowOldestFirst: T[],
  zones: ZoneDay[],
  o: { cap: number; perTick: number; rotation: number }
): T[] {
  const quotas = zoneQuotas(o.cap, zones, o.rotation);
  const sentByZone = new Map(zones.map((z) => [z.zone, z.sent]));
  const remainingByZone = new Map(
    zones.map((z) => [z.zone, Math.max(0, (quotas.get(z.zone) ?? 0) - (sentByZone.get(z.zone) ?? 0))])
  );

  const out: T[] = [];
  for (const item of inWindowOldestFirst) {
    if (out.length >= o.perTick) break;
    const rem = remainingByZone.get(item.zone) ?? 0;
    if (rem <= 0) continue; // this zone already has its quota for today
    out.push(item);
    remainingByZone.set(item.zone, rem - 1);
  }
  return out;
}
