"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Queue = { queue: string; label: string; hint: string };

// "Run now" buttons. Enqueue only — the worker executes. A null/throttled
// response is informational ("already queued"), not an error.
export default function RunNow({ queues, autosendOn }: { queues: Queue[]; autosendOn: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ queue: string; text: string; kind: "info" | "ok" | "error" } | null>(null);

  const run = async (q: Queue) => {
    if (
      q.queue === "send-outreach" &&
      autosendOn &&
      !window.confirm("Autosend is ON — this run drafts AND sends up to the daily cap. Continue?")
    )
      return;
    setBusy(q.queue);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("queue", q.queue);
      const res = await fetch("/api/admin/run", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ queue: q.queue, text: body?.error ?? "Failed.", kind: "error" });
      } else if (body.throttled) {
        setMsg({ queue: q.queue, text: "Already queued — the worker will pick it up.", kind: "info" });
      } else {
        setMsg({ queue: q.queue, text: "Queued — the worker runs it on its next poll.", kind: "ok" });
      }
    } catch {
      setMsg({ queue: q.queue, text: "Network error.", kind: "error" });
    } finally {
      setBusy(null);
    }
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      {queues.map((q) => (
        <div key={q.queue} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-stone-900">{q.label}</div>
            <div className="text-xs text-stone-500">{q.hint}</div>
            {msg?.queue === q.queue && (
              <div
                className={`mt-1 text-xs ${
                  msg.kind === "error" ? "text-red-600" : msg.kind === "ok" ? "text-green-700" : "text-stone-500"
                }`}
              >
                {msg.text}
              </div>
            )}
          </div>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run(q)}
            className="btn-press rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          >
            {busy === q.queue ? "Queuing…" : "Run now"}
          </button>
        </div>
      ))}
      <p className="text-xs text-stone-500">Run now only enqueues; the worker executes. If the worker is down, the job waits until it&apos;s back.</p>
    </div>
  );
}
