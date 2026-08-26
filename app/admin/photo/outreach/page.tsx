import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { outreachJobs, restaurants } from "@/db/schema";
import { Badge, Card, EmptyState, Pager, SectionHeading, fmtDateTime } from "../../ui";
import UnapproveButton from "./UnapproveButton";

// The cold-outreach track's historical log — Touch 1, the bump, and manual
// one-off sends (same Gmail channel). Drafts awaiting a decision live on
// Approvals now, not here; this page is read-only, a record of what happened
// and what's queued to send next.
export const dynamic = "force-dynamic";

const LIMIT = 25;
const STATUSES = ["draft", "approved", "sent", "bumped", "denied", "replied"] as const;
const LOG_KINDS = ["touch1", "bump", "manual"] as const;

// `kind` is the real discriminator (touchNumber/status alone collide — a bump
// and a Touch 1 share touchNumber 1, and a NEW bump uses the ordinary
// draft/approved/sent status lifecycle, not a "bumped" status). status ===
// "bumped" is kept as a fallback for historical rows sent before `kind` existed.
function touchLabel(touchNumber: number | null, status: string | null, kind: string | null): string {
  if (kind === "bump" || status === "bumped") return "Bump (1.5)";
  if (kind === "manual") return "Manual";
  return "Touch 1";
}

async function getJobs(status: string, page: number) {
  const where = status === "all" ? inArray(outreachJobs.kind, LOG_KINDS) : and(inArray(outreachJobs.kind, LOG_KINDS), eq(outreachJobs.status, status));
  return db
    .select({
      id: outreachJobs.id,
      touchNumber: outreachJobs.touchNumber,
      status: outreachJobs.status,
      kind: outreachJobs.kind,
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
    .where(where)
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

  const rows = await getJobs(status, page);
  const jobs = rows.slice(0, LIMIT);

  return (
    <section>
      <SectionHeading>Outreach log</SectionHeading>
      <p className="mt-1 text-sm text-muted">
        Touch 1, the bump, and manual sends. Drafts awaiting your decision are on{" "}
        <a href="/admin/photo/approvals" className="font-medium text-gold hover:underline">
          Approvals
        </a>
        .
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {(["all", ...STATUSES] as const).map((value) => (
          <a
            key={value}
            href={value === "all" ? "/admin/photo/outreach" : `/admin/photo/outreach?status=${value}`}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              status === value
                ? "border-gold/40 bg-gold/10 text-gold"
                : "border-line bg-surface-2 text-text hover:bg-surface-2"
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
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-muted">
                    {touchLabel(job.touchNumber, job.status, job.kind)}
                  </span>
                  <Badge value={job.status} />
                  {job.language === "es" && (
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-muted">ES</span>
                  )}
                </div>
                <div className="text-xs tabular-nums text-muted">
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

              <div className="mt-1 text-xs text-muted">
                {job.email ?? "no email on file"}
                {job.city ? ` · ${job.city}` : ""}
              </div>

              {job.emailContent && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium text-gold hover:underline">
                    View email
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-sans text-sm leading-relaxed text-text">
                    {job.emailContent}
                  </pre>
                </details>
              )}

              {job.status === "approved" && !job.sentAt && <UnapproveButton outreachJobId={job.id} />}

              {job.replyBody && (
                <details className="mt-2" open>
                  <summary className="cursor-pointer text-sm font-medium text-gold hover:underline">
                    Their reply
                    <span className="ml-2 font-normal text-muted">
                      {job.replyFrom} · {fmtDateTime(job.repliedAt)}
                    </span>
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-gold/40 bg-gold/10 p-3 font-sans text-sm leading-relaxed text-text">
                    {job.replyBody}
                  </pre>
                  {job.threadId && (
                    <a
                      href={`https://mail.google.com/mail/u/0/#all/${job.threadId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-block text-xs font-medium text-gold hover:underline"
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

      <Pager base="/admin/photo/outreach" page={page} hasNext={rows.length > LIMIT} params={{ status }} />
    </section>
  );
}
