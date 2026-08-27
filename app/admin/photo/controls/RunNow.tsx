"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "../../primitives";

type Queue = { queue: string; label: string; hint: string };

// "Run now" buttons. Enqueue only — the worker executes. A null/throttled
// response is informational ("already queued"), not an error.
export default function RunNow({ queues, autosendOn }: { queues: Queue[]; autosendOn: boolean }) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ queue: string; text: string; kind: "info" | "ok" | "error" } | null>(null);

  const run = async (q: Queue) => {
    if (q.queue === "send-outreach" && autosendOn) {
      const ok = await confirm({
        title: "Autosend is ON",
        description: "This run drafts AND sends up to the daily cap, with no review step. Continue?",
        confirmLabel: "Run it",
        danger: true,
      });
      if (!ok) return;
    }
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
      {confirmDialog}
      {queues.map((q) => (
        <div key={q.queue} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-text">{q.label}</div>
            <div className="text-xs text-faint">{q.hint}</div>
            {msg?.queue === q.queue && (
              <div
                className={`mt-1 text-xs ${
                  msg.kind === "error" ? "text-coral" : msg.kind === "ok" ? "text-teal" : "text-faint"
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
            className="btn-press rounded-lg border border-line px-4 py-2 text-sm font-medium text-text hover:bg-surface-2 disabled:opacity-50"
          >
            {busy === q.queue ? "Queuing…" : "Run now"}
          </button>
        </div>
      ))}
      <p className="text-xs text-faint">Run now only enqueues; the worker executes. If the worker is down, the job waits until it&apos;s back.</p>
    </div>
  );
}
