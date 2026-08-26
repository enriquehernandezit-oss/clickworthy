import { notFound } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { enhancementOrders } from "@/db/schema";
import { formatCents } from "@/lib/pricing";
import { Badge, ConsoleCard, fmtDateTime } from "../../../ui";
import RetryOrderButton from "../RetryOrderButton";

// Full self-serve order dossier — the customer's prompt, uploaded originals, the
// enhanced results, and (crucially) per-photo error strings, none of which were
// visible anywhere before. Plus a Stripe deep link and the retry control.
export const dynamic = "force-dynamic";

type StoredPhoto = { originalName: string; contentType: string; url: string };
type OrderResult = { originalName: string; enhancedUrl: string | null; error: string | null };

// Session-id search is prefix-safe for both test + live mode.
function stripeUrl(sessionId: string): string {
  return `https://dashboard.stripe.com/search?query=${encodeURIComponent(sessionId)}`;
}

export default async function SelfServeOrderDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = Number(idStr);
  if (!Number.isInteger(id)) notFound();

  const [order] = await db.select().from(enhancementOrders).where(eq(enhancementOrders.id, id)).limit(1);
  if (!order) notFound();

  const photos = (order.photos as StoredPhoto[] | null) ?? [];
  const results = (order.results as OrderResult[] | null) ?? [];
  const resultFor = (name: string) => results.find((r) => r.originalName === name);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/admin/photo/orders" className="text-sm font-medium hover:underline" style={{ color: "var(--accent)" }}>
          &larr; Orders
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="font-display text-xl font-bold tracking-tight" style={{ color: "var(--c-text)" }}>
            Self-serve order #{order.id}
          </h2>
          <Badge value={order.status} />
        </div>
        <p className="mt-1 text-sm" style={{ color: "var(--c-text-muted)" }}>
          {order.photoCount} photo{order.photoCount === 1 ? "" : "s"} · {formatCents(order.totalCents)} · placed{" "}
          {fmtDateTime(order.createdAt)}
          {order.completedAt && <> · finished {fmtDateTime(order.completedAt)}</>}
        </p>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={stripeUrl(order.stripeSessionId)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-black/[0.03]"
          style={{ borderColor: "var(--line)", color: "var(--c-text)" }}
        >
          View payment in Stripe ↗
        </a>
        {order.status === "failed" && <RetryOrderButton orderId={order.id} />}
      </div>

      {/* Prompt */}
      <ConsoleCard title="Customer's instructions">
        <p className="whitespace-pre-wrap px-5 py-4 text-sm" style={{ color: "var(--c-text)" }}>
          {order.prompt}
        </p>
      </ConsoleCard>

      {/* Photos: original → enhanced, with errors surfaced */}
      <ConsoleCard title="Photos" sub={`${photos.length} uploaded · ${results.filter((r) => r.enhancedUrl).length} enhanced`}>
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          {photos.map((p, i) => {
            const r = resultFor(p.originalName);
            return (
              <div key={i} className="rounded-lg border p-3" style={{ borderColor: "var(--line)" }}>
                <div className="mb-2 truncate text-xs font-medium" style={{ color: "var(--c-text-muted)" }}>
                  {p.originalName}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Thumb label="Original" src={p.url} />
                  <Thumb label="Enhanced" src={r?.enhancedUrl ?? null} />
                </div>
                {r?.error && (
                  <div className="mt-2 rounded-md bg-coral/10 px-2.5 py-1.5 text-xs text-coral" role="alert">
                    {r.error}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ConsoleCard>
    </div>
  );
}

function Thumb({ label, src }: { label: string; src: string | null }) {
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="font-mono-label text-[10px] uppercase tracking-wider" style={{ color: "var(--c-text-faint)" }}>
        {label}
      </figcaption>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={label} className="aspect-square w-full rounded-md border object-cover" style={{ borderColor: "var(--line)" }} />
      ) : (
        <div
          className="flex aspect-square w-full items-center justify-center rounded-md border border-dashed text-xs"
          style={{ borderColor: "var(--line)", color: "var(--c-text-faint)" }}
        >
          —
        </div>
      )}
    </figure>
  );
}
