import Link from "next/link";
import { getAllSettings } from "@/lib/settings";
import { pickAssumptions } from "@/lib/costs";
import {
  resolveRange,
  getPnl,
  getMonthlySeries,
  getVentureSummary,
  RANGE_OPTIONS,
  type VentureFinancials,
  type MonthRow,
} from "@/lib/financeStats";
import { KpiCard, ConsoleCard, money, fmtDate } from "../ui";

// Company-wide roll-up across every venture. Unlike the photo tab, app/admin's
// layout renders NO page heading, so this page renders its own eyebrow + h1.
export const dynamic = "force-dynamic";

// The not-yet-live ventures, mirrored from the Sidebar. They contribute nothing
// until they export their own getVentureSummary — then they join `ventures` below
// with no other change to this page.
const NOT_LIVE: VentureFinancials[] = [
  { slug: "hvac", name: "HVAC Appt. Setter", accent: "#2F7A6F", live: false, grossCents: 0, feeCents: 0, refundedCents: 0, netRevenueCents: 0, variableCostCents: 0, contributionCents: 0, payingClients: 0, costLines: [] },
  { slug: "analytics", name: "SMB Analytics", accent: "#6B5CA5", live: false, grossCents: 0, feeCents: 0, refundedCents: 0, netRevenueCents: 0, variableCostCents: 0, contributionCents: 0, payingClients: 0, costLines: [] },
  { slug: "realestate", name: "RE Listing Videos", accent: "#C1583F", live: false, grossCents: 0, feeCents: 0, refundedCents: 0, netRevenueCents: 0, variableCostCents: 0, contributionCents: 0, payingClients: 0, costLines: [] },
];

async function loadCompany(sp: Record<string, string | string[] | undefined>) {
  const range = resolveRange(sp);
  const settings = await getAllSettings();
  const a = pickAssumptions(settings.values);
  const [photo, pnl, monthly] = await Promise.all([
    getVentureSummary(range, a),
    getPnl(range, a),
    getMonthlySeries(range, a),
  ]);
  const ventures = [photo, ...NOT_LIVE];
  return { range, ventures, pnl, monthly };
}

