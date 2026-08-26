"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Free-sample production controls. Optional Claid first pass → download rough →
// edit locally → upload finished → review + edit the Touch 2 email → Approve &
// send (composes and sends in one request, right here) — or Reject.
export default function SampleActions({
  magicLinkId,
  hasFinished,
  seed,
  seedError,
}: {
  magicLinkId: number;
  hasFinished: boolean;
  seed: { subject: string; body: string } | null;
  seedError?: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState(seed?.subject ?? "");
  const [body, setBody] = useState(seed?.body ?? "");

  const post = async (action: string, opts: { file?: File; extra?: Record<string, string> } = {}) => {
    setBusy(action);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("magicLinkId", String(magicLinkId));
      fd.set("action", action);
      if (opts.file) fd.set("photo", opts.file);
      if (opts.extra) for (const [k, v] of Object.entries(opts.extra)) fd.set(k, v);
      const res = await fetch("/api/admin/sample", { method: "POST", body: fd });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? "Something went wrong.");
        setBusy(null);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => post("first_pass")}
          className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          {busy === "first_pass" ? "Running Claid… (~1 min)" : "Run Claid first pass"}
        </button>

        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) post("upload_finished", { file: f });
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => fileRef.current?.click()}
          className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          {busy === "upload_finished" ? "Uploading…" : "Upload finished photo"}
        </button>

        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            if (!window.confirm("Reject this sample? The customer gets no reply and the lead is closed — this cannot be undone from the queue.")) return;
            post("reject");
          }}
          className="rounded-lg border border-coral/40 px-4 py-2 text-sm font-semibold text-coral transition-colors hover:bg-coral/10 disabled:opacity-50"
        >
          Reject
        </button>
        {error && <span className="text-sm text-coral">{error}</span>}
      </div>

      {hasFinished && (
        <div className="rounded-lg border border-line bg-surface-2 p-3">
          <div className="text-xs font-medium text-muted">
            Touch 2 — review and edit before sending. Nothing sends until you click below.
          </div>
          {seedError ? (
            <p className="mt-2 text-sm font-semibold text-coral">{seedError}</p>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-text"
                placeholder="Subject"
              />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-sans text-sm leading-relaxed text-text"
              />
            </div>
          )}
          <div className="mt-3">
            <button
              type="button"
              disabled={busy !== null || Boolean(seedError) || !subject.trim() || !body.trim()}
              onClick={() => post("approve", { extra: { subject, body } })}
              className="rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-[#0F1216] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted"
            >
              {busy === "approve" ? "Sending…" : "Approve & send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
