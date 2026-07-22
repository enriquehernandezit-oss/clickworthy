import { eq } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks, restaurants } from "@/db/schema";
import Header from "../../components/Header";
import { getCopy } from "./copy";
import FunnelClient from "./FunnelClient";

export const dynamic = "force-dynamic";

// All DB access + time-dependent logic lives here (a plain async function, not a
// component) so the React-compiler purity rule doesn't flag new Date()/Date.now().
async function loadFunnel(token: string) {
  const [link] = await db
    .select({
      id: magicLinks.id,
      token: magicLinks.token,
      restaurantId: magicLinks.restaurantId,
      revenueImpactCopy: magicLinks.revenueImpactCopy,
      original: magicLinks.freeSampleOriginalUrl,
      enhanced: magicLinks.freeSampleEnhancedUrl,
      qualifyingPhotoCount: magicLinks.qualifyingPhotoCount,
      reviewStatus: magicLinks.reviewStatus,
      expiresAt: magicLinks.expiresAt,
      viewedAt: magicLinks.viewedAt,
    })
    .from(magicLinks)
    .where(eq(magicLinks.token, token))
    .limit(1);

  // A rejected or nonexistent link should read as "not found" — don't leak that
  // a token exists but was rejected.
  if (!link || link.reviewStatus === "rejected") return null;

  const [restaurant] = link.restaurantId
    ? await db.select().from(restaurants).where(eq(restaurants.id, link.restaurantId)).limit(1)
    : [];

  // Record first view (fire-and-forget; page still renders if it fails).
  if (!link.viewedAt) {
    await db.update(magicLinks).set({ viewedAt: new Date() }).where(eq(magicLinks.id, link.id)).catch(() => {});
  }

  const expired = link.expiresAt != null && new Date(link.expiresAt).getTime() < Date.now();
  return { link, restaurant, expired };
}

export default async function MagicLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const data = await loadFunnel(token);
  if (!data) return <NotFound />;
  const { link, restaurant, expired } = data;

  const language = restaurant?.language ?? "en";
  const copy = getCopy(language);

  return (
    <div className="flex min-h-full flex-col bg-stone-50 text-stone-900">
      <Header />
      <main className="flex-1">
        <section className="mx-auto max-w-4xl px-6 py-16 lg:px-8 lg:py-20">
          <p className="text-xs font-semibold uppercase tracking-wide text-orange-600">{copy.eyebrow}</p>
          <h1 className="mt-3 text-3xl font-bold [text-wrap:balance] [letter-spacing:-0.02em] sm:text-4xl">
            {restaurant?.name ?? "Your restaurant"}
          </h1>

          {expired ? (
            <p className="mt-8 rounded-xl border border-stone-200 bg-white px-5 py-4 text-stone-600">
              {copy.expired}
            </p>
          ) : !link.enhanced ? (
            <p className="mt-8 rounded-xl border border-stone-200 bg-white px-5 py-4 text-stone-600">
              {copy.notReady}
            </p>
          ) : (
            <FunnelClient
              token={link.token}
              language={language}
              revenueImpactCopy={link.revenueImpactCopy}
              originalUrl={link.original}
              enhancedUrl={link.enhanced}
              qualifyingPhotoCount={link.qualifyingPhotoCount ?? 0}
            />
          )}
        </section>
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex min-h-full flex-col bg-stone-50 text-stone-900">
      <Header />
      <main className="flex flex-1 items-center justify-center px-6 py-24">
        <p className="text-center text-stone-600">This link isn&apos;t available.</p>
      </main>
    </div>
  );
}
