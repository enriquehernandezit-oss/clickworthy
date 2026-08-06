import Link from "next/link";
import { ENV_KEYS, WEB_ENV_KEYS, envPresence } from "@/lib/envKeys";
import { getSetting } from "@/lib/settings";
import { ConsoleCard, Pill, SectionHeading } from "../../ui";

// Go-live checklist. For every env var we track, report SET/MISSING on both the
// web service (read directly, this file runs there) and the worker service
// (from the boot-info snapshot published by worker/index.ts on start).
// **Never renders values — booleans only.**
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const webPresent = envPresence(WEB_ENV_KEYS);
  const boot = await getSetting("worker_boot_info");
  const workerPresent = boot?.envPresent ?? {};

  // A key is "OK" if every scope that needs it can see it. Optional keys count
  // as OK when missing (they degrade gracefully); required keys don't.
  function status(name: string, scope: "web" | "worker" | "both", required: boolean): {
    label: string; tone: "teal" | "coral" | "gray"; note?: string;
  } {
    const needsWeb = scope !== "worker";
    const needsWorker = scope !== "web";
    const onWeb = needsWeb ? Boolean(webPresent[name]) : true;
    const onWorker = needsWorker ? Boolean(workerPresent[name]) : true;

    // Worker never booted → we can't tell for worker-scoped keys yet.
    if (needsWorker && !boot) {
      if (needsWeb && !onWeb) return { label: "Missing (web)", tone: "coral" };
      return { label: "Worker not booted", tone: "gray", note: "Boot the worker once to check." };
    }

    if (onWeb && onWorker) return { label: "Set", tone: "teal" };
    if (required) {
      const where = !onWeb && !onWorker ? "everywhere" : !onWeb ? "web" : "worker";
      return { label: `Missing (${where})`, tone: "coral" };
    }
    return { label: "Optional — not set", tone: "gray" };
  }

  const missing = ENV_KEYS.filter((k) => k.required && status(k.name, k.scope, k.required).tone === "coral").length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <SectionHeading>Go-live checklist</SectionHeading>
        <p className="mt-2 max-w-2xl text-sm" style={{ color: "var(--c-text-muted)" }}>
          Every environment variable the pipeline touches, and which scope needs it. Values are never read here — only whether
          each key is set. A missing required key on the wrong service is silent failure waiting to happen.
        </p>
      </div>

      <div
        className="rounded-xl border p-4"
        style={{
          background: missing === 0 ? "var(--teal-soft)" : "#FBE7E7",
          borderColor: missing === 0 ? "var(--teal)" : "var(--coral)",
        }}
      >
        <div className="font-display text-sm font-semibold" style={{ color: missing === 0 ? "var(--teal)" : "var(--coral)" }}>
          {missing === 0 ? "✓ All required keys are set." : `${missing} required key${missing === 1 ? "" : "s"} still missing.`}
        </div>
        {missing > 0 && (
          <p className="mt-1 text-sm" style={{ color: "var(--c-text-muted)" }}>
            Set them on Railway (and restart the worker for worker-scoped keys, so its boot-info snapshot refreshes).
          </p>
        )}
      </div>

      <ConsoleCard title="Environment" sub="Grouped by what breaks when each is missing">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide" style={{ borderColor: "var(--line)", color: "var(--c-text-muted)" }}>
                <th scope="col" className="px-5 py-2 font-semibold">Variable</th>
                <th scope="col" className="px-3 py-2 font-semibold">Scope</th>
                <th scope="col" className="px-3 py-2 font-semibold">Status</th>
                <th scope="col" className="px-3 py-2 font-semibold">What it blocks</th>
              </tr>
            </thead>
            <tbody>
              {ENV_KEYS.map((k) => {
                const s = status(k.name, k.scope, k.required);
                return (
                  <tr key={k.name} className="border-b align-top last:border-b-0" style={{ borderColor: "var(--line)" }}>
                    <td className="px-5 py-3 font-mono-label text-[12px] font-semibold" style={{ color: "var(--c-text)" }}>
                      {k.name}
                      {!k.required && <span className="ml-1 text-[10px] font-normal" style={{ color: "var(--c-text-faint)" }}>optional</span>}
                    </td>
                    <td className="px-3 py-3 text-xs" style={{ color: "var(--c-text-muted)" }}>{k.scope}</td>
                    <td className="px-3 py-3"><Pill tone={s.tone}>{s.label}</Pill></td>
                    <td className="px-3 py-3 text-xs" style={{ color: "var(--c-text-muted)" }}>
                      {k.blocks}
                      {s.note && <div className="mt-0.5" style={{ color: "var(--c-text-faint)" }}>{s.note}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ConsoleCard>

      <p className="text-xs" style={{ color: "var(--c-text-faint)" }}>
        Web-service keys are read live from this process. Worker-service keys come from the last{" "}
        <Link href="/admin/photo/controls" className="hover:underline" style={{ color: "var(--accent)" }}>worker boot</Link>.
      </p>
    </div>
  );
}
