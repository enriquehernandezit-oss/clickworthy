"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Per-draft controls (approve / edit / redraft / skip). Same FormData →
// /api/admin/outreach → router.refresh() pattern as SampleActions.
export default function DraftActions({
  outreachJobId,
  subject,
  body,
}: {
  outreachJobId: number;
  subject: string;
  body: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftSubject, setDraftSubject] = useState(subject);
  const [draftBody, setDraftBody] = useState(body);

  const post = async (action: string, extra: Record<string, string> = {}, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(action);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("action", action);
      fd.set("outreachJobId", String(outreachJobId));
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      const res = await fetch("/api/admin/outreach", { method: "POST", body: fd });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? "Something went wrong.");
        setBusy(null);
        return;
      }
      if (action === "set_content") setEditing(false);
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  };

  const inputCls = "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800";

  if (editing) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <label className="text-xs font-medium text-stone-500">
          Subject
          <input value={draftSubject} onChange={(e) => setDraftSubject(e.target.value)} className={`mt-1 ${inputCls}`} />
        </label>
        <label className="text-xs font-medium text-stone-500">
          Body
          <textarea value={draftBody} onChange={(e) => setDraftBody(e.target.value)} rows={8} className={`mt-1 ${inputCls} font-sans leading-relaxed`} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post("set_content", { subject: draftSubject, body: draftBody })}
            className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-700 disabled:opacity-50"
          >
            {busy === "set_content" ? "Saving…" : "Save edit"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => { setEditing(false); setDraftSubject(subject); setDraftBody(body); }}
            className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
          >
            Cancel
          </button>
          <span className="text-xs text-stone-500">Saving keeps it a draft. Redraft later overwrites your edit.</span>
          {error && <span className="text-sm text-red-600" role="alert">{error}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => post("approve")}
        className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-700 disabled:opacity-50"
      >
        {busy === "approve" ? "Approving…" : "Approve"}
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => setEditing(true)}
        className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
      >
        Edit
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => post("redraft", {}, "Recompose this draft from the restaurant's current fields? Any hand-edits will be lost.")}
        className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
      >
        {busy === "redraft" ? "Redrafting…" : "Redraft"}
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => post("skip", {}, "Skip this restaurant? The draft is deleted and the restaurant is held (won't be drafted again until you unhold it).")}
        className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
      >
        {busy === "skip" ? "Skipping…" : "Skip"}
      </button>
      {error && <span className="text-sm text-red-600" role="alert">{error}</span>}
    </div>
  );
}

export function ApproveAllButton({ count }: { count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approveAll = async () => {
    if (!window.confirm(`Approve all ${count} drafts? They'll send on the next send run (subject to the daily cap).`)) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("action", "approve_all");
      const res = await fetch("/api/admin/outreach", { method: "POST", body: fd });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? "Something went wrong.");
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={busy}
        onClick={approveAll}
        className="btn-press rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
      >
        {busy ? "Approving…" : `Approve all (${count})`}
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
