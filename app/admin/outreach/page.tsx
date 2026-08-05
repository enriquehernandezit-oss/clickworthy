import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { outreachJobs, restaurants } from "@/db/schema";
import { Badge, Card, EmptyState, Pager, SectionHeading, fmtDateTime } from "../ui";
import DraftActions, { ApproveAllButton } from "./DraftActions";

// Top: Touch-1 drafts awaiting your approval (nothing sends until you approve).
// Below: the full log of every email the pipeline has sent, with exact bodies.
export const dynamic = "force-dynamic";

const LIMIT = 25;
const STATUSES = ["draft", "approved", "sent", "bumped", "replied"] as const;

// Touch 1 and the bump are both touchNumber 1 — the bump is distinguished by
// status, so label from the pair rather than the number alone.
function touchLabel(touchNumber: number | null, status: string | null): string {
  if (status === "bumped") return "Bump (1.5)";
  if (touchNumber === 2) return "Touch 2";
  return "Touch 1";
}

// The review queue: Touch-1 rows drafted and awaiting approval, oldest first.
async function getDrafts() {
  return db
    .select({
      id: outreachJobs.id,
      subject: outreachJobs.subject,
      emailContent: outreachJobs.emailContent,
      draftedAt: outreachJobs.draftedAt,
      restaurantName: restaurants.name,
      city: restaurants.city,
      email: restaurants.email,
      language: restaurants.language,
    })
    .from(outreachJobs)
    .innerJoin(restaurants, eq(outreachJobs.restaurantId, restaurants.id))
    .where(eq(outreachJobs.status, "draft"))
    .orderBy(asc(outreachJobs.draftedAt));
}

async function getApprovedCount() {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(and(eq(outreachJobs.status, "approved"), sql`${outreachJobs.sentAt} is null`));
  return n ?? 0;
}

async function getJobs(status: string, page: number) {
  const where = status === "all" ? undefined : eq(outreachJobs.status, status);
  return db
    .select({
      id: outreachJobs.id,
      touchNumber: outreachJobs.touchNumber,
      status: outreachJobs.status,
      subject: outreachJobs.subject,
      draftedAt: outreachJobs.draftedAt,
      approvedAt: outreachJobs.approvedAt,
      sentAt: outreachJobs.sentAt,
      repliedAt: outreachJobs.repliedAt,
      emailContent: outreachJobs.emailContent,
      replyBody: outreachJobs.replyBody,
      replyFrom: outreachJobs.replyFrom,
      threadId: outreachJobs.gmailThreadId,
      restaurantName: restaurants.name,
      city: restaurants.city,
      email: restaurants.email,
      language: restaurants.language,
    })
    .from(outreachJobs)
    .leftJoin(restaurants, eq(outreachJobs.restaurantId, restaurants.id))
    .where(where ? and(where) : undefined)
    .orderBy(sql`coalesce(${outreachJobs.sentAt}, ${outreachJobs.draftedAt}) desc nulls last`, desc(outreachJobs.id))
    .limit(LIMIT + 1)
    .offset((page - 1) * LIMIT);
}

