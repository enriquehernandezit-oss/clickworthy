import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { outreachJobs, restaurants } from "@/db/schema";
import { Badge, Card, EmptyState, Pager, SectionHeading, fmtDateTime } from "../ui";

// Every email the pipeline has sent, newest first, with the exact body that
// went out. This is the record you check when a restaurant replies asking
// "what did you send me?" — or when copy changes and you want to see it live.
export const dynamic = "force-dynamic";

const LIMIT = 25;
const STATUSES = ["sent", "bumped", "replied"] as const;

// Touch 1 and the bump are both touchNumber 1 — the bump is distinguished by
// status, so label from the pair rather than the number alone.
function touchLabel(touchNumber: number | null, status: string | null): string {
  if (status === "bumped") return "Bump (1.5)";
  if (touchNumber === 2) return "Touch 2";
  return "Touch 1";
}

async function getJobs(status: string, page: number) {
  const where = status === "all" ? undefined : eq(outreachJobs.status, status);
  return db
    .select({
      id: outreachJobs.id,
      touchNumber: outreachJobs.touchNumber,
      status: outreachJobs.status,
      sentAt: outreachJobs.sentAt,
      repliedAt: outreachJobs.repliedAt,
      emailContent: outreachJobs.emailContent,
      threadId: outreachJobs.gmailThreadId,
      restaurantName: restaurants.name,
      city: restaurants.city,
      email: restaurants.email,
      language: restaurants.language,
    })
    .from(outreachJobs)
    .leftJoin(restaurants, eq(outreachJobs.restaurantId, restaurants.id))
    .where(where ? and(where) : undefined)
    .orderBy(sql`${outreachJobs.sentAt} desc nulls last`, desc(outreachJobs.id))
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
                  sent {fmtDateTime(job.sentAt)}
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
            </Card>
          ))}
        </div>
      )}

      <Pager base="/admin/outreach" page={page} hasNext={rows.length > LIMIT} params={{ status }} />
    </section>
  );
}
