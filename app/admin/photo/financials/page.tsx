import Link from "next/link";
import { getAllSettings, type OpexItem } from "@/lib/settings";
import { isOneTime, opexMonthlyCents, pickAssumptions, type CostKey, type CostLine } from "@/lib/costs";
import {
  resolveRange,
  getPnl,
  getMonthlySeries,
  getClientEconomics,
  getUnattributed,
  getCityEconomics,
  getPayingClientCount,
  rollUpSegments,
  RANGE_OPTIONS,
  rangeParams,
  type Range,
  type Pnl,
  type MonthRow,
  type ClientRow,
  type SegmentRow,
  type CityRow,
  type SelfServeRow,
} from "@/lib/financeStats";
import { getFunnel } from "@/lib/photoStats";
import { KpiCard, ConsoleCard, Funnel, Pill, Pager, money, fmtDate, relTime, SectionHeading, type PillTone } from "../../ui";
import { NumberSetting } from "../controls/ControlToggles";

// Live P&L + client economics for the Photo venture. Every cost figure is a
// MODELLED estimate (see lib/costs.ts). The layout renders the eyebrow + H1 +
// subnav, so this page starts at its first section — no <h1> here.
export const dynamic = "force-dynamic";

const CLIENTS_PER_PAGE = 25;

type SortKey = "contribution" | "revenue" | "spend" | "margin";

// Editor metadata for the assumptions panel (keyed by the settings map). These
// are the per-event unit costs only — fixed subscriptions are itemized in
// opex_items and rendered by <FixedOpexBreakdown> instead.
const COST_EDITORS: { key: CostKey; label: string; help: string; suffix: string; step: string }[] = [
  { key: "cost_source_per_lead_cents", label: "Lead sourcing", help: "Google Places Text Search, amortized per surviving lead.", suffix: "¢ / lead", step: "0.1" },
  { key: "cost_enrich_per_lead_cents", label: "Enrichment", help: "0 while the chain-check is off and NeverBounce is a fixed subscription (see Fixed opex).", suffix: "¢ / lead", step: "0.1" },
  { key: "cost_photo_score_per_photo_cents", label: "Photo scoring", help: "Places Photo fetch + Claude Vision, per scored photo.", suffix: "¢ / photo", step: "0.1" },
  { key: "cost_email_per_send_cents", label: "Cold email", help: "Gmail is free; set if you move to a paid ESP.", suffix: "¢ / send", step: "0.1" },
  { key: "cost_sample_per_reply_cents", label: "Free sample", help: "Revenue-impact copy + the optional Claid first pass, per reply.", suffix: "¢ / reply", step: "1" },
  { key: "cost_claid_per_photo_cents", label: "Claid production", help: "AI-Edit + upscale per photo. Include typical retry waste.", suffix: "¢ / photo", step: "0.5" },
  { key: "cost_storage_per_photo_cents", label: "Storage", help: "R2 + egress, charged once per delivered photo.", suffix: "¢ / photo", step: "0.1" },
];

