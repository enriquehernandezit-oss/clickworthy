import { notFound } from "next/navigation";
import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs, magicLinks } from "@/db/schema";
import { Badge, Card, EmptyState, SectionHeading, fmtDate, fmtDateTime } from "../../../ui";
import RestaurantActions from "../RestaurantActions";
import ComposeForm from "./ComposeForm";
import EditFields from "./EditFields";

export const dynamic = "force-dynamic";

// Full dossier for one restaurant — every field, an inline edit form, its whole
// outreach timeline (with reply bodies), and its magic links. The name in the
// restaurants table links here.
async function load(id: number) {
  const [r] = await db.select().from(restaurants).where(eq(restaurants.id, id)).limit(1);
  if (!r) return null;

  // Caps below prevent one very-active restaurant from rendering hundreds of
  // full email bodies. A restaurant that outgrows these limits is an outlier
  // worth investigating anyway.
  const timeline = await db
    .select()
    .from(outreachJobs)
    .where(eq(outreachJobs.restaurantId, id))
    .orderBy(sql`coalesce(${outreachJobs.sentAt}, ${outreachJobs.approvedAt}, ${outreachJobs.draftedAt}) desc nulls last`, desc(outreachJobs.id))
    .limit(50);

  const links = await db
    .select()
    .from(magicLinks)
    .where(eq(magicLinks.restaurantId, id))
    .orderBy(desc(magicLinks.createdAt))
    .limit(20);

  return { r, timeline, links };
}

function touchLabel(touchNumber: number | null, status: string | null): string {
  if (touchNumber === 0) return "Manual";
  if (status === "bumped") return "Bump (1.5)";
  if (touchNumber === 2) return "Touch 2";
  return "Touch 1";
}

