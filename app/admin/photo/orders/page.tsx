import { desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks, restaurants, enhancementOrders } from "@/db/schema";
import { PACKAGES, isPackageId, formatCents as formatPackageCents } from "@/lib/packages";
import { formatCents as formatPhotoCents } from "@/lib/pricing";
import { composeOrderDeliveredEmail } from "@/lib/customerEmail";
import { config } from "@/worker/config";
import Link from "next/link";
import PackageActions from "../PackageActions";
import RetryOrderButton from "./RetryOrderButton";
import PackageOrderActions from "./PackageOrderActions";
import { Badge, Card, EmptyState, Pager, SectionHeading, fmtDate } from "../../ui";

// Session-id search deep link works for both Stripe test + live mode.
function stripeUrl(sessionId: string | null): string | null {
  return sessionId ? `https://dashboard.stripe.com/search?query=${encodeURIComponent(sessionId)}` : null;
}

// Orders across BOTH revenue paths: outreach packages (sold through the
// magic-link funnel) and self-serve /enhance orders. The production queue for
// paid packages lives at the top since it's the only part that needs action.
export const dynamic = "force-dynamic";

const LIMIT = 25;

type PackageResult = { name: string; originalUrl: string; enhancedUrl: string | null; error: string | null };

async function getQueue() {
  const rows = await db
    .select({
      id: magicLinks.id,
      token: magicLinks.token,
      results: magicLinks.packageResults,
      restaurantName: restaurants.name,
      language: restaurants.language,
    })
    .from(magicLinks)
    .leftJoin(restaurants, eq(magicLinks.restaurantId, restaurants.id))
    .where(eq(magicLinks.packageStatus, "ready_for_review"))
    // Each card renders up to 40 photos (Grand Opening tier); cap so a backlog
    // doesn't render hundreds of images at once.
    .orderBy(desc(magicLinks.createdAt))
    .limit(20);

  // Seeds the editable delivery-email box in PackageActions.tsx — a human can
  // rewrite any of it before the final send. config.appOrigin (not the real
  // request origin) is fine here: this is a preview seed only, the actual send
  // in app/api/admin/package/route.ts derives the real origin from the request.
  return rows.map((item) => ({
    ...item,
    seed: item.restaurantName
      ? composeOrderDeliveredEmail({
          restaurantName: item.restaurantName,
          language: item.language ?? "en",
          deliveryUrl: `${config.appOrigin.replace(/\/$/, "")}/l/${item.token}/upload`,
        })
      : null,
  }));
}

async function getPackageOrders(page: number) {
  return db
    .select({
      id: magicLinks.id,
      token: magicLinks.token,
      packageSelected: magicLinks.packageSelected,
      packageStatus: magicLinks.packageStatus,
      stripeSessionId: magicLinks.stripeSessionId,
      paidAt: magicLinks.paidAt,
      createdAt: magicLinks.createdAt,
      restaurantName: restaurants.name,
      city: restaurants.city,
    })
    .from(magicLinks)
    .leftJoin(restaurants, eq(magicLinks.restaurantId, restaurants.id))
    .where(isNotNull(magicLinks.packageSelected))
    .orderBy(desc(magicLinks.createdAt))
    .limit(LIMIT + 1)
    .offset((page - 1) * LIMIT);
}

async function getSelfServeOrders(page: number) {
  return db
    .select({
      id: enhancementOrders.id,
      status: enhancementOrders.status,
      photoCount: enhancementOrders.photoCount,
      totalCents: enhancementOrders.totalCents,
      createdAt: enhancementOrders.createdAt,
      completedAt: enhancementOrders.completedAt,
    })
    .from(enhancementOrders)
    .orderBy(desc(enhancementOrders.createdAt))
    .limit(LIMIT + 1)
    .offset((page - 1) * LIMIT);
}