async function loadFinancials(sp: Record<string, string | string[] | undefined>) {
  const range = resolveRange(sp);
  const settings = await getAllSettings();
  const a = pickAssumptions(settings.values);

  const [pnl, monthly, allClients, unattributed, cities, newPayers, funnel] = await Promise.all([
    getPnl(range, a),
    getMonthlySeries(range, a),
    getClientEconomics(a),
    getUnattributed(range),
    getCityEconomics(a),
    getPayingClientCount(range.from, range.to),
    getFunnel(),
  ]);

  const segments = rollUpSegments(allClients);

  // Sort + paginate the client table (GET-driven, no client JS).
  const sort: SortKey = (["contribution", "revenue", "spend", "margin"] as const).includes(sp.sort as SortKey)
    ? (sp.sort as SortKey)
    : "contribution";
  const sorted = [...allClients].sort((x, y) => {
    if (sort === "revenue") return y.netRevenueCents - x.netRevenueCents;
    if (sort === "spend") return y.acquireCents + y.serveCents - (x.acquireCents + x.serveCents);
    if (sort === "margin") return (y.marginPct ?? -Infinity) - (x.marginPct ?? -Infinity);
    return y.contributionCents - x.contributionCents;
  });
  const page = Math.max(1, Number(sp.page) || 1);
  const pageRows = sorted.slice((page - 1) * CLIENTS_PER_PAGE, page * CLIENTS_PER_PAGE);
  const hasNext = sorted.length > page * CLIENTS_PER_PAGE;

  // Unit economics.
  const directCacCents =
    allClients.length > 0 ? Math.round(allClients.reduce((s, c) => s + c.acquireCents, 0) / allClients.length) : 0;
  const blendedCacCents = newPayers > 0 ? Math.round(pnl.acquireCents / newPayers) : null;
  const revPerClientCents = newPayers > 0 ? Math.round(pnl.netRevenueCents / newPayers) : null;
  const returnMultiple = pnl.variableCostCents > 0 ? pnl.netRevenueCents / pnl.variableCostCents : null;

  const nowMs = Date.now();
  return {
    range,
    settings,
    pnl,
    monthly,
    segments,
    clients: pageRows,
    totalClients: allClients.length,
    page,
    hasNext,
    sort,
    unattributed,
    cities,
    newPayers,
    directCacCents,
    blendedCacCents,
    revPerClientCents,
    returnMultiple,
    funnel,
    nowMs,
  };
}

