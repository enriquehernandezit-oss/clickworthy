import { desc } from "drizzle-orm";
import { db } from "@/db";
import { suppressions } from "@/db/schema";
import SuppressionActions, { AddSuppressionForm } from "./SuppressionActions";
import { Badge, EmptyState, Pager, SectionHeading, fmtDateTime } from "../../ui";

// The do-not-contact list the worker checks before every send. Hard bounces
// land here automatically. Opt-outs are a HUMAN call since 2026-08-27 (the
// footer no longer asks for a "STOP" keyword — see OPT_OUT_LINE in
// worker/lib/outreachEmail.ts): read the reply on the Outreach page, then
// suppress that restaurant. This page is also for adding someone who asked by
// phone/in person, and for undoing a mistake.
export const dynamic = "force-dynamic";

const LIMIT = 50;

async function getSuppressions(page: number) {
  return db
    .select({
      id: suppressions.id,
      email: suppressions.email,
      reason: suppressions.reason,
      createdAt: suppressions.createdAt,
    })
    .from(suppressions)
    .orderBy(desc(suppressions.createdAt))
    .limit(LIMIT + 1)
    .offset((page - 1) * LIMIT);
}

export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);

  const rows = await getSuppressions(page);
  const list = rows.slice(0, LIMIT);

  return (
    <section>
      <SectionHeading>Do not contact</SectionHeading>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Checked before every outreach send. Hard bounces are added automatically. If someone asks to be left alone in
        a reply, suppress them from the Outreach page — that part is a human call, so read the reply first.
      </p>

      <AddSuppressionForm />

      {list.length === 0 ? (
        <EmptyState>Nobody suppressed yet.</EmptyState>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[38rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-semibold">Email</th>
                <th className="px-3 py-2 font-semibold">Reason</th>
                <th className="px-3 py-2 font-semibold">Added</th>
                <th className="px-3 py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id} className="border-b border-line">
                  <td className="px-3 py-2 font-medium">{row.email}</td>
                  <td className="px-3 py-2">
                    <Badge value={row.reason} />
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted">{fmtDateTime(row.createdAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <SuppressionActions email={row.email} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager base="/admin/photo/suppressions" page={page} hasNext={rows.length > LIMIT} />
    </section>
  );
}
