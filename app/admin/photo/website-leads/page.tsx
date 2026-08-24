import { sql } from "drizzle-orm";
import { db } from "@/db";
import Link from "next/link";
import { Badge, EmptyState, SectionHeading } from "../../ui";
import { classifyWebsite, describeWebsiteTier, type WebsiteTier } from "@/worker/lib/websitePlatform";
import { isKnownChain } from "@/worker/lib/chains";

// Prospects for the future WEBSITE product, banked automatically. Three motions:
//   - No website at all  -> phone (they're also the photo call_list). A single
//     call can pitch both "get you online" and photos.
//   - No site of their OWN (free subdomain / ordering page / social page) ->
//     the strongest email pitch: they never bought a domain.
//   - Weak website (Gate-1 'sparse' or a DIY builder) -> reachable by email.
// Read-only view over data the pipeline already stores — no new tables/writes.
export const dynamic = "force-dynamic";

type Row = {
  id: number; name: string; city: string | null; phone: string | null; website: string | null;
  reviewCount: number | null; rating: number | null; band: string | null; richness: number | null; status: string | null;
};

type ClassifiedRow = Row & { tier: WebsiteTier; platform: string | null };

// Qualification runs in JS, not SQL, because it's a URL classification
// (worker/lib/websitePlatform.ts) rather than something expressible as a column
// predicate. The band='sparse' test alone used to miss the clearest prospects
// of all: Raspados Don Manuel scores richness 51 ("unclear") while sitting on a
// FREE Weebly subdomain — never bought a domain, and invisible to this page.
async function getLeads(): Promise<ClassifiedRow[]> {
  const rows = (await db.execute(sql`
    select id, name, city, phone, website,
      review_count as "reviewCount", rating,
      website_photo_band as "band", website_photo_richness as "richness",
      enrichment_status as "status"
    from restaurants
    where coalesce(suppressed, false) = false
      and coalesce(rejection_reason, '') not ilike '%professional photography%'
    order by review_count desc nulls last
    limit 1000
  `)) as unknown as Row[];

  return rows
    .map((r) => {
      const c = classifyWebsite(r.website);
      return { ...r, tier: c.tier, platform: c.platform };
    })
    // A prospect is anything we can plausibly improve on: no site, someone
    // else's site, or a weak one. `custom` only qualifies when Gate 1 read the
    // page as genuinely thin.
    .filter((r) => r.tier !== "custom" || r.band === "sparse")
    // Chain-REJECTED leads are deliberately still eligible here. That rejection
    // answers the PHOTO question ("do they have corporate marketing that shoots
    // their food?"), which is not the website question. Raspados Don Manuel —
    // five family raspados stands, 431 reviews — is disqualified for photos yet
    // is a prime website lead precisely BECAUSE it has five locations and no
    // real site. The web presence is the better evidence anyway: nobody with a
    // marketing department is running off a free Weebly subdomain, so the tier
    // filter above already drops the real corporates (they have custom sites).
    // Only the unambiguous national brands are excluded, and that check is free.
    .filter((r) => !isKnownChain(r.name, r.website));
}

function Table({ rows }: { rows: ClassifiedRow[] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[60rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500">
            <th className="px-3 py-2 font-semibold">Restaurant</th>
            <th className="px-3 py-2 font-semibold">City</th>
            <th className="px-3 py-2 font-semibold">Phone</th>
            <th className="px-3 py-2 font-semibold">Website</th>
            <th className="px-3 py-2 font-semibold" title="What their current site is built on. A free subdomain or an ordering page means they never bought a domain — the strongest pitch.">Platform</th>
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
              <td className="px-3 py-2 text-stone-600">
                {r.platform ? (
                  <span title={describeWebsiteTier(r.tier)}>
                    {r.platform}
                    <span className="ml-1 text-xs text-stone-400">{describeWebsiteTier(r.tier)}</span>
                  </span>
                ) : (
                  <span className="text-stone-400">{describeWebsiteTier(r.tier)}</span>
                )}
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
  const noSite = all.filter((r) => r.tier === "none");
  // Strongest email pitch: they're online, but on someone else's property — a
  // free subdomain, an ordering page, or a social profile. They never bought a
  // domain, so "you don't really own your web presence" is literally true.
  const notTheirs = all.filter((r) => r.tier === "free_subdomain" || r.tier === "ordering_platform" || r.tier === "social_only");
  // Own domain, but a DIY build or a page Gate 1 read as thin.
  const weakSite = all.filter((r) => r.tier === "diy_builder" || r.tier === "custom");

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
          No site of their own{" "}
          <span className="font-normal text-stone-400">
            · {notTheirs.length} · free subdomain / ordering page / social page — never bought a domain
          </span>
        </h3>
        {notTheirs.length === 0 ? <EmptyState>None yet.</EmptyState> : <Table rows={notTheirs} />}
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-semibold text-stone-800">
          Weak website <span className="font-normal text-stone-400">· {weakSite.length} · own domain, DIY build or thin page</span>
        </h3>
        {weakSite.length === 0 ? <EmptyState>None yet.</EmptyState> : <Table rows={weakSite} />}
      </div>
    </div>
  );
}
