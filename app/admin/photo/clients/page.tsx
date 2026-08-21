import { sql } from "drizzle-orm";
import { db } from "@/db";
import Link from "next/link";
import { EmptyState, SectionHeading, money, telHref } from "../../ui";

// Who we've done business with — retention view over the payments ledger. Groups
// every payment by client (restaurant for package/outreach sales, email for
// self-serve), so you can see lifetime value and, critically, WHO HAS GONE QUIET.
// Read-only; no new tables.
export const dynamic = "force-dynamic";

const SUB_ACTIVE_DAYS = 35; // an always_fresh charge newer than this = active

type Row = {
  clientKey: string;
  restaurantId: number | null;
  name: string | null;
  city: string | null;
  contact: string | null;
  lifetimeCents: number;
  orders: number;
  firstPaid: string;
  lastPaid: string;
  hasSub: boolean;
  website: string | null;
  lastSubPaid: string | null;
  products: string[];
};

async function getClients(): Promise<Row[]> {
  const rows = await db.execute(sql`
    select
      coalesce('r:' || p.restaurant_id::text, 'e:' || p.customer_email) as "clientKey",
      max(p.restaurant_id) as "restaurantId",
      max(r.name) as "name",
      max(r.city) as "city",
      max(r.website) as "website",
      coalesce(max(r.phone), max(p.customer_email)) as "contact",
      sum(p.gross_cents - p.refunded_cents)::int as "lifetimeCents",
      count(*)::int as "orders",
      min(p.paid_at) as "firstPaid",
      max(p.paid_at) as "lastPaid",
      bool_or(p.package_id = 'always_fresh') as "hasSub",
      max(p.paid_at) filter (where p.package_id = 'always_fresh') as "lastSubPaid",
      array_agg(distinct coalesce(p.package_id, p.line)) as "products"
    from payments p
    left join restaurants r on r.id = p.restaurant_id
    group by coalesce('r:' || p.restaurant_id::text, 'e:' || p.customer_email)
  `);
  return rows as unknown as Row[];
}

type Status = "active_sub" | "lapsed_sub" | "repeat" | "one_time";
function statusOf(r: Row, nowMs: number): Status {
  if (r.hasSub) {
    const days = r.lastSubPaid ? (nowMs - new Date(r.lastSubPaid).getTime()) / 86_400_000 : Infinity;
    return days <= SUB_ACTIVE_DAYS ? "active_sub" : "lapsed_sub";
  }
  return r.orders >= 2 ? "repeat" : "one_time";
}
const RANK: Record<Status, number> = { lapsed_sub: 0, active_sub: 1, repeat: 2, one_time: 3 };
const LABEL: Record<Status, string> = { lapsed_sub: "⚠ Lapsed subscriber", active_sub: "Active subscriber", repeat: "Repeat", one_time: "One-time" };
const TONE: Record<Status, string> = {
  lapsed_sub: "bg-red-50 text-red-700 ring-red-200",
  active_sub: "bg-green-50 text-green-700 ring-green-200",
  repeat: "bg-blue-50 text-blue-700 ring-blue-200",
  one_time: "bg-stone-100 text-stone-600 ring-stone-200",
};

function fmt(d: string): string {
  return new Date(d).toISOString().slice(0, 10);
}

export default async function ClientsPage() {
  const raw = await getClients();
  const nowMs = Date.now();
  const clients = raw
    .map((r) => ({ ...r, status: statusOf(r, nowMs), daysSince: Math.floor((nowMs - new Date(r.lastPaid).getTime()) / 86_400_000) }))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || b.lifetimeCents - a.lifetimeCents);

  const totalRevenue = clients.reduce((s, c) => s + c.lifetimeCents, 0);
  const activeSubs = clients.filter((c) => c.status === "active_sub").length;
  const lapsedSubs = clients.filter((c) => c.status === "lapsed_sub").length;
  const repeatRate = clients.length ? Math.round((clients.filter((c) => c.orders >= 2).length / clients.length) * 100) : 0;

  return (
    <div>
      <SectionHeading>Clients</SectionHeading>
      <p className="mt-2 max-w-2xl text-sm text-stone-500">
        Everyone who has paid, most-urgent first. Lapsed subscribers are at the top — a client link opens their profile,
        where you can send a one-off follow-up.
      </p>

      <div className="mt-4 flex flex-wrap gap-4 text-sm">
        <span><b>{clients.length}</b> clients</span>
        <span><b>{activeSubs}</b> active subs</span>
        <span className={lapsedSubs ? "text-red-600" : ""}><b>{lapsedSubs}</b> lapsed</span>
        <span><b>{money(totalRevenue)}</b> lifetime revenue</span>
        <span><b>{repeatRate}%</b> repeat rate</span>
      </div>

      {clients.length === 0 ? (
        <EmptyState>No payments recorded yet — this fills as clients pay.</EmptyState>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[64rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-semibold">Client</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Lifetime</th>
                <th className="px-3 py-2 font-semibold">Orders</th>
                <th className="px-3 py-2 font-semibold">Last paid</th>
                <th className="px-3 py-2 font-semibold">Days ago</th>
                <th className="px-3 py-2 font-semibold">Products</th>
                <th className="px-3 py-2 font-semibold">Contact</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.clientKey} className="border-b border-stone-100">
                  <td className="px-3 py-2 font-medium">
                    {c.restaurantId ? (
                      <Link href={`/admin/photo/restaurants/${c.restaurantId}`} className="text-stone-800 hover:underline">{c.name ?? "Restaurant"}</Link>
                    ) : (
                      <span className="text-stone-800">{c.contact ?? "Self-serve"}</span>
                    )}
                    {c.city ? <span className="text-stone-400"> · {c.city}</span> : null}
                    {c.website && (
                      <a href={c.website} target="_blank" rel="noopener noreferrer" className="ml-2 text-xs text-blue-600 hover:underline">
                        site ↗
                      </a>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[c.status]}`}>{LABEL[c.status]}</span>
                  </td>
                  <td className="px-3 py-2 tabular-nums font-semibold">{money(c.lifetimeCents)}</td>
                  <td className="px-3 py-2 tabular-nums text-stone-600">{c.orders}</td>
                  <td className="px-3 py-2 text-stone-600">{fmt(c.lastPaid)}</td>
                  <td className={`px-3 py-2 tabular-nums ${c.status === "lapsed_sub" ? "text-red-600 font-semibold" : "text-stone-600"}`}>{c.daysSince}</td>
                  <td className="px-3 py-2 text-stone-500">{c.products.join(", ")}</td>
                  <td className="px-3 py-2 text-stone-600">
                    {c.contact && /^[\d ()+-]+$/.test(c.contact) ? (
                      <a href={telHref(c.contact)} className="tabular-nums text-blue-600 hover:underline">{c.contact}</a>
                    ) : (
                      c.contact ?? "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
