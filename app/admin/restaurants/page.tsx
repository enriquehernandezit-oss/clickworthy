import { and, eq, ilike, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import Link from "next/link";
import RestaurantActions from "./RestaurantActions";
import { Badge, EmptyState, Pager, SectionHeading } from "../ui";

// The lead database, browsable. The important job here is unblocking rows the
// automated pipeline couldn't finish — mainly `needs_manual_email`, where a
// human finds the address and the row re-enters the send queue.
export const dynamic = "force-dynamic";

const LIMIT = 50;
const STATUSES = ["sourced", "queued", "needs_manual_email", "contacted", "rejected"] as const;

async function getRestaurants(status: string, q: string, page: number) {
  const filters = [];
  if (status !== "all") filters.push(eq(restaurants.enrichmentStatus, status));
  if (q) filters.push(ilike(restaurants.name, `%${q}%`));

  return db
    .select({
      id: restaurants.id,
      name: restaurants.name,
      city: restaurants.city,
      email: restaurants.email,
      enrichmentStatus: restaurants.enrichmentStatus,
      signatureDish: restaurants.signatureDish,
      contactFirstName: restaurants.contactFirstName,
      priorityScore: restaurants.priorityScore,
      language: restaurants.language,
      suppressed: restaurants.suppressed,
      held: restaurants.held,
      website: restaurants.website,
    })
    .from(restaurants)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(sql`${restaurants.priorityScore} desc nulls last`, restaurants.name)
    .limit(LIMIT + 1)
    .offset((page - 1) * LIMIT);
}

export default async function RestaurantsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const status =
    typeof sp.status === "string" && (STATUSES as readonly string[]).includes(sp.status) ? sp.status : "all";
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const page = Math.max(1, Number(sp.page) || 1);

  const rows = await getRestaurants(status, q, page);
  const list = rows.slice(0, LIMIT);

  return (
    <section>
      <SectionHeading>Restaurants</SectionHeading>

      {/* Plain GET form — filters live in the URL, so they survive refresh and
          router.refresh() after a mutation, with no client JS. */}
      <form method="GET" className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="status" className="block text-xs font-medium text-stone-500">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={status}
            className="mt-1 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800"
          >
            <option value="all">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="q" className="block text-xs font-medium text-stone-500">
            Search name
          </label>
          <input
            id="q"
            name="q"
            defaultValue={q}
            placeholder="e.g. taqueria"
            className="mt-1 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800 placeholder:text-stone-400"
          />
        </div>
        <button
          type="submit"
          className="btn-press rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-800"
        >
          Filter
        </button>
        {(status !== "all" || q) && (
          <Link href="/admin/restaurants" className="py-2 text-sm font-medium text-stone-500 hover:text-stone-800">
            Clear
          </Link>
        )}
      </form>

      {list.length === 0 ? (
        <EmptyState>No restaurants match this filter.</EmptyState>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[64rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-semibold">Restaurant</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Signature dish</th>
                <th className="px-3 py-2 font-semibold">Contact</th>
                <th className="px-3 py-2 font-semibold">Score</th>
                <th className="px-3 py-2 font-semibold">Email &amp; actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="border-b border-stone-100 align-top">
                  <td className="px-3 py-3">
                    <Link href={`/admin/restaurants/${r.id}`} className="font-medium text-stone-900 hover:text-orange-700 hover:underline">
                      {r.name}
                    </Link>
                    <div className="text-xs text-stone-500">
                      {r.city ?? "—"}
                      {r.language === "es" && " · ES"}
                      {r.suppressed && <span className="ml-1 font-medium text-red-600">· suppressed</span>}
                      {r.held && <span className="ml-1 font-medium text-amber-600">· held</span>}
                    </div>
                    {r.website && (
                      <a
                        href={r.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-orange-700 hover:underline"
                      >
                        website ↗
                      </a>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <Badge value={r.enrichmentStatus} />
                  </td>
                  <td className="px-3 py-3 text-stone-700">{r.signatureDish ?? <span className="text-stone-400">—</span>}</td>
                  <td className="px-3 py-3 text-stone-700">
                    {r.contactFirstName ?? <span className="text-stone-400">—</span>}
                  </td>
                  <td className="px-3 py-3 tabular-nums text-stone-600">
                    {r.priorityScore == null ? "—" : r.priorityScore.toFixed(1)}
                  </td>
                  <td className="px-3 py-3">
                    <RestaurantActions
                      restaurantId={r.id}
                      email={r.email}
                      suppressed={Boolean(r.suppressed)}
                      needsEmail={r.enrichmentStatus === "needs_manual_email"}
                      held={Boolean(r.held)}
                      rejected={r.enrichmentStatus === "rejected"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        base="/admin/restaurants"
        page={page}
        hasNext={rows.length > LIMIT}
        params={{ status: status === "all" ? undefined : status, q: q || undefined }}
      />
    </section>
  );
}