export default async function PhotoFinancialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const d = await loadFinancials(sp);
  const { range, pnl } = d;

  return (
    <div className="flex flex-col gap-10">
      {/* 1 — Date range */}
      <RangeForm range={range} />

      {/* 2 — KPI row */}
      <section>
        <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
          <KpiCard label="Gross revenue" value={money(pnl.grossCents)} delta={delta(pnl.grossCents, pnl.prev.grossCents)} />
          <KpiCard label="Stripe fees" value={money(pnl.feeCents)} delta={{ text: feeRateLabel(pnl), dir: "flat" }} />
          <KpiCard label="Net revenue" value={money(pnl.netRevenueCents)} delta={delta(pnl.netRevenueCents, pnl.prev.netRevenueCents)} />
          <KpiCard
            label="Est. profit"
            value={signed(pnl.estimatedProfitCents)}
            delta={delta(pnl.estimatedProfitCents, pnl.prev.estimatedProfitCents)}
          />
        </div>
        <p className="mt-2 text-xs" style={{ color: "var(--c-text-faint)" }}>
          Revenue is real (from the payments ledger). Every cost line is a modelled estimate — see “Cost assumptions” below.
        </p>
      </section>

      {/* 2.5 — Outreach → revenue funnel. Fixed 30-day window (getFunnel is not
          range-aware), so it's labelled as such rather than following the picker
          above — it answers "how does a sent cold email turn into a sale?". */}
      <section>
        <SectionHeading>Outreach conversion · last 30 days</SectionHeading>
        {d.funnel.sentCount === 0 ? (
          <p className="mt-3 text-sm" style={{ color: "var(--c-text-muted)" }}>
            No Touch 1 sent in the last 30 days — this fills in once outreach is live.
          </p>
        ) : (
          <div className="mt-3">
            <Funnel steps={d.funnel.steps} />
          </div>
        )}
      </section>

      {/* 3 — Profit & loss, then what the single "Fixed opex" line is made of */}
      <PnlTable pnl={pnl} rangeDays={range.days} />
      <div className="mt-4">
        <FixedOpexBreakdown items={d.settings.values.opex_items} rangeDays={d.range.days} />
      </div>

      {/* 4 — Revenue vs cost by month */}
      <MonthlyBars rows={d.monthly} />

      {/* 5 — Unit economics */}
      <section>
        <SectionHeading>Unit economics</SectionHeading>
        <div className="mt-3 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
          <KpiCard label="Blended CAC" value={d.blendedCacCents == null ? "—" : money(d.blendedCacCents)} delta={{ text: `${d.newPayers} new payers in range`, dir: "flat" }} />
          <KpiCard label="Direct CAC" value={money(d.directCacCents)} delta={{ text: "per-client acquire, lifetime", dir: "flat" }} />
          <KpiCard label="Net rev / client" value={d.revPerClientCents == null ? "—" : money(d.revPerClientCents)} />
          <KpiCard label="Return multiple" value={d.returnMultiple == null ? "—" : `${d.returnMultiple.toFixed(1)}×`} delta={{ text: "net rev ÷ variable cost", dir: "flat" }} />
        </div>
        <p className="mt-2 text-xs" style={{ color: "var(--c-text-faint)" }}>
          Blended CAC counts every lead chased; direct CAC counts only paying clients. With few payers, blended is the honest number.
        </p>
      </section>

      {/* 6 — Clients worth it */}
      <ClientsTable d={d} />

      {/* 7 — Segments */}
      <section>
        <SectionHeading>Segments</SectionHeading>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <SegmentTable title="By package" rows={d.segments.byPackage} />
          <SegmentTable title="Repeat vs one-time" rows={d.segments.byRepeat} />
          <SegmentTable title="New opening vs established" rows={d.segments.byOpening} />
          <CityTable rows={d.cities} />
        </div>
      </section>

      {/* 8 — Self-serve (unattributed) */}
      <UnattributedTable rows={d.unattributed} nowMs={d.nowMs} />

      {/* 9 — Assumptions editor */}
      <section>
        <details>
          <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-muted">
            Cost assumptions (edit)
          </summary>
          <p className="mt-3 text-xs" style={{ color: "var(--c-text-muted)" }}>
            All values in cents. Calibrate each against the matching monthly invoice — these drive every cost line above.
            (Behaviour toggles live on <Link href="/admin/photo/controls" className="underline">Controls</Link>.)
          </p>
          <div className="mt-3 flex flex-col gap-3">
            {COST_EDITORS.map((e) => (
              <NumberSetting
                key={e.key}
                settingKey={e.key}
                label={e.label}
                help={e.help}
                value={d.settings.values[e.key]}
                nullable={false}
                suffix={e.suffix}
                step={e.step}
                min={0}
              />
            ))}
            {d.settings.updatedAt.cost_claid_per_photo_cents && (
              <p className="text-xs" style={{ color: "var(--c-text-faint)" }}>
                Last edited {relTime(d.settings.updatedAt.cost_claid_per_photo_cents, d.nowMs)}.
              </p>
            )}
          </div>
        </details>
      </section>

      {/* 10 — Blind spots */}
      <BlindSpots />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure — no Date construction in component bodies)
// ---------------------------------------------------------------------------

