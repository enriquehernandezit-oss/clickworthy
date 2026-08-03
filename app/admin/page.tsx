import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs, magicLinks } from "@/db/schema";
import SampleActions from "./SampleActions";
import PackageActions from "./PackageActions";

// Live internal dashboard — always render fresh (never statically prerender,
// which would try to hit the DB at build time).
export const dynamic = "force-dynamic";

type PackageResult = { name: string; originalUrl: string; enhancedUrl: string | null; error: string | null };

async function getStats() {
  const byStatus = await db
    .select({ status: restaurants.enrichmentStatus, n: sql<number>`count(*)::int` })
    .from(restaurants)
    .groupBy(restaurants.enrichmentStatus);
  const [{ touch1 }] = await db
    .select({ touch1: sql<number>`count(*) filter (where ${outreachJobs.touchNumber} = 1)::int` })
    .from(outreachJobs);
  const [{ replies }] = await db
    .select({ replies: sql<number>`count(*) filter (where ${outreachJobs.repliedAt} is not null)::int` })
    .from(outreachJobs);
  return { byStatus, touch1: touch1 ?? 0, replies: replies ?? 0 };
}

async function getSampleQueue() {
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
    .orderBy(desc(magicLinks.createdAt));
}

async function getPackageQueue() {
  return db
    .select({
      id: magicLinks.id,
      token: magicLinks.token,
      results: magicLinks.packageResults,
      restaurantName: restaurants.name,
    })
    .from(magicLinks)
    .leftJoin(restaurants, eq(magicLinks.restaurantId, restaurants.id))
    .where(eq(magicLinks.packageStatus, "ready_for_review"))
    .orderBy(desc(magicLinks.createdAt));
}

export default async function AdminPage() {
  const [stats, samples, packages] = await Promise.all([getStats(), getSampleQueue(), getPackageQueue()]);

  return (
    <div className="min-h-screen bg-stone-50 px-6 py-10 text-stone-900">
      <div className="mx-auto max-w-5xl">
        <h1 className="text-2xl font-bold tracking-tight">Clickworthy Admin</h1>

        {/* Pipeline stats */}
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Pipeline</h2>
          <div className="mt-3 flex flex-wrap gap-3">
            {stats.byStatus.map((s) => (
              <div key={s.status ?? "unknown"} className="rounded-lg border border-stone-200 bg-white px-4 py-3">
                <div className="text-xl font-bold tabular-nums">{s.n}</div>
                <div className="text-xs text-stone-500">{s.status ?? "unknown"}</div>
              </div>
            ))}
            <div className="rounded-lg border border-stone-200 bg-white px-4 py-3">
              <div className="text-xl font-bold tabular-nums">{stats.touch1}</div>
              <div className="text-xs text-stone-500">touch 1 sent</div>
            </div>
            <div className="rounded-lg border border-stone-200 bg-white px-4 py-3">
              <div className="text-xl font-bold tabular-nums">{stats.replies}</div>
              <div className="text-xs text-stone-500">replies</div>
            </div>
          </div>
        </section>

        {/* Free-sample production queue */}
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            New replies — needs editing ({samples.length})
          </h2>
          {samples.length === 0 && <p className="mt-3 text-sm text-stone-500">Nothing to edit right now.</p>}
          <div className="mt-4 flex flex-col gap-6">
            {samples.map((item) => (
              <div key={item.id} className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
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
              </div>
            ))}
          </div>
        </section>

        {/* Paid-order production queue */}
        <section className="mt-12">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            Paid orders — finish &amp; deliver ({packages.length})
          </h2>
          {packages.length === 0 && <p className="mt-3 text-sm text-stone-500">No paid orders waiting.</p>}
          <div className="mt-4 flex flex-col gap-6">
            {packages.map((pkg) => {
              const results = (pkg.results as PackageResult[] | null) ?? [];
              return (
                <div key={pkg.id} className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
                  <div className="flex items-baseline justify-between gap-4">
                    <h3 className="font-semibold">{pkg.restaurantName ?? "(unknown)"}</h3>
                    <span className="text-xs text-stone-500">{results.length} photos</span>
                  </div>
                  <PackageActions magicLinkId={pkg.id} results={results} />
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function Figure({ label, src }: { label: string; src: string | null }) {
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="text-xs font-medium text-stone-500">{label}</figcaption>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={label} className="aspect-square w-full rounded-lg border border-stone-200 object-cover" />
      ) : (
        <div className="flex aspect-square w-full items-center justify-center rounded-lg border border-dashed border-stone-200 text-xs text-stone-400">
          —
        </div>
      )}
    </figure>
  );
}