export default async function OutreachPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const status = typeof sp.status === "string" && (STATUSES as readonly string[]).includes(sp.status) ? sp.status : "all";
  const page = Math.max(1, Number(sp.page) || 1);

  const [drafts, approvedCount, rows] = await Promise.all([getDrafts(), getApprovedCount(), getJobs(status, page)]);
  const jobs = rows.slice(0, LIMIT);

  return (
    <>
      {/* Drafts awaiting approval */}
      <section className="mb-12">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeading>Drafts awaiting approval ({drafts.length})</SectionHeading>
          {drafts.length > 0 && <ApproveAllButton count={drafts.length} />}
        </div>

        {drafts.length === 0 ? (
          <EmptyState>
            No drafts right now. The nightly send job composes them; approve here and they send on the next run.
          </EmptyState>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            {drafts.map((d) => (
              <Card key={d.id} className="border-orange-200">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{d.restaurantName}</h3>
                    <Badge value="draft" />
                    {d.language === "es" && (
                      <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs font-medium text-stone-600">ES</span>
                    )}
                  </div>
                  <div className="text-xs tabular-nums text-stone-500">drafted {fmtDateTime(d.draftedAt)}</div>
                </div>
                <div className="mt-1 text-xs text-stone-500">
                  {d.email ?? "no email"}
                  {d.city ? ` · ${d.city}` : ""}
                </div>
                <p className="mt-3 text-sm font-semibold text-stone-900">{d.subject}</p>
                {d.emailContent && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm font-medium text-orange-700 hover:underline">
                      View email
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-stone-50 p-3 font-sans text-sm leading-relaxed text-stone-700">
                      {d.emailContent}
                    </pre>
                  </details>
                )}
                <DraftActions outreachJobId={d.id} />
              </Card>
            ))}
          </div>
        )}

        {approvedCount > 0 && (
          <p className="mt-4 text-sm text-stone-600">
            <a href="/admin/outreach?status=approved" className="font-medium text-orange-700 hover:underline">
              {approvedCount} approved
            </a>{" "}
            — sends on the next send run (subject to the daily cap).
          </p>
        )}
      </section>

      <section>
        <SectionHeading>Outreach log</SectionHeading>

      <div className="mt-3 flex flex-wrap gap-2">
        {(["all", ...STATUSES] as const).map((value) => (
          <a
            key={value}
            href={value === "all" ? "/admin/outreach" : `/admin/outreach?status=${value}`}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              status === value
                ? "border-orange-300 bg-orange-50 text-orange-700"
                : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100"
            }`}
          >
            {value === "all" ? "All" : value}
          </a>
        ))}
      </div>

      {jobs.length === 0 ? (
        <EmptyState>No outreach {status === "all" ? "" : `with status "${status}" `}yet.</EmptyState>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {jobs.map((job) => (
            <Card key={job.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{job.restaurantName ?? "(unknown restaurant)"}</h3>
                  <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs font-medium text-stone-600">
                    {touchLabel(job.touchNumber, job.status)}
                  </span>
                  <Badge value={job.status} />
                  {job.language === "es" && (
                    <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs font-medium text-stone-600">ES</span>
                  )}
                </div>
                <div className="text-xs tabular-nums text-stone-500">
                  {job.sentAt ? (
                    <>sent {fmtDateTime(job.sentAt)}</>
                  ) : job.approvedAt ? (
                    <>approved {fmtDateTime(job.approvedAt)}</>
                  ) : job.draftedAt ? (
                    <>drafted {fmtDateTime(job.draftedAt)}</>
                  ) : null}
                  {job.repliedAt && <> · replied {fmtDateTime(job.repliedAt)}</>}
                </div>
              </div>

              <div className="mt-1 text-xs text-stone-500">
                {job.email ?? "no email on file"}
                {job.city ? ` · ${job.city}` : ""}
              </div>

              {job.emailContent && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium text-orange-700 hover:underline">
                    View email
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-stone-50 p-3 font-sans text-sm leading-relaxed text-stone-700">
                    {job.emailContent}
                  </pre>
                </details>
              )}

              {job.replyBody && (
                <details className="mt-2" open>
                  <summary className="cursor-pointer text-sm font-medium text-orange-700 hover:underline">
                    Their reply
                    <span className="ml-2 font-normal text-stone-500">
                      {job.replyFrom} · {fmtDateTime(job.repliedAt)}
                    </span>
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-orange-100 bg-orange-50 p-3 font-sans text-sm leading-relaxed text-stone-800">
                    {job.replyBody}
                  </pre>
                </details>
              )}
            </Card>
          ))}
        </div>
      )}

        <Pager base="/admin/outreach" page={page} hasNext={rows.length > LIMIT} params={{ status }} />
      </section>
    </>
  );
}