function signed(cents: number): string {
  return cents < 0 ? `−${money(Math.abs(cents))}` : money(cents);
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function fmtUnit(unitCents: number): string {
  return `${unitCents.toFixed(unitCents % 1 === 0 ? 0 : 2)}¢`;
}

function delta(cur: number, prev: number): { text: string; dir: "up" | "down" | "flat" } {
  if (prev === 0) return { text: "no prior period", dir: "flat" };
  const change = ((cur - prev) / Math.abs(prev)) * 100;
  const dir = change > 0.5 ? "up" : change < -0.5 ? "down" : "flat";
  return { text: `${change >= 0 ? "+" : ""}${change.toFixed(0)}% vs prev`, dir };
}

function feeRateLabel(pnl: Pnl): string {
  if (pnl.actualFeeRate == null) return "no Stripe fees yet";
  return `${(pnl.actualFeeRate * 100).toFixed(2)}% actual`;
}

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

function RangeForm({ range }: { range: Range }) {
  const isCustom = range.key === "custom";
  return (
    <section className="flex flex-col gap-3">
      {/* Preset picker. Submitting this form sends `range` only, so a preset
          clears any custom from/to (this form has no date fields). */}
      <form method="GET" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="range" className="text-xs font-medium" style={{ color: "var(--c-text-muted)" }}>
            Period
          </label>
          <select
            id="range"
            name="range"
            defaultValue={isCustom ? "" : range.key}
            className="rounded-lg border bg-surface-2 px-3 py-1.5 text-sm text-text"
            style={{ borderColor: "var(--line)" }}
          >
            {RANGE_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
            {isCustom && <option value="">Custom (below)</option>}
          </select>
        </div>
        <button
          type="submit"
          className="btn-press rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-[#0F1216] hover:brightness-110"
        >
          Apply
        </button>
        <span className="pb-1.5 text-xs" style={{ color: "var(--c-text-faint)" }}>
          {fmtDate(range.from)} → {fmtDate(range.to)} · {range.days} days
        </span>
      </form>

      {/* Custom range. A separate form so submitting it sends from/to WITHOUT a
          `range` param — resolveRange gives explicit dates precedence, so the
          preset above is ignored while a custom range is active. Either date may
          be left blank (open start = all history, open end = today). */}
      <form method="GET" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="from" className="text-xs font-medium" style={{ color: "var(--c-text-muted)" }}>
            From
          </label>
          <input
            type="date"
            id="from"
            name="from"
            defaultValue={range.fromInput ?? ""}
            className="rounded-lg border bg-surface-2 px-3 py-1.5 text-sm text-text"
            style={{ borderColor: "var(--line)" }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="to" className="text-xs font-medium" style={{ color: "var(--c-text-muted)" }}>
            To
          </label>
          <input
            type="date"
            id="to"
            name="to"
            defaultValue={range.toInput ?? ""}
            className="rounded-lg border bg-surface-2 px-3 py-1.5 text-sm text-text"
            style={{ borderColor: "var(--line)" }}
          />
        </div>
        <button
          type="submit"
          className="btn-press rounded-lg border px-4 py-2 text-sm font-semibold text-text hover:bg-surface-2"
          style={{ borderColor: "var(--line)" }}
        >
          Apply dates
        </button>
        {isCustom && (
          <span className="pb-1.5 text-xs font-medium" style={{ color: "var(--gold)" }}>
            Custom range active
          </span>
        )}
      </form>
    </section>
  );
}

function PnlTable({ pnl, rangeDays }: { pnl: Pnl; rangeDays: number }) {
  const gross = pnl.grossCents;
  return (
    <section>
      <SectionHeading>Profit &amp; loss</SectionHeading>
      <ConsoleCard>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-sm">
            <tbody>
              <PnlLine label="Gross revenue" cents={gross} gross={gross} strong />
              <PnlLine label="Refunds" cents={-pnl.refundedCents} gross={gross} muted />
              <PnlLine label="Stripe fees" cents={-pnl.feeCents} gross={gross} muted />
              <PnlLine label="Net revenue" cents={pnl.netRevenueCents} gross={gross} strong divide />
              {pnl.costLines.map((l) => (
                <CostRow key={l.key} line={l} gross={gross} />
              ))}
              <PnlLine label="Contribution margin" cents={pnl.contributionCents} gross={gross} strong divide />
              <PnlLine label={`Fixed opex (${rangeDays}d apportioned)`} cents={-pnl.fixedOpexCents} gross={gross} muted est />
              <PnlLine label="Estimated profit" cents={pnl.estimatedProfitCents} gross={gross} strong divide />
            </tbody>
          </table>
        </div>
      </ConsoleCard>

    </section>
  );
}

// Fixed monthly subscriptions, itemized. The P&L only ever shows the
// apportioned total, which says nothing about WHERE the money goes — this
// breaks it out per vendor with a proportional bar so an outsized line is
// obvious at a glance. Total is derived from the items (opexMonthlyCents), so
// it can't drift from what's listed.
function FixedOpexBreakdown({ items, rangeDays }: { items: OpexItem[]; rangeDays: number }) {
  const monthly = opexMonthlyCents(items); // recurring only
  const apportioned = Math.round((monthly / 30.4375) * rangeDays);
  // Sort largest-first so the bar chart reads top-down by weight. One-time
  // setup fees are listed separately — they aren't part of the monthly run rate.
  const recurring = items.filter((i) => !isOneTime(i)).sort((a, b) => b.cents - a.cents);
  const oneTime = items.filter(isOneTime).sort((a, b) => b.cents - a.cents);

  return (
    <ConsoleCard>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-text">Fixed monthly opex</h3>
        <div className="text-sm tabular-nums text-muted">
          <span className="font-semibold text-text">{money(monthly)}</span> / month
          <span className="mx-1.5 text-faint">·</span>
          {money(apportioned)} over {rangeDays}d
        </div>
      </div>
      <p className="mt-1 text-xs text-muted">
        Recurring subscriptions only. Usage-based spend (Anthropic, Google Places) is priced per
        event in the assumptions above, not here.
      </p>

      {recurring.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No fixed subscriptions configured.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {recurring.map((item) => {
            const pct = monthly > 0 ? (item.cents / monthly) * 100 : 0;
            return (
              <li key={item.label}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium text-text">{item.label}</span>
                  <span className="tabular-nums text-muted">
                    {money(item.cents)}
                    <span className="ml-1.5 text-xs text-faint">{pct.toFixed(0)}%</span>
                  </span>
                </div>
                {/* Proportional bar — width is the share of total monthly opex. */}
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full bg-gold" style={{ width: `${pct}%` }} />
                </div>
                {item.note && <p className="mt-1 text-xs text-muted">{item.note}</p>}
              </li>
            );
          })}
        </ul>
      )}

      {/* One-time setup fees: charged once, in the month they were incurred —
          deliberately outside the monthly run rate above so they don't read as
          recurring. They still hit the P&L, but only in that month's window. */}
      {oneTime.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
            One-time setup (not in the monthly rate)
          </h4>
          <ul className="mt-2 flex flex-col gap-2">
            {oneTime.map((item) => (
              <li key={item.label} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-text">
                  {item.label}
                  {item.note && <span className="ml-1.5 text-xs text-muted">· {item.note}</span>}
                </span>
                <span className="tabular-nums text-muted">
                  {money(item.cents)}
                  <span className="ml-1.5 text-xs text-faint">{item.oneTimeOn}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ConsoleCard>
  );
}

function PnlLine({
  label,
  cents,
  gross,
  strong,
  muted,
  divide,
  est,
}: {
  label: string;
  cents: number;
  gross: number;
  strong?: boolean;
  muted?: boolean;
  divide?: boolean;
  est?: boolean;
}) {
  return (
    <tr className={divide ? "border-t" : ""} style={divide ? { borderColor: "var(--line)" } : undefined}>
      <td className={`px-5 py-2 ${strong ? "font-semibold" : ""}`} style={{ color: muted ? "var(--c-text-muted)" : "var(--c-text)" }}>
        {label}
        {est && <span className="ml-1.5 text-[10px] uppercase tracking-wide" style={{ color: "var(--c-text-faint)" }}>est.</span>}
      </td>
      <td className={`px-5 py-2 text-right tabular-nums ${strong ? "font-semibold" : ""}`} style={{ color: cents < 0 ? "var(--coral)" : "var(--c-text)" }}>
        {signed(cents)}
      </td>
      <td className="px-5 py-2 text-right text-xs tabular-nums" style={{ color: "var(--c-text-faint)" }}>
        {pct(Math.abs(cents), gross)}
      </td>
    </tr>
  );
}

function CostRow({ line, gross }: { line: CostLine; gross: number }) {
  return (
    <tr>
      <td className="px-5 py-2" style={{ color: "var(--c-text-muted)" }}>
        {line.label}
        <span className="ml-1.5 text-[10px] uppercase tracking-wide" style={{ color: "var(--c-text-faint)" }}>est.</span>
        <span className="ml-2 text-xs" style={{ color: "var(--c-text-faint)" }}>
          {line.count.toLocaleString("en-US")} {line.unitLabel} × {fmtUnit(line.unitCents)}
        </span>
      </td>
      <td className="px-5 py-2 text-right tabular-nums" style={{ color: line.totalCents > 0 ? "var(--coral)" : "var(--c-text-faint)" }}>
        {line.totalCents > 0 ? `−${money(line.totalCents)}` : money(0)}
      </td>
      <td className="px-5 py-2 text-right text-xs tabular-nums" style={{ color: "var(--c-text-faint)" }}>
        {pct(line.totalCents, gross)}
      </td>
    </tr>
  );
}

function MonthlyBars({ rows }: { rows: MonthRow[] }) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.grossCents, r.costCents)));
  const hasData = rows.some((r) => r.grossCents > 0 || r.costCents > 0);
  return (
    <section>
      <SectionHeading>Revenue vs cost by month</SectionHeading>
      {!hasData ? (
        <p className="mt-3 text-sm" style={{ color: "var(--c-text-muted)" }}>
          No activity in this period yet.
        </p>
      ) : (
        <ConsoleCard>
          <div className="flex flex-col gap-3 p-5">
            {rows.map((r) => (
              <div key={r.month} className="flex items-center gap-3">
                <div className="w-16 shrink-0 text-xs tabular-nums" style={{ color: "var(--c-text-muted)" }}>
                  {r.month}
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <Bar cents={r.grossCents} max={max} color="var(--accent)" label={`Rev ${money(r.grossCents)}`} />
                  <Bar cents={r.costCents} max={max} color="var(--coral)" label={`Cost ${money(r.costCents)}`} />
                </div>
              </div>
            ))}
          </div>
        </ConsoleCard>
      )}
    </section>
  );
}

function Bar({ cents, max, color, label }: { cents: number; max: number; color: string; label: string }) {
  const width = Math.max(cents > 0 ? 2 : 0, (cents / max) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-3.5 flex-1 overflow-hidden rounded" style={{ background: "var(--paper)" }}>
        <div className="h-full rounded" style={{ width: `${width}%`, background: color }} />
      </div>
      <span className="w-28 shrink-0 text-right text-[11px] tabular-nums" style={{ color: "var(--c-text-faint)" }}>
        {label}
      </span>
    </div>
  );
}

const VERDICT_TONE: Record<ClientRow["verdict"], { tone: PillTone; label: string }> = {
  worth_it: { tone: "teal", label: "worth it" },
  thin: { tone: "gold", label: "thin" },
  underwater: { tone: "coral", label: "underwater" },
};

function ClientsTable({ d }: { d: Awaited<ReturnType<typeof loadFinancials>> }) {
  const sortHref = (s: SortKey) => {
    const qs = new URLSearchParams({ ...rangeParams(d.range), sort: s });
    return `/admin/photo/financials?${qs.toString()}`;
  };
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionHeading>Clients worth it ({d.totalClients})</SectionHeading>
        <div className="flex gap-2 text-xs" style={{ color: "var(--c-text-muted)" }}>
          Sort:
          {(["contribution", "revenue", "spend", "margin"] as const).map((s) => (
            <Link key={s} href={sortHref(s)} className={d.sort === s ? "font-semibold underline" : "hover:underline"}>
              {s}
            </Link>
          ))}
        </div>
      </div>
      <p className="mt-1 text-xs" style={{ color: "var(--c-text-faint)" }}>
        Lifetime revenue vs lifetime cost to acquire + serve — “worth it” is a lifetime question.
      </p>
      {d.clients.length === 0 ? (
        <p className="mt-3 text-sm" style={{ color: "var(--c-text-muted)" }}>
          No paying clients attributed to a restaurant yet.
        </p>
      ) : (
        <ConsoleCard>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide" style={{ borderColor: "var(--line)", color: "var(--c-text-muted)" }}>
                  <th scope="col" className="px-4 py-2 font-semibold">Restaurant</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Net rev</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Acquire</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Serve</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Contribution</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Margin</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {d.clients.map((c) => {
                  const v = VERDICT_TONE[c.verdict];
                  return (
                    <tr key={c.id} className="border-b" style={{ borderColor: "var(--line)" }}>
                      <td className="px-4 py-2">
                        <Link href={`/admin/photo/restaurants/${c.id}`} className="font-medium hover:underline" style={{ color: "var(--c-text)" }}>
                          {c.name}
                        </Link>
                        <div className="text-xs" style={{ color: "var(--c-text-faint)" }}>
                          {c.city ?? "—"}
                          {c.packages ? ` · ${c.packages}` : ""}
                          {c.nPayments >= 2 ? ` · ${c.nPayments}×` : ""}
                        </div>
                      </td>
                      <td className="px-4 py-2 tabular-nums">{money(c.netRevenueCents)}</td>
                      <td className="px-4 py-2 tabular-nums" style={{ color: "var(--c-text-muted)" }}>{money(c.acquireCents)}</td>
                      <td className="px-4 py-2 tabular-nums" style={{ color: "var(--c-text-muted)" }}>{money(c.serveCents)}</td>
                      <td className="px-4 py-2 tabular-nums" style={{ color: c.contributionCents < 0 ? "var(--coral)" : "var(--c-text)" }}>
                        {signed(c.contributionCents)}
                      </td>
                      <td className="px-4 py-2 tabular-nums" style={{ color: "var(--c-text-muted)" }}>
                        {c.marginPct == null ? "—" : `${(c.marginPct * 100).toFixed(0)}%`}
                      </td>
                      <td className="px-4 py-2">
                        <Pill tone={v.tone}>{v.label}</Pill>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ConsoleCard>
      )}
      <Pager
        base="/admin/photo/financials"
        page={d.page}
        hasNext={d.hasNext}
        params={{ ...rangeParams(d.range), sort: d.sort }}
      />
    </section>
  );
}

function SegmentTable({ title, rows }: { title: string; rows: SegmentRow[] }) {
  return (
    <ConsoleCard title={title}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem] border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide" style={{ borderColor: "var(--line)", color: "var(--c-text-muted)" }}>
              <th scope="col" className="px-4 py-2 font-semibold">Segment</th>
              <th scope="col" className="px-4 py-2 font-semibold">Clients</th>
              <th scope="col" className="px-4 py-2 font-semibold">Net rev</th>
              <th scope="col" className="px-4 py-2 font-semibold">Contribution</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const thin = r.clients < 3;
              return (
                <tr key={r.label} className="border-b" style={{ borderColor: "var(--line)", opacity: thin ? 0.5 : 1 }}>
                  <td className="px-4 py-2 font-medium">
                    {r.label}
                    {thin && <span className="ml-1.5 text-[10px]" style={{ color: "var(--c-text-faint)" }}>too few to read</span>}
                  </td>
                  <td className="px-4 py-2 tabular-nums">{r.clients}</td>
                  <td className="px-4 py-2 tabular-nums">{money(r.netRevenueCents)}</td>
                  <td className="px-4 py-2 tabular-nums" style={{ color: r.contributionCents < 0 ? "var(--coral)" : "var(--c-text)" }}>
                    {signed(r.contributionCents)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ConsoleCard>
  );
}

function CityTable({ rows }: { rows: CityRow[] }) {
  return (
    <ConsoleCard title="By city" sub="Includes cities where nobody paid — that's the actionable view">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[24rem] border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide" style={{ borderColor: "var(--line)", color: "var(--c-text-muted)" }}>
              <th scope="col" className="px-4 py-2 font-semibold">City</th>
              <th scope="col" className="px-4 py-2 font-semibold">Leads</th>
              <th scope="col" className="px-4 py-2 font-semibold">Payers</th>
              <th scope="col" className="px-4 py-2 font-semibold">Acq. spend</th>
              <th scope="col" className="px-4 py-2 font-semibold">Net rev</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.city} className="border-b" style={{ borderColor: "var(--line)" }}>
                <td className="px-4 py-2 font-medium">{r.city}</td>
                <td className="px-4 py-2 tabular-nums" style={{ color: "var(--c-text-muted)" }}>{r.leads}</td>
                <td className="px-4 py-2 tabular-nums">{r.payers}</td>
                <td className="px-4 py-2 tabular-nums" style={{ color: "var(--c-text-muted)" }}>{money(r.acquireCents)}</td>
                <td className="px-4 py-2 tabular-nums" style={{ color: r.netRevenueCents < r.acquireCents ? "var(--coral)" : "var(--c-text)" }}>
                  {money(r.netRevenueCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ConsoleCard>
  );
}

function UnattributedTable({ rows, nowMs }: { rows: SelfServeRow[]; nowMs: number }) {
  return (
    <section>
      <SectionHeading>Self-serve buyers (unattributed)</SectionHeading>
      <p className="mt-1 text-xs" style={{ color: "var(--c-text-faint)" }}>
        Self-serve orders have no restaurant link — grouped by the email Stripe collected.
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm" style={{ color: "var(--c-text-muted)" }}>
          No self-serve revenue in this period.
        </p>
      ) : (
        <ConsoleCard>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide" style={{ borderColor: "var(--line)", color: "var(--c-text-muted)" }}>
                  <th scope="col" className="px-4 py-2 font-semibold">Customer</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Orders</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Net rev</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Last</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.email ?? `anon-${i}`} className="border-b" style={{ borderColor: "var(--line)" }}>
                    <td className="px-4 py-2">
                      <span className="font-medium">{r.email ?? "(no email)"}</span>
                      <div className="flex gap-1.5 text-xs" style={{ color: "var(--c-text-faint)" }}>
                        {r.repeat && <Pill tone="teal">repeat</Pill>}
                        {r.inferredRestaurant && <Pill tone="plum">lead: {r.inferredRestaurant}</Pill>}
                      </div>
                    </td>
                    <td className="px-4 py-2 tabular-nums">{r.orders}</td>
                    <td className="px-4 py-2 tabular-nums">{money(r.netRevenueCents)}</td>
                    <td className="px-4 py-2 text-xs tabular-nums" style={{ color: "var(--c-text-muted)" }}>
                      {relTime(r.lastPaid, nowMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ConsoleCard>
      )}
    </section>
  );
}

function BlindSpots() {
  const items = [
    "Claid retries (attempts=3) wrap the whole enhance chain, so one photo can bill up to 3× — not recorded. Calibrate the per-photo cost from the invoice, which includes the waste.",
    "Order retry re-bills the whole batch (successes included) and destroys the prior count — unrecoverable from the DB.",
    "Free-sample re-clicks overwrite the same URL, so N clicks look like 1.",
    "Moderation on a rejected /enhance prompt leaves no row (~$0.0003/call, excluded as de minimis).",
    "Storage bytes are never recorded and nothing is ever deleted — storage cost drifts low over time.",
    "Places Text Search bills per page; hard-filter rejects leave no row, so per-lead cost amortizes over survivors.",
    "Founder labor is not costed — every sample and order is hand-finished. This is cash margin, not economic margin.",
  ];
  return (
    <section>
      <details>
        <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-muted">
          What this model can’t see
        </summary>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-xs" style={{ color: "var(--c-text-muted)" }}>
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
