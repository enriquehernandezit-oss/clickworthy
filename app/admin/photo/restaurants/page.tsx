import { and, eq, ilike, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import Link from "next/link";
import RestaurantActions from "./RestaurantActions";
import { Badge, EmptyState, Pager, SectionHeading, telHref } from "../../ui";
import AddRestaurantForm from "./AddRestaurantForm";

// The lead database, browsable. The important job here is unblocking rows the
// automated pipeline couldn't finish — mainly `needs_manual_email`, where a
// human finds the address and the row re-enters the send queue.
export const dynamic = "force-dynamic";

const LIMIT = 50;
const STATUSES = ["sourced", "queued", "needs_manual_email", "call_list", "contacted", "rejected"] as const;

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
      avgPhotoScore: restaurants.avgPhotoScore,
      photosScored: restaurants.photosScored,
      priorityScore: restaurants.priorityScore,
      language: restaurants.language,
      suppressed: restaurants.suppressed,
      held: restaurants.held,
      website: restaurants.website,
      phone: restaurants.phone,
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeading>Restaurants</SectionHeading>
        <AddRestaurantForm />
      </div>

      {/* Plain GET form — filters live in the URL, so they survive refresh and
          router.refresh() after a mutation, with no client JS. */}
      <form method="GET" className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="status" className="block text-xs font-medium text-muted">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={status}
            className="mt-1 rounded-lg border border-line-input bg-surface-2 px-3 py-1.5 text-sm text-text"
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
          <label htmlFor="q" className="block text-xs font-medium text-muted">
            Search name
          </label>
          <input
            id="q"
            name="q"
            defaultValue={q}
            placeholder="e.g. taqueria"
            className="mt-1 rounded-lg border border-line-input bg-surface-2 px-3 py-1.5 text-sm text-text placeholder:text-faint"
          />
        </div>
        <button
          type="submit"
          className="btn-press rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-[#0F1216] hover:brightness-110"
        >
          Filter
        </button>
        {(status !== "all" || q) && (
          <Link href="/admin/photo/restaurants" className="py-2 text-sm font-medium text-muted hover:text-text">
            Clear
          </Link>
        )}
      </form>

      {list.length === 0 ? (
        <EmptyState>No restaurants match this filter.</EmptyState>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[72rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-semibold">Restaurant</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Signature dish</th>
                <th className="px-3 py-2 font-semibold">Contact</th>
                <th className="px-3 py-2 font-semibold">
                  <span
                    className="cursor-help border-b border-dotted border-faint"
                    title="Claude Vision photo-quality grade, 2–6. HIGHER = BETTER photos (6 = already professional, 2 = dark/blurry). Shown as x.x/6."
                  >
                    Photo score
                  </span>
                </th>
                <th className="px-3 py-2 font-semibold">
                  <span
                    className="cursor-help border-b border-dotted border-faint"
                    title="Lead priority, ~0–100. HIGHER = contact sooner / more upside. Blends worse photos, fewer reviews, lower rating, delivery enabled, and few owner photos. Note: worse photos RAISE priority but LOWER the photo score — the two run opposite directions."
                  >
                    Priority
                  </span>
                </th>
                <th className="px-3 py-2 font-semibold">Email &amp; actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="border-b border-line align-top">
                  <td className="px-3 py-3">
                    <Link href={`/admin/photo/restaurants/${r.id}`} className="font-medium text-text hover:text-gold hover:underline">
                      {r.name}
                    </Link>
                    <div className="text-xs text-muted">
                      {r.city ?? "—"}
                      {r.language === "es" && " · ES"}
                      {r.suppressed && <span className="ml-1 font-medium text-coral">· suppressed</span>}
                      {r.held && <span className="ml-1 font-medium text-gold">· held</span>}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs">
                      {r.website ? (
                        <a href={r.website} target="_blank" rel="noopener noreferrer" className="text-gold hover:underline">
                          website ↗
                        </a>
                      ) : (
                        <span className="text-faint">no website</span>
                      )}
                      {r.phone && (
                        <a href={telHref(r.phone)} className="tabular-nums text-gold hover:underline">
                          {r.phone}
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Badge value={r.enrichmentStatus} />
                  </td>
                  <td className="px-3 py-3 text-text">{r.signatureDish ?? <span className="text-faint">—</span>}</td>
                  <td className="px-3 py-3 text-text">
                    {r.contactFirstName ?? <span className="text-faint">—</span>}
                  </td>
                  <td className="px-3 py-3 tabular-nums text-muted">
                    {r.avgPhotoScore == null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <span title={`${r.photosScored ?? 0} photo${r.photosScored === 1 ? "" : "s"} scored by Claude Vision`}>
                        {r.avgPhotoScore.toFixed(1)}
                        <span className="ml-0.5 text-xs text-faint">/6</span>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 tabular-nums text-muted">
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
        base="/admin/photo/restaurants"
        page={page}
        hasNext={rows.length > LIMIT}
        params={{ status: status === "all" ? undefined : status, q: q || undefined }}
      />
    </section>
  );
}
