import { sql } from "drizzle-orm";
import { db } from "@/db";
import Link from "next/link";
import { Badge, EmptyState, SectionHeading } from "../../ui";

// Prospects for the future WEBSITE product, banked automatically. Two motions:
//   - No website at all  -> phone (they're also the photo call_list). A single
//     call can pitch both "get you online" and photos.
//   - Weak website (Gate-1 'sparse') -> reachable by email; the future website
//     cold-email pitch reads this exact set.
// Read-only view over data the pipeline already stores — no new tables/writes.
export const dynamic = "force-dynamic";

type Row = {
  id: number; name: string; city: string | null; phone: string | null; website: string | null;
  reviewCount: number | null; rating: number | null; band: string | null; richness: number | null; status: string | null;
};

async function getLeads(): Promise<Row[]> {
  const rows = await db.execute(sql`
    select id, name, city, phone, website,
      review_count as "reviewCount", rating,
      website_photo_band as "band", website_photo_richness as "richness",
      enrichment_status as "status"
    from restaurants
    where coalesce(suppressed, false) = false
      and coalesce(rejection_reason, '') not ilike '%chain%'
      and coalesce(rejection_reason, '') not ilike '%professional photography%'
      and (website is null or website_photo_band = 'sparse')
    order by review_count desc nulls last
    limit 400
  `);
  return rows as unknown as Row[];
}

function Table({ rows }: { rows: Row[] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[60rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500">
            <th className="px-3 py-2 font-semibold">Restaurant</th>
            <th className="px-3 py-2 font-semibold">City</th>
            <th className="px-3 py-2 font-semibold">Phone</th>
            <th className="px-3 py-2 font-semibold">Website</th>
            <th className="px-3 py-2 font-semibold">Reviews</th>
            <th className="px-3 py-2 font-semibold">Rating</th>
            <th className="px-3 py-2 font-semibold" title="Website richness 0–100 (lower = weaker site). '—' = no site to score.">Site score</th>
            <th className="px-3 py-2 font-semibold">Pipeline</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-stone-100">
              <td className="px-3 py-2 font-medium">
                <Link href={`/admin/photo/restaurants/${r.id}`} className="text-stone-800 hover:underline">{r.name}</Link>
              </td>
              <td className="px-3 py-2 text-stone-600">{r.city ?? "—"}</td>
              <td className="px-3 py-2 text-stone-800">{r.phone ?? "—"}</td>
              <td className="px-3 py-2 text-stone-600">
                {r.website ? <a href={r.website} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">site ↗</a> : "—"}
              </td>
              <td className="px-3 py-2 tabular-nums text-stone-600">{r.reviewCount ?? "—"}</td>
              <td className="px-3 py-2 tabular-nums text-stone-600">{r.rating ?? "—"}</td>
              <td className="px-3 py-2 tabular-nums text-stone-600">{r.richness ?? "—"}</td>
              <td className="px-3 py-2"><Badge value={r.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function WebsiteLeadsPage() {
  const all = await getLeads();
  const noSite = all.filter((r) => r.website == null);
  const weakSite = all.filter((r) => r.website != null);

  return (
    <div>
      <SectionHeading>Website leads</SectionHeading>
      <p className="mt-2 max-w-2xl text-sm text-stone-500">
        Prospects for a future website product, collected automatically. Nothing here is contacted by the current
        pipeline — it&apos;s a call/pitch sheet that fills up on its own. Sorted busiest-first.
      </p>

      <div className="mt-6">
        <h3 className="text-sm font-semibold text-stone-800">
          No website at all <span className="font-normal text-stone-400">· {noSite.length} · phone pitch (also in the photo call list)</span>
        </h3>
        {noSite.length === 0 ? <EmptyState>None yet — populates from tonight&apos;s sourcing run onward.</EmptyState> : <Table rows={noSite} />}
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-semibold text-stone-800">
          Weak website <span className="font-normal text-stone-400">· {weakSite.length} · reachable by email (future website pitch)</span>
        </h3>
        {weakSite.length === 0 ? <EmptyState>None yet.</EmptyState> : <Table rows={weakSite} />}
      </div>
    </div>
  );
}
