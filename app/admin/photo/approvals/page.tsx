import Link from "next/link";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { outreachJobs, restaurants } from "@/db/schema";
import { Badge, Card, EmptyState, Pager, SectionHeading, fmtDateTime } from "../../ui";
import DraftActions, { ApproveAllButton } from "../outreach/DraftActions";
import BumpDraftActions from "./BumpDraftActions";
import ReplyDraftActions from "./ReplyDraftActions";
import PaymentConfirmationDraftActions from "./PaymentConfirmationDraftActions";

// The single "approve or deny" surface for every email kind that needs a
// human in the loop before it sends: Touch 1, the bump, a reply, and a
// payment confirmation. Touch 2 and delivery aren't here — both are reviewed
// and sent in one screen at the moment they're triggered (Samples / Orders),
// so there's never a queued draft for them to sit in.
export const dynamic = "force-dynamic";

const LIMIT = 25;
const ASYNC_KINDS = ["touch1", "bump", "reply", "payment_confirmation"] as const;
const HANDLED_STATUSES = ["approved", "sent", "denied", "cancelled"] as const;

function kindLabel(kind: string | null): string {
  switch (kind) {
    case "touch1":
      return "Touch 1";
    case "bump":
      return "Bump (1.5)";
    case "reply":
      return "Reply";
    case "payment_confirmation":
      return "Payment confirmation";
    default:
      return kind ?? "—";
  }
}

async function getQueue() {
  return db
    .select({
      id: outreachJobs.id,
      kind: outreachJobs.kind,
      subject: outreachJobs.subject,
      emailContent: outreachJobs.emailContent,
      replyBody: outreachJobs.replyBody,
      replyFrom: outreachJobs.replyFrom,
      draftedAt: outreachJobs.draftedAt,
      restaurantId: restaurants.id,
      restaurantName: restaurants.name,
      city: restaurants.city,
      language: restaurants.language,
      signatureDish: restaurants.signatureDish,
    })
    .from(outreachJobs)
    .innerJoin(restaurants, eq(outreachJobs.restaurantId, restaurants.id))
    .where(and(inArray(outreachJobs.kind, ASYNC_KINDS), eq(outreachJobs.status, "draft")))
    // Oldest first — work through the pile in order, same as Touch 1's old queue.
    .orderBy(asc(outreachJobs.draftedAt))
    .limit(100);
}

async function getHistory(page: number) {
  return db
    .select({
      id: outreachJobs.id,
      kind: outreachJobs.kind,
      status: outreachJobs.status,
      subject: outreachJobs.subject,
      emailContent: outreachJobs.emailContent,
      draftedAt: outreachJobs.draftedAt,
      approvedAt: outreachJobs.approvedAt,
      sentAt: outreachJobs.sentAt,
      restaurantName: restaurants.name,
      city: restaurants.city,
    })
    .from(outreachJobs)
    .innerJoin(restaurants, eq(outreachJobs.restaurantId, restaurants.id))
    .where(and(inArray(outreachJobs.kind, ASYNC_KINDS), inArray(outreachJobs.status, HANDLED_STATUSES)))
    .orderBy(sql`coalesce(${outreachJobs.sentAt}, ${outreachJobs.approvedAt}, ${outreachJobs.draftedAt}) desc nulls last`, desc(outreachJobs.id))
    .limit(LIMIT + 1)
    .offset((page - 1) * LIMIT);
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);

  const [queue, historyRows] = await Promise.all([getQueue(), getHistory(page)]);
  const history = historyRows.slice(0, LIMIT);
  const touch1DraftCount = queue.filter((d) => d.kind === "touch1").length;

  return (
    <>
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeading>Awaiting your approval ({queue.length})</SectionHeading>
          {touch1DraftCount > 0 && (
            <div className="flex items-center gap-2">
              <ApproveAllButton count={touch1DraftCount} />
              <span className="text-xs text-stone-500">Touch 1 only — everything else still needs individual review.</span>
            </div>
          )}
        </div>
        {queue.length === 0 ? (
          <EmptyState>Nothing waiting right now.</EmptyState>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            {queue.map((d) => (
              <Card key={d.id} className="border-orange-200">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">
                      <Link
                        href={`/admin/photo/restaurants/${d.restaurantId}`}
                        target="_blank"
                        className="text-stone-900 hover:text-orange-700 hover:underline"
                      >
                        {d.restaurantName} ↗
                      </Link>
                    </h3>
                    <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs font-medium text-stone-600">
                      {kindLabel(d.kind)}
                    </span>
                    {d.language === "es" && (
                      <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs font-medium text-stone-600">ES</span>
                    )}
                    {d.kind === "touch1" && !d.signatureDish && (
                      <span
                        className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700"
                        title="No signature dish on file — this draft uses generic wording. Open the profile to add one."
                      >
                        generic — no dish
                      </span>
                    )}
                  </div>
                  <div className="text-xs tabular-nums text-stone-500">drafted {fmtDateTime(d.draftedAt)}</div>
                </div>
                {d.city && <div className="mt-1 text-xs text-stone-500">{d.city}</div>}

                {d.kind === "touch1" && (
                  <>
                    <p className="mt-3 text-sm font-semibold text-stone-900">{d.subject}</p>
                    <DraftActions outreachJobId={d.id} subject={d.subject ?? ""} body={d.emailContent ?? ""} />
                  </>
                )}
                {d.kind === "bump" && <BumpDraftActions outreachJobId={d.id} body={d.emailContent ?? ""} />}
                {d.kind === "reply" && (
                  <ReplyDraftActions outreachJobId={d.id} quotedMessage={d.replyBody ?? ""} quotedFrom={d.replyFrom} />
                )}
                {d.kind === "payment_confirmation" && (
                  <PaymentConfirmationDraftActions
                    outreachJobId={d.id}
                    subject={d.subject ?? ""}
                    body={d.emailContent ?? ""}
                  />
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="mt-12">
        <SectionHeading>Recently handled</SectionHeading>
        {history.length === 0 ? (
          <EmptyState>Nothing handled yet.</EmptyState>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {history.map((row) => (
              <Card key={row.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{row.restaurantName ?? "(unknown restaurant)"}</h3>
                    <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs font-medium text-stone-600">
                      {kindLabel(row.kind)}
                    </span>
                    <Badge value={row.status} />
                  </div>
                  <div className="text-xs tabular-nums text-stone-500">
                    {row.sentAt ? (
                      <>sent {fmtDateTime(row.sentAt)}</>
                    ) : row.approvedAt ? (
                      <>approved {fmtDateTime(row.approvedAt)}</>
                    ) : (
                      <>drafted {fmtDateTime(row.draftedAt)}</>
                    )}
                  </div>
                </div>
                {row.city && <div className="mt-1 text-xs text-stone-500">{row.city}</div>}
                {row.subject && <p className="mt-2 text-sm font-semibold text-stone-900">{row.subject}</p>}
                {row.emailContent && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm font-medium text-orange-700 hover:underline">
                      View email
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-stone-50 p-3 font-sans text-sm leading-relaxed text-stone-700">
                      {row.emailContent}
                    </pre>
                  </details>
                )}
              </Card>
            ))}
          </div>
        )}
        <Pager base="/admin/photo/approvals" page={page} hasNext={historyRows.length > LIMIT} />
      </section>
    </>
  );
}
