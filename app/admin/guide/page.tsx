import Link from "next/link";
import { getNeedsAttention } from "@/lib/photoStats";
import { ConsoleCard, Pill } from "../ui";
import {
  DAILY_STEPS,
  COLD_OUTREACH_FLOW,
  ADMIN_INITIATED_FLOW,
  PHOTO_TABS,
  CONSOLE_TABS,
  RULES,
  TROUBLESHOOTING,
  JUDGMENT_ROUTINE,
  JUDGMENT_CHECK_IN,
  GLOSSARY,
  type SaleStep,
  type TabDoc,
} from "./content";

// Operations guide for whoever's running the console day to day. Unlike
// app/admin/photo/*, app/admin/layout.tsx renders NO page heading of its own —
// same as /admin/financials — so this page owns its eyebrow + <h1>.
export const dynamic = "force-dynamic";

export default async function GuidePage() {
  const attention = await getNeedsAttention();

  return (
    <div className="flex flex-col gap-10">
      <div>
        <div className="font-mono-label text-[11px] uppercase tracking-wider" style={{ color: "var(--c-text-muted)" }}>
          Operations guide
        </div>
        <h1 className="font-display text-[22px] font-bold tracking-tight" style={{ color: "var(--c-text)" }}>
          How to run ClickWorthy
        </h1>
        <p className="mt-1 max-w-2xl text-sm" style={{ color: "var(--c-text-muted)" }}>
          Everything below is a reference — it doesn&apos;t go stale on its own, but the counts in the first
          section are live right now.
        </p>
      </div>

      {/* 1 — Your day, in order */}
      <section>
        <h2 className="font-display text-base font-semibold" style={{ color: "var(--c-text)" }}>
          Your day, in order
        </h2>
        <div className="mt-3 flex flex-col gap-3">
          {DAILY_STEPS.map((step, i) => {
            const liveItem = attention.find((a) => a.href === step.href);
            return (
              <Link
                key={step.title}
                href={step.href}
                className="flex items-start gap-3 rounded-xl border p-4 transition-colors hover:bg-black/[0.02]"
                style={{ background: "var(--card)", borderColor: "var(--line)" }}
              >
                <span
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full font-mono-label text-[11px] font-bold"
                  style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold" style={{ color: "var(--c-text)" }}>
                      {step.title}
                    </span>
                    {liveItem && <Pill tone={liveItem.tone}>{liveItem.n}</Pill>}
                  </div>
                  <p className="mt-0.5 text-xs" style={{ color: "var(--c-text-muted)" }}>
                    {step.detail}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
        {attention.length === 0 ? (
          <p className="mt-3 text-xs" style={{ color: "var(--c-text-faint)" }}>
            Nothing&apos;s waiting right now — the counts above will light up as work comes in.
          </p>
        ) : (
          <p className="mt-3 text-xs" style={{ color: "var(--c-text-faint)" }}>
            The pill on each step is live — same numbers as{" "}
            <Link href="/admin" className="underline">
              Overview
            </Link>
            &apos;s Needs Attention list.
          </p>
        )}
      </section>

      {/* 2 — The full sale, end to end */}
      <section>
        <h2 className="font-display text-base font-semibold" style={{ color: "var(--c-text)" }}>
          The full sale, end to end
        </h2>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <SaleFlowCard title="Cold outreach (automated)" steps={COLD_OUTREACH_FLOW} />
          <SaleFlowCard title="Deal closed off-pipeline (call, referral...)" steps={ADMIN_INITIATED_FLOW} />
        </div>
      </section>

      {/* 3 — What each tab does */}
      <section>
        <h2 className="font-display text-base font-semibold" style={{ color: "var(--c-text)" }}>
          What each tab does
        </h2>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <TabList title="Console" tabs={CONSOLE_TABS} />
          <TabList title="Photo Enhancement" tabs={PHOTO_TABS} />
        </div>
      </section>

      {/* 4 — Rules that must not be broken */}
      <section>
        <h2 className="font-display text-base font-semibold" style={{ color: "var(--c-text)" }}>
          Rules that must not be broken
        </h2>
        <ConsoleCard>
          <ul className="flex flex-col gap-2.5 p-5">
            {RULES.map((rule, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm" style={{ color: "var(--c-text)" }}>
                <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: "var(--coral)" }} />
                {rule}
              </li>
            ))}
          </ul>
        </ConsoleCard>
      </section>

      {/* 5 — When something looks wrong */}
      <section>
        <h2 className="font-display text-base font-semibold" style={{ color: "var(--c-text)" }}>
          When something looks wrong
        </h2>
        <ConsoleCard>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse text-sm">
              <thead>
                <tr
                  className="border-b text-left text-xs uppercase tracking-wide"
                  style={{ borderColor: "var(--line)", color: "var(--c-text-muted)" }}
                >
                  <th scope="col" className="px-5 py-2 font-semibold">
                    Symptom
                  </th>
                  <th scope="col" className="px-5 py-2 font-semibold">
                    What&apos;s happening
                  </th>
                  <th scope="col" className="px-5 py-2 font-semibold">
                    What to do
                  </th>
                </tr>
              </thead>
              <tbody>
                {TROUBLESHOOTING.map((row) => (
                  <tr key={row.symptom} className="border-b align-top" style={{ borderColor: "var(--line)" }}>
                    <td className="px-5 py-3 font-medium" style={{ color: "var(--c-text)" }}>
                      {row.symptom}
                    </td>
                    <td className="px-5 py-3" style={{ color: "var(--c-text-muted)" }}>
                      {row.whatsHappening}
                    </td>
                    <td className="px-5 py-3" style={{ color: "var(--c-text)" }}>
                      {row.whatToDo}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ConsoleCard>
      </section>

      {/* 6 — Judgment calls */}
      <section>
        <h2 className="font-display text-base font-semibold" style={{ color: "var(--c-text)" }}>
          Judgment calls
        </h2>
        <p className="mt-1 max-w-2xl text-sm" style={{ color: "var(--c-text-muted)" }}>
          You and Enrique have the same access — this is about what&apos;s routine to just do versus what&apos;s
          worth a quick heads-up, not what you&apos;re allowed to click.
        </p>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <ConsoleCard title="Just do it" sub="Routine operations">
            <ul className="flex flex-col gap-3 p-5">
              {JUDGMENT_ROUTINE.map((row) => (
                <li key={row.action} className="text-sm">
                  <div className="font-medium" style={{ color: "var(--c-text)" }}>
                    {row.action}
                  </div>
                  <div className="mt-0.5 text-xs" style={{ color: "var(--c-text-muted)" }}>
                    {row.note}
                  </div>
                </li>
              ))}
            </ul>
          </ConsoleCard>
          <ConsoleCard title="Worth a heads-up" sub="Quick check-in with Enrique">
            <ul className="flex flex-col gap-3 p-5">
              {JUDGMENT_CHECK_IN.map((row) => (
                <li key={row.action} className="text-sm">
                  <div className="font-medium" style={{ color: "var(--c-text)" }}>
                    {row.action}
                  </div>
                  <div className="mt-0.5 text-xs" style={{ color: "var(--c-text-muted)" }}>
                    {row.note}
                  </div>
                </li>
              ))}
            </ul>
          </ConsoleCard>
        </div>
      </section>

      {/* 7 — Glossary */}
      <section>
        <h2 className="font-display text-base font-semibold" style={{ color: "var(--c-text)" }}>
          Glossary
        </h2>
        <ConsoleCard>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 p-5 sm:grid-cols-2">
            {GLOSSARY.map((g) => (
              <div key={g.term}>
                <dt className="text-sm font-semibold" style={{ color: "var(--c-text)" }}>
                  {g.term}
                </dt>
                <dd className="mt-0.5 text-xs" style={{ color: "var(--c-text-muted)" }}>
                  {g.definition}
                </dd>
              </div>
            ))}
          </dl>
        </ConsoleCard>
      </section>
    </div>
  );
}

function SaleFlowCard({ title, steps }: { title: string; steps: SaleStep[] }) {
  return (
    <ConsoleCard title={title}>
      <ol className="flex flex-col gap-3 p-5">
        {steps.map((step, i) => (
          <li key={step.title} className="flex items-start gap-2.5 text-sm">
            <span
              className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full font-mono-label text-[10px] font-bold"
              style={{ background: "var(--paper)", color: "var(--c-text-muted)" }}
            >
              {i + 1}
            </span>
            <div>
              <div className="font-medium" style={{ color: "var(--c-text)" }}>
                {step.title}
              </div>
              <div className="mt-0.5 text-xs" style={{ color: "var(--c-text-muted)" }}>
                {step.detail}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </ConsoleCard>
  );
}

function TabList({ title, tabs }: { title: string; tabs: TabDoc[] }) {
  return (
    <ConsoleCard title={title}>
      <ul className="flex flex-col">
        {tabs.map((tab) => (
          <li key={tab.href} className="border-b px-5 py-3 last:border-b-0" style={{ borderColor: "var(--line)" }}>
            <Link href={tab.href} className="text-sm font-semibold hover:underline" style={{ color: "var(--c-text)" }}>
              {tab.label}
            </Link>
            <p className="mt-0.5 text-xs" style={{ color: "var(--c-text-muted)" }}>
              {tab.detail}
            </p>
          </li>
        ))}
      </ul>
    </ConsoleCard>
  );
}