function packageLabel(id: string | null): string {
  if (!isPackageId(id)) return id ?? "—";
  const pkg = PACKAGES[id];
  return `${pkg.name.en} · ${formatPackageCents(pkg.priceCents)}`;
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const ssPage = Math.max(1, Number(sp.sspage) || 1);

  const [queue, packageRows, selfServeRows] = await Promise.all([
    getQueue(),
    getPackageOrders(page),
    getSelfServeOrders(ssPage),
  ]);

  const packageOrders = packageRows.slice(0, LIMIT);
  const selfServe = selfServeRows.slice(0, LIMIT);

  return (
    <>
      {/* Production queue */}
      <section>
        <SectionHeading>Paid orders — finish &amp; deliver ({queue.length})</SectionHeading>
        {queue.length === 0 && <EmptyState>No paid orders waiting.</EmptyState>}
        <div className="mt-4 flex flex-col gap-6">
          {queue.map((pkg) => {
            const results = (pkg.results as PackageResult[] | null) ?? [];
            return (
              <Card key={pkg.id}>
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="font-semibold">{pkg.restaurantName ?? "(unknown)"}</h3>
                  <span className="text-xs text-stone-500">{results.length} photos</span>
                </div>
                <PackageActions magicLinkId={pkg.id} results={results} seed={pkg.seed} />
              </Card>
            );
          })}
        </div>
      </section>

      {/* All package orders */}
      <section className="mt-12">
        <SectionHeading>Package orders (outreach)</SectionHeading>
        {packageOrders.length === 0 ? (
          <EmptyState>No package orders yet.</EmptyState>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500">
                  <th scope="col" className="px-3 py-2 font-semibold">Restaurant</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Package</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Status</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Paid</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Created</th>
                  <th scope="col" className="px-3 py-2 font-semibold"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {packageOrders.map((row) => {
                  const su = stripeUrl(row.stripeSessionId);
                  return (
                  <tr key={row.id} className="border-b border-stone-100">
                    <td className="px-3 py-2">
                      <div className="font-medium">{row.restaurantName ?? "(unknown)"}</div>
                      <div className="text-xs text-stone-500">{row.city ?? "—"}</div>
                    </td>
                    <td className="px-3 py-2 text-stone-700">{packageLabel(row.packageSelected)}</td>
                    <td className="px-3 py-2">
                      <Badge value={row.packageStatus} />
                    </td>
                    <td className="px-3 py-2 tabular-nums text-stone-600">
                      {fmtDate(row.paidAt)}
                      {su && (
                        <>
                          {" "}
                          <a href={su} target="_blank" rel="noopener noreferrer" className="text-xs hover:underline" style={{ color: "var(--accent)" }}>
                            Stripe ↗
                          </a>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-stone-600">{fmtDate(row.createdAt)}</td>
                    <td className="px-3 py-2">
                      <PackageOrderActions
                        magicLinkId={row.id}
                        isPaid={row.paidAt != null}
                        isCompleted={row.packageStatus === "completed"}
                        isFailed={row.packageStatus === "failed"}
                        hasPackage={row.packageSelected != null}
                      />
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager
          base="/admin/photo/orders"
          page={page}
          hasNext={packageRows.length > LIMIT}
          params={{ sspage: ssPage > 1 ? String(ssPage) : undefined }}
        />
      </section>

      {/* Self-serve orders */}
      <section className="mt-12">
        <SectionHeading>Self-serve orders (/enhance)</SectionHeading>
        {selfServe.length === 0 ? (
          <EmptyState>No self-serve orders yet.</EmptyState>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[42rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-semibold">#</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Photos</th>
                  <th className="px-3 py-2 font-semibold">Total</th>
                  <th className="px-3 py-2 font-semibold">Created</th>
                  <th className="px-3 py-2 font-semibold">Completed</th>
                  <th className="px-3 py-2 font-semibold"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {selfServe.map((row) => (
                  <tr key={row.id} className="border-b border-stone-100">
                    <td className="px-3 py-2 tabular-nums">
                      <Link href={`/admin/photo/orders/${row.id}`} className="font-medium hover:underline" style={{ color: "var(--accent)" }}>
                        #{row.id}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Badge value={row.status} />
                    </td>
                    <td className="px-3 py-2 tabular-nums text-stone-700">{row.photoCount}</td>
                    <td className="px-3 py-2 tabular-nums font-medium">{formatPhotoCents(row.totalCents)}</td>
                    <td className="px-3 py-2 tabular-nums text-stone-600">{fmtDate(row.createdAt)}</td>
                    <td className="px-3 py-2 tabular-nums text-stone-600">{fmtDate(row.completedAt)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Link href={`/admin/photo/orders/${row.id}`} className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-black/[0.03]" style={{ borderColor: "var(--line)", color: "var(--c-text)" }}>
                          View
                        </Link>
                        {row.status === "failed" && <RetryOrderButton orderId={row.id} />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager
          base="/admin/photo/orders"
          page={ssPage}
          hasNext={selfServeRows.length > LIMIT}
          pageParam="sspage"
          params={{ page: page > 1 ? String(page) : undefined }}
        />
      </section>
    </>
  );
}
