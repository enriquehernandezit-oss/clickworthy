import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks, restaurants } from "@/db/schema";
import SampleActions from "../SampleActions";
import UnrejectButton from "./UnrejectButton";
import { Badge, Card, EmptyState, Figure, Pager, SectionHeading, fmtDate } from "../../ui";

// Free-sample production: the work queue (replies awaiting a human edit) plus
// the history of everything already approved or rejected — which the old
// single-queue view lost track of the moment you approved it.
export const dynamic = "force-dynamic";

const LIMIT = 25;
const HISTORY_STATUSES = ["approved", "rejected"] as const;

async function getQueue() {
  return db
    .select({
      id: magicLinks.id,
      token: magicLinks.token,
      original: magicLinks.freeSampleOriginalUrl,
      firstPass: magicLinks.freeSampleFirstPassUrl,
      enhanced: magicLinks.freeSampleEnhancedUrl,
      revenueCopy: magicLinks.revenueImpactCopy,
      restaurantName: restaurants.name,
      city: restaurants.city,
    })
    .from(magicLinks)
    .leftJoin(restaurants, eq(magicLinks.restaurantId, restaurants.id))
    .where(eq(magicLinks.reviewStatus, "awaiting_edit"))
    // Each card renders 3 full-size photos; cap so a backlog doesn't blow up
    // the page. The overview's "N replies to edit" chip stays truthful.
    .orderBy(desc(magicLinks.createdAt))
    .limit(50);
}

async function getHistory(status: string, page: number) {
  const statuses = status === "all" ? [...HISTORY_STATUSES] : [status];
  return db
    .select({
      id: magicLinks.id,
      token: magicLinks.token,
      enhanced: magicLinks.freeSampleEnhancedUrl,
      reviewStatus: magicLinks.reviewStatus,
      createdAt: magicLinks.createdAt,
      touch2SentAt: magicLinks.touch2SentAt,
      viewedAt: magicLinks.viewedAt,
      paidAt: magicLinks.paidAt,
      restaurantName: restaurants.name,
      city: restaurants.city,
    })
    .from(magicLinks)
    .leftJoin(restaurants, eq(magicLinks.restaurantId, restaurants.id))
    .where(inArray(magicLinks.reviewStatus, statuses))
    .orderBy(desc(magicLinks.createdAt))
    .limit(LIMIT + 1)
    .offset((page - 1) * LIMIT);
}

export default async function SamplesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const status = typeof sp.status === "string" && ["approved", "rejected", "all"].includes(sp.status) ? sp.status : "all";
  const page = Math.max(1, Number(sp.page) || 1);

  const [queue, historyRows] = await Promise.all([getQueue(), getHistory(status, page)]);
  const history = historyRows.slice(0, LIMIT);
  const hasNext = historyRows.length > LIMIT;

  return (
    <>
      {/* Work queue */}
      <section>
        <SectionHeading>New replies — needs editing ({queue.length})</SectionHeading>
        {queue.length === 0 && <EmptyState>Nothing to edit right now.</EmptyState>}
        <div className="mt-4 flex flex-col gap-6">
          {queue.map((item) => (
            <Card key={item.id}>
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="font-semibold">{item.restaurantName ?? "(unknown restaurant)"}</h3>
                <span className="text-xs text-stone-500">{item.city}</span>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Figure label="Original (they sent)" src={item.original} />
                <Figure label="Claid first pass (optional)" src={item.firstPass} />
                <Figure label="Finished (uploaded)" src={item.enhanced} />
              </div>
              {item.revenueCopy && (
                <p className="mt-4 rounded-lg bg-stone-50 p-3 text-sm text-stone-600">{item.revenueCopy}</p>
              )}
              <SampleActions magicLinkId={item.id} hasFinished={Boolean(item.enhanced)} />
            </Card>
          ))}
        </div>
      </section>

      {/* History */}
      <section className="mt-12">
        <SectionHeading>History</SectionHeading>
        <FilterTabs current={status} />

        {history.length === 0 ? (
          <EmptyState>No {status === "all" ? "finished" : status} samples yet.</EmptyState>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[52rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-semibold">Photo</th>
                  <th className="px-3 py-2 font-semibold">Restaurant</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Replied</th>
                  <th className="px-3 py-2 font-semibold">Sample sent</th>
                  <th className="px-3 py-2 font-semibold">Viewed</th>
                  <th className="px-3 py-2 font-semibold">Paid</th>
                  <th className="px-3 py-2 font-semibold"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id} className="border-b border-stone-100 align-middle">
                    <td className="px-3 py-2">
                      {row.enhanced ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={row.enhanced}
                          alt=""
                          className="h-10 w-10 rounded border border-stone-200 object-cover"
                        />
                      ) : (
                        <div className="h-10 w-10 rounded border border-dashed border-stone-200" />
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{row.restaurantName ?? "(unknown)"}</div>
                      <div className="text-xs text-stone-500">{row.city ?? "—"}</div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge value={row.reviewStatus} />
                    </td>
                    <td className="px-3 py-2 tabular-nums text-stone-600">{fmtDate(row.createdAt)}</td>
                    <td className="px-3 py-2 tabular-nums text-stone-600">{fmtDate(row.touch2SentAt)}</td>
                    <td className="px-3 py-2 tabular-nums text-stone-600">{fmtDate(row.viewedAt)}</td>
                    <td className="px-3 py-2 tabular-nums text-stone-600">{fmtDate(row.paidAt)}</td>
                    <td className="px-3 py-2">
                      {row.reviewStatus === "rejected" && <UnrejectButton magicLinkId={row.id} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pager base="/admin/photo/samples" page={page} hasNext={hasNext} params={{ status }} />
      </section>
    </>
  );
}

function FilterTabs({ current }: { current: string }) {
  const options = [
    ["all", "All"],
    ["approved", "Approved"],
    ["rejected", "Rejected"],
  ] as const;
  return (
    <div className="mt-3 flex gap-2">
      {options.map(([value, label]) => (
        <a
          key={value}
          href={value === "all" ? "/admin/photo/samples" : `/admin/photo/samples?status=${value}`}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            current === value
              ? "border-orange-300 bg-orange-50 text-orange-700"
              : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100"
          }`}
        >
          {label}
        </a>
      ))}
    </div>
  );
}
