"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Bump draft controls — body only, no subject (it replies into the Touch 1
// thread). Same FormData -> /api/admin/approvals -> router.refresh() pattern
// as Touch 1's own DraftActions.tsx, just posting bump_* actions instead.
export default function BumpDraftActions({ outreachJobId, body }: { outreachJobId: number; body: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
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
      const res = await fetch("/api/admin/approvals", { method: "POST", body: fd });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? "Something went wrong.");
        setBusy(null);
        return;
      }
      if (action === "bump_edit") setEditing(false);
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
          Body
          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            rows={8}
            className={`mt-1 ${inputCls} font-sans leading-relaxed`}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post("bump_edit", { body: draftBody })}
            className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-700 disabled:opacity-50"
          >
            {busy === "bump_edit" ? "Saving…" : "Save edit"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => { setEditing(false); setDraftBody(body); }}
            className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
          >
            Cancel
          </button>
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
        onClick={() => post("bump_approve")}
        className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-700 disabled:opacity-50"
      >
        {busy === "bump_approve" ? "Approving…" : "Approve"}
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
        onClick={() => post("bump_deny", {}, "Deny this bump? It won't be drafted again for this restaurant — that's a promise the copy itself makes.")}
        className="rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
      >
        {busy === "bump_deny" ? "Denying…" : "Deny"}
      </button>
      {error && <span className="text-sm text-red-600" role="alert">{error}</span>}
    </div>
  );
}
