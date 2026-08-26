import { sql } from "drizzle-orm";
import { db } from "@/db";
import Link from "next/link";
import { Badge, EmptyState, SectionHeading, telHref, fmtDate } from "../../ui";

// The PHONE channel. Restaurants with no website — or whose only web presence
// is a social page (Instagram/Facebook) or an ordering platform, where no
// mailbox of the restaurant's own can exist — can't be emailed, so they land in
// `call_list` during enrichment. They are NOT a lesser lead — measured across
// sourcing runs they're ~23% of everything sourced and skew toward exactly the
// independent, low-digital-footprint places this product serves. Phone is the
// only way to reach them, and one call can pitch BOTH photos and (later) a
// website.
//
// Read-only view: no new tables, no writes.
export const dynamic = "force-dynamic";

type Row = {
  id: number; name: string; city: string | null; phone: string | null; website: string | null;
  reviewCount: number | null; rating: number | null; dish: string | null;
  priority: number | null; status: string | null; lastContactedAt: Date | null;
};

async function getCallList(city: string): Promise<Row[]> {
  const rows = await db.execute(sql`
    select id, name, city, phone, website,
      review_count as "reviewCount", rating, signature_dish as "dish",
      priority_score as "priority", enrichment_status as "status",
      last_contacted_at as "lastContactedAt"
    from restaurants
    where enrichment_status = 'call_list'
      and coalesce(suppressed, false) = false
      and coalesce(held, false) = false
      ${city && city !== "all" ? sql`and city = ${city}` : sql``}
    order by review_count desc nulls last
    limit 400
  `);
  return rows as unknown as Row[];
}

async function getCities(): Promise<string[]> {
  const rows = await db.execute(sql`
    select distinct city from restaurants
    where enrichment_status = 'call_list' and city is not null
    order by city
  `);
  return (rows as unknown as { city: string }[]).map((r) => r.city);
}

export default async function CallListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const city = typeof params.city === "string" ? params.city : "all";
  const [rows, cities] = await Promise.all([getCallList(city), getCities()]);
  const withPhone = rows.filter((r) => r.phone);

  return (
    <div>
      <SectionHeading>Call list</SectionHeading>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Restaurants with <strong>no real website</strong> — no site at all, or only a social/ordering page with no
        mailbox of their own — so they can&apos;t be emailed and phone is the only channel. These are prime targets:
        little to no web presence usually means no professional photos either. One call can pitch photos now and a
        website later. Sorted busiest-first (more reviews = better prospect).
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted">
          <strong className="text-text">{rows.length}</strong> to call
          {rows.length !== withPhone.length && (
            <span className="text-faint"> · {rows.length - withPhone.length} missing a number</span>
          )}
        </span>
        <span className="text-faint">|</span>
        <div className="flex flex-wrap gap-1">
          <Link
            href="/admin/photo/call-list"
            className={`rounded-md px-2 py-1 text-xs ${city === "all" ? "bg-gold text-[#0F1216]" : "bg-surface-2 text-muted hover:bg-surface-2"}`}
          >
            All cities
          </Link>
          {cities.map((c) => (
            <Link
              key={c}
              href={`/admin/photo/call-list?city=${encodeURIComponent(c)}`}
              className={`rounded-md px-2 py-1 text-xs ${city === c ? "bg-gold text-[#0F1216]" : "bg-surface-2 text-muted hover:bg-surface-2"}`}
            >
              {c}
            </Link>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState>No one to call yet — this fills from each sourcing run.</EmptyState>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[58rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-semibold">Restaurant</th>
                <th className="px-3 py-2 font-semibold">City</th>
                <th className="px-3 py-2 font-semibold">Phone</th>
                <th className="px-3 py-2 font-semibold">Reviews</th>
                <th className="px-3 py-2 font-semibold">Rating</th>
                <th className="px-3 py-2 font-semibold">Signature dish</th>
                <th className="px-3 py-2 font-semibold">Site</th>
                <th className="px-3 py-2 font-semibold">Called</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line">
                  <td className="px-3 py-2 font-medium">
                    <Link href={`/admin/photo/restaurants/${r.id}`} className="text-text hover:underline">
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted">{r.city ?? "—"}</td>
                  <td className="px-3 py-2">
                    {r.phone ? (
                      <a href={telHref(r.phone)} className="font-medium tabular-nums text-gold hover:underline">
                        {r.phone}
                      </a>
                    ) : (
                      <span className="text-faint">no number</span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted">{r.reviewCount ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums text-muted">{r.rating ?? "—"}</td>
                  <td className="px-3 py-2 text-muted">{r.dish ?? "—"}</td>
                  <td className="px-3 py-2">
                    {r.website ? (
                      <a href={r.website} target="_blank" rel="noreferrer" className="text-gold hover:underline">
                        site ↗
                      </a>
                    ) : (
                      <span className="text-faint">none</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {r.lastContactedAt ? fmtDate(new Date(r.lastContactedAt)) : <Badge value="not yet" />}
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
