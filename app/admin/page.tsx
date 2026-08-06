import Link from "next/link";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { outreachJobs, magicLinks } from "@/db/schema";

// Company overview — the venture switcher's home. G3 fleshes out aggregate KPIs
// and a cross-venture "needs attention" list; today it shows the product grid
// with live status for Photo (the only built venture) and "not built yet" for
// the rest, plus Photo's real headline numbers.
export const dynamic = "force-dynamic";

async function getPhotoStats() {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [{ sent }] = await db
    .select({ sent: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(and(eq(outreachJobs.touchNumber, 1), eq(outreachJobs.status, "sent"), gte(outreachJobs.sentAt, weekAgo)));
  const [{ replied }] = await db
    .select({ replied: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(gte(outreachJobs.repliedAt, weekAgo));
  const [{ paid }] = await db
    .select({ paid: sql<number>`count(*) filter (where ${magicLinks.paidAt} is not null)::int` })
    .from(magicLinks);
  return { sent: sent ?? 0, replied: replied ?? 0, paid: paid ?? 0 };
}

type Product = {
  slug: string;
  name: string;
  desc: string;
  accent: string;
  accentSoft: string;
  live: boolean;
  icon: React.ReactNode;
};

export default async function CompanyOverview() {
  const photo = await getPhotoStats();

  const products: Product[] = [
    {
      slug: "photo",
      name: "Photo Enhancement",
      desc: "High-ticket AI photo enhancement for restaurants and SMEs.",
      accent: "#E3A83B",
      accentSoft: "#FBF0DA",
      live: true,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
          <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
          <circle cx="12" cy="13.5" r="3.5" />
        </svg>
      ),
    },
    {
      slug: "hvac",
      name: "HVAC AI Appointment Setter",
      desc: "Rev-share on booked appointments for HVAC companies.",
      accent: "#2F7A6F",
      accentSoft: "#E1EEEB",
      live: false,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
          <path d="M12 2v20M2 12h20M5.5 5.5l13 13M18.5 5.5l-13 13" />
        </svg>
      ),
    },
    {
      slug: "analytics",
      name: "AI SMB Analytics Dashboard",
      desc: "High-ticket entryway; cross-sells into the full suite.",
      accent: "#6B5CA5",
      accentSoft: "#EAE6F5",
      live: false,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
          <path d="M4 20V10M12 20V4M20 20v-7" />
        </svg>
      ),
    },
    {
      slug: "realestate",
      name: "RE Broker Listing Videos",
      desc: "Mid-to-high ticket listing video production for brokers.",
      accent: "#C1583F",
      accentSoft: "#F6E4DF",
      live: false,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
          <path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V10z" />
        </svg>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-6">
        <div className="font-mono-label text-[11px] uppercase tracking-wider text-[var(--c-text-muted)]">All products</div>
        <h1 className="font-display text-[22px] font-bold tracking-tight text-[var(--c-text)]">Business overview</h1>
        <p className="mt-1 max-w-xl text-sm text-[var(--c-text-muted)]">
          Every ClickWorthy venture in one console. Pick a product to manage its outreach and delivery.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {products.map((p) => (
          <Link
            key={p.slug}
            href={`/admin/${p.slug}`}
            className="group rounded-xl border p-5 transition-all hover:-translate-y-0.5"
            style={{ background: "var(--card)", borderColor: "var(--line)" }}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="font-display text-[15px] font-bold text-[var(--c-text)]">{p.name}</div>
                <div className="mt-1 text-xs text-[var(--c-text-muted)]">{p.desc}</div>
              </div>
              <div className="flex h-[38px] w-[38px] items-center justify-center rounded-[10px]" style={{ background: p.accentSoft, color: p.accent }}>
                {p.icon}
              </div>
            </div>

            <div className="mt-4 flex items-center gap-6 border-t pt-3.5" style={{ borderColor: "var(--line)" }}>
              {p.live ? (
                <>
                  <Stat label="Sent (7d)" value={photo.sent} />
                  <Stat label="Replies (7d)" value={photo.replied} />
                  <Stat label="Paid" value={photo.paid} />
                </>
              ) : (
                <span
                  className="rounded-md px-2 py-1 font-mono-label text-[10px] font-semibold uppercase tracking-wider"
                  style={{ background: p.accentSoft, color: p.accent }}
                >
                  Not built yet
                </span>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="font-mono-label text-[10px] uppercase tracking-wider text-[var(--c-text-muted)]">{label}</div>
      <div className="font-display text-base font-bold tabular-nums text-[var(--c-text)]">{value}</div>
    </div>
  );
}