export default async function RestaurantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = Number(idStr);
  if (!Number.isInteger(id)) notFound();

  const data = await load(id);
  if (!data) notFound();
  const { r, timeline, links } = data;

  return (
    <div className="flex flex-col gap-10">
      <div>
        <Link href="/admin/photo/restaurants" className="text-sm text-orange-700 hover:underline">
          &larr; All restaurants
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-bold tracking-tight">{r.name}</h2>
          <Badge value={r.enrichmentStatus} />
          {r.suppressed && <span className="text-sm font-medium text-red-600">suppressed</span>}
          {r.held && <span className="text-sm font-medium text-amber-600">held</span>}
        </div>
        <p className="mt-1 text-sm text-stone-500">
          {r.city ?? "—"}
          {r.language === "es" && " · ES"}
        </p>
        {r.enrichmentStatus === "rejected" && r.rejectionReason && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <span className="font-semibold">Why rejected:</span> {r.rejectionReason}
          </div>
        )}
      </div>

      {/* Dossier */}
      <section>
        <SectionHeading>Details</SectionHeading>
        <Card className="mt-3">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
            <Row label="Rating" value={r.rating == null ? "—" : `${r.rating} (${r.reviewCount ?? 0} reviews)`} />
            <Row label="Price level" value={r.priceLevel == null ? "—" : "$".repeat(r.priceLevel)} />
            <Row label="Phone" value={r.phone ?? "—"} />
            <Row
              label="Website"
              value={
                r.website ? (
                  <a href={r.website} target="_blank" rel="noopener noreferrer" className="text-orange-700 hover:underline">
                    open ↗
                  </a>
                ) : (
                  "—"
                )
              }
            />
            <Row label="Email source" value={r.emailSource ?? "—"} />
            <Row label="Email rank" value={r.emailRank == null ? "—" : String(r.emailRank)} />
            <Row label="Photos on Google" value={r.photoCount == null ? "—" : String(r.photoCount)} />
            <Row label="Avg photo score" value={r.avgPhotoScore == null ? "—" : r.avgPhotoScore.toFixed(1)} />
            <Row label="Priority score" value={r.priorityScore == null ? "—" : r.priorityScore.toFixed(1)} />
            <Row label="Delivery enabled" value={r.deliveryEnabled ? "yes" : "no"} />
            <Row label="New opening" value={r.isNewOpening ? "yes" : "no"} />
            <Row label="Sourced" value={fmtDate(r.createdAt)} />
            <Row label="Last contacted" value={fmtDate(r.lastContactedAt)} />
          </dl>
        </Card>
      </section>

      {/* Edit */}
      <section>
        <SectionHeading>Edit</SectionHeading>
        <Card className="mt-3">
          <EditFields
            restaurantId={r.id}
            email={r.email}
            signatureDish={r.signatureDish}
            contactFirstName={r.contactFirstName}
            language={r.language ?? "en"}
          />
        </Card>
      </section>

      {/* Actions */}
      <section>
        <SectionHeading>Actions</SectionHeading>
        <div className="mt-3">
          <RestaurantActions
            restaurantId={r.id}
            email={r.email}
            suppressed={Boolean(r.suppressed)}
            needsEmail={r.enrichmentStatus === "needs_manual_email"}
            held={Boolean(r.held)}
            rejected={r.enrichmentStatus === "rejected"}
            showEmail={false}
          />
        </div>
      </section>

      {/* Manual one-off email */}
      <section>
        <SectionHeading>Send an email</SectionHeading>
        <div className="mt-3">
          <ComposeForm restaurantId={r.id} hasEmail={Boolean(r.email)} />
        </div>
      </section>

      {/* Outreach timeline */}
      <section>
        <SectionHeading>Outreach timeline</SectionHeading>
        {timeline.length === 0 ? (
          <EmptyState>No outreach yet.</EmptyState>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {timeline.map((j) => (
              <Card key={j.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs font-medium text-stone-600">
                    {touchLabel(j.touchNumber, j.status)}
                  </span>
                  <Badge value={j.status} />
                  <span className="text-xs tabular-nums text-stone-500">
                    {j.sentAt
                      ? `sent ${fmtDateTime(j.sentAt)}`
                      : j.approvedAt
                        ? `approved ${fmtDateTime(j.approvedAt)}`
                        : j.draftedAt
                          ? `drafted ${fmtDateTime(j.draftedAt)}`
                          : ""}
                    {j.repliedAt && ` · replied ${fmtDateTime(j.repliedAt)}`}
                  </span>
                </div>
                {j.subject && <p className="mt-2 text-sm font-semibold text-stone-900">{j.subject}</p>}
                {j.emailContent && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-sm font-medium text-orange-700 hover:underline">Email</summary>
                    <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-stone-50 p-3 font-sans text-sm leading-relaxed text-stone-700">
                      {j.emailContent}
                    </pre>
                  </details>
                )}
                {j.replyBody && (
                  <details className="mt-1" open>
                    <summary className="cursor-pointer text-sm font-medium text-orange-700 hover:underline">Their reply</summary>
                    <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-orange-100 bg-orange-50 p-3 font-sans text-sm leading-relaxed text-stone-800">
                      {j.replyBody}
                    </pre>
                    {j.gmailThreadId && (
                      <a
                        href={`https://mail.google.com/mail/u/0/#all/${j.gmailThreadId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-block text-xs font-medium text-orange-700 hover:underline"
                      >
                        Open in Gmail ↗
                      </a>
                    )}
                  </details>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Magic links */}
      <section>
        <SectionHeading>Magic links</SectionHeading>
        {links.length === 0 ? (
          <EmptyState>No magic links (created when they reply with a photo).</EmptyState>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {links.map((l) => (
              <Card key={l.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge value={l.reviewStatus} />
                  {l.packageStatus && <Badge value={l.packageStatus} />}
                  {l.packageSelected && (
                    <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs font-medium text-stone-600">
                      {l.packageSelected}
                    </span>
                  )}
                  <a
                    href={`/l/${l.token}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-orange-700 hover:underline"
                  >
                    open funnel ↗
                  </a>
                </div>
                <div className="mt-1 text-xs tabular-nums text-stone-500">
                  created {fmtDate(l.createdAt)}
                  {l.viewedAt && ` · viewed ${fmtDate(l.viewedAt)}`}
                  {l.touch2SentAt && ` · sample sent ${fmtDate(l.touch2SentAt)}`}
                  {l.paidAt && ` · PAID ${fmtDate(l.paidAt)}`}
                  {l.deliveredAt && ` · delivered ${fmtDate(l.deliveredAt)}`}
                  {l.expiresAt && (
                    (() => {
                      const days = Math.floor((l.expiresAt.getTime() - Date.now()) / 86_400_000);
                      const expired = days < 0;
                      return (
                        <span className={`ml-1 font-medium ${expired ? "text-red-600" : days <= 3 ? "text-amber-600" : "text-stone-500"}`}>
                          {" · "}{expired ? `EXPIRED ${-days}d ago` : `expires in ${days}d`}
                        </span>
                      );
                    })()
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-stone-100 py-1.5">
      <dt className="text-stone-500">{label}</dt>
      <dd className="text-right font-medium text-stone-900">{value}</dd>
    </div>
  );
}