export default async function CompanyFinancialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { range, ventures, pnl, monthly } = await loadCompany(sp);

  return (
    <div>
      <div className="mb-6">
        <div className="font-mono-label text-[11px] uppercase tracking-wider" style={{ color: "var(--c-text-muted)" }}>
          All products · {range.label}
        </div>
        <h1 className="font-display text-[22px] font-bold tracking-tight" style={{ color: "var(--c-text)" }}>
          Financials
        </h1>
        <p className="mt-1 max-w-xl text-sm" style={{ color: "var(--c-text-muted)" }}>
          Company P&amp;L across every venture. Revenue is real; costs are modelled estimates. Only Photo Enhancement is
          live, so it carries the totals — and all company overhead is allocated to it for now.
        </p>
      </div>

      {/* Date range — preset dropdown and a separate custom from/to form. The
          custom form omits `range`, so resolveRange (which gives explicit dates
          precedence) uses the dates; the preset form omits from/to, so it clears
          any custom window. */}
      <div className="mb-6 flex flex-col gap-3">
        <form method="GET" className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="range" className="text-xs font-medium" style={{ color: "var(--c-text-muted)" }}>
              Period
            </label>
            <select id="range" name="range" defaultValue={range.key === "custom" ? "" : range.key} className="rounded-lg border bg-surface-2 px-3 py-1.5 text-sm text-text" style={{ borderColor: "var(--line)" }}>
              {RANGE_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
              {range.key === "custom" && <option value="">Custom (below)</option>}
            </select>
          </div>
          <button type="submit" className="btn-press rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-[#0F1216] hover:brightness-110">
            Apply
          </button>
          <span className="pb-1.5 text-xs" style={{ color: "var(--c-text-faint)" }}>
            {fmtDate(range.from)} → {fmtDate(range.to)} · {range.days} days
          </span>
        </form>
        <form method="GET" className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="from" className="text-xs font-medium" style={{ color: "var(--c-text-muted)" }}>From</label>
            <input type="date" id="from" name="from" defaultValue={range.fromInput ?? ""} className="rounded-lg border bg-surface-2 px-3 py-1.5 text-sm text-text" style={{ borderColor: "var(--line)" }} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="to" className="text-xs font-medium" style={{ color: "var(--c-text-muted)" }}>To</label>
            <input type="date" id="to" name="to" defaultValue={range.toInput ?? ""} className="rounded-lg border bg-surface-2 px-3 py-1.5 text-sm text-text" style={{ borderColor: "var(--line)" }} />
          </div>
          <button type="submit" className="btn-press rounded-lg border px-4 py-2 text-sm font-semibold text-text hover:bg-surface-2" style={{ borderColor: "var(--line)" }}>
            Apply dates
          </button>
          {range.key === "custom" && (
            <span className="pb-1.5 text-xs font-medium" style={{ color: "var(--c-accent, #b45309)" }}>Custom range active</span>
          )}
        </form>
      </div>

      {/* Company KPIs */}
      <div className="mb-6 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <KpiCard label="Gross revenue" value={money(pnl.grossCents)} />
        <KpiCard label="Net revenue" value={money(pnl.netRevenueCents)} />
        <KpiCard label="Est. profit" value={signed(pnl.estimatedProfitCents)} />
        <KpiCard label="Paying clients" value={ventures[0].payingClients} />
      </div>

      {/* By venture */}
      <div className="mb-6 font-display text-sm font-semibold" style={{ color: "var(--c-text)" }}>By venture</div>
      <ConsoleCard>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide" style={{ borderColor: "var(--line)", color: "var(--c-text-muted)" }}>
                <th scope="col" className="px-5 py-2 font-semibold">Venture</th>
                <th scope="col" className="px-5 py-2 font-semibold">Gross</th>
                <th scope="col" className="px-5 py-2 font-semibold">Net rev</th>
                <th scope="col" className="px-5 py-2 font-semibold">Variable cost</th>
                <th scope="col" className="px-5 py-2 font-semibold">Contribution</th>
                <th scope="col" className="px-5 py-2 font-semibold">Clients</th>
              </tr>
            </thead>
            <tbody>
              {ventures.map((v) => (
                <tr key={v.slug} className="border-b" style={{ borderColor: "var(--line)" }}>
                  <td className="px-5 py-2">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: v.live ? v.accent : "rgba(0,0,0,0.15)" }} />
                      {v.live ? (
                        <Link href={`/admin/${v.slug}/financials`} className="font-medium hover:underline" style={{ color: "var(--c-text)" }}>
                          {v.name}
                        </Link>
                      ) : (
                        <span style={{ color: "var(--c-text-muted)" }}>{v.name}</span>
                      )}
                      {!v.live && <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--c-text-faint)" }}>not live</span>}
                    </span>
                  </td>
                  <td className="px-5 py-2 tabular-nums">{money(v.grossCents)}</td>
                  <td className="px-5 py-2 tabular-nums">{money(v.netRevenueCents)}</td>
                  <td className="px-5 py-2 tabular-nums" style={{ color: "var(--c-text-muted)" }}>{money(v.variableCostCents)}</td>
                  <td className="px-5 py-2 tabular-nums" style={{ color: v.contributionCents < 0 ? "var(--coral)" : "var(--c-text)" }}>
                    {signed(v.contributionCents)}
                  </td>
                  <td className="px-5 py-2 tabular-nums">{v.payingClients}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ConsoleCard>

      {/* Consolidated P&L */}
      <div className="mb-3 mt-8 font-display text-sm font-semibold" style={{ color: "var(--c-text)" }}>Consolidated P&amp;L</div>
      <ConsoleCard>
        <table className="w-full border-collapse text-sm">
          <tbody>
            <CoRow label="Net revenue" cents={pnl.netRevenueCents} strong />
            <CoRow label="Variable costs (modelled)" cents={-pnl.variableCostCents} muted />
            <CoRow label="Contribution margin" cents={pnl.contributionCents} strong divide />
            <CoRow label="Company overhead (100% → Photo for now)" cents={-pnl.fixedOpexCents} muted />
            <CoRow label="Estimated company profit" cents={pnl.estimatedProfitCents} strong divide />
          </tbody>
        </table>
      </ConsoleCard>

      {/* Where the money comes from */}
      <div className="mb-3 mt-8 font-display text-sm font-semibold" style={{ color: "var(--c-text)" }}>Where the money comes from</div>
      <div className="mb-6 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <KpiCard label="Package sales" value={money(pnl.packageGrossCents)} delta={{ text: pct(pnl.packageGrossCents, pnl.grossCents), dir: "flat" }} />
        <KpiCard label="Self-serve" value={money(pnl.selfServeGrossCents)} delta={{ text: pct(pnl.selfServeGrossCents, pnl.grossCents), dir: "flat" }} />
      </div>

      {/* Cash in by month */}
      <div className="mb-3 mt-8 font-display text-sm font-semibold" style={{ color: "var(--c-text)" }}>Cash in by month</div>
      <CashBars rows={monthly} />

      <p className="mt-8 text-xs" style={{ color: "var(--c-text-faint)" }}>
        Full P&amp;L, client economics, and the editable cost assumptions live on the{" "}
        <Link href="/admin/photo/financials" className="underline">Photo Enhancement financials</Link>.
      </p>
    </div>
  );
}

function signed(cents: number): string {
  return cents < 0 ? `−${money(Math.abs(cents))}` : money(cents);
}
function pct(part: number, whole: number): string {
  if (whole === 0) return "—";
  return `${((part / whole) * 100).toFixed(0)}% of gross`;
}

function CoRow({ label, cents, strong, muted, divide }: { label: string; cents: number; strong?: boolean; muted?: boolean; divide?: boolean }) {
  return (
    <tr className={divide ? "border-t" : ""} style={divide ? { borderColor: "var(--line)" } : undefined}>
      <td className={`px-5 py-2 ${strong ? "font-semibold" : ""}`} style={{ color: muted ? "var(--c-text-muted)" : "var(--c-text)" }}>
        {label}
      </td>
      <td className={`px-5 py-2 text-right tabular-nums ${strong ? "font-semibold" : ""}`} style={{ color: cents < 0 ? "var(--coral)" : "var(--c-text)" }}>
        {signed(cents)}
      </td>
    </tr>
  );
}

function CashBars({ rows }: { rows: MonthRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.grossCents));
  const hasData = rows.some((r) => r.grossCents > 0);
  if (!hasData) {
    return (
      <p className="text-sm" style={{ color: "var(--c-text-muted)" }}>
        No revenue in this period yet.
      </p>
    );
  }
  return (
    <ConsoleCard>
      <div className="flex flex-col gap-2.5 p-5">
        {rows.map((r) => (
          <div key={r.month} className="flex items-center gap-3">
            <div className="w-16 shrink-0 text-xs tabular-nums" style={{ color: "var(--c-text-muted)" }}>
              {r.month}
            </div>
            <div className="h-3.5 flex-1 overflow-hidden rounded" style={{ background: "var(--paper)" }}>
              <div className="h-full rounded" style={{ width: `${Math.max(r.grossCents > 0 ? 2 : 0, (r.grossCents / max) * 100)}%`, background: "var(--accent)" }} />
            </div>
            <span className="w-20 shrink-0 text-right text-[11px] tabular-nums" style={{ color: "var(--c-text-faint)" }}>
              {money(r.grossCents)}
            </span>
          </div>
        ))}
      </div>
    </ConsoleCard>
  );
}
