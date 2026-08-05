"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Per-draft controls (approve / redraft / skip). Same FormData → /api/admin/outreach
// → router.refresh() pattern as SampleActions.
export default function DraftActions({ outreachJobId }: { outreachJobId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const post = async (action: string, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(action);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("action", action);
      fd.set("outreachJobId", String(outreachJobId));
      const res = await fetch("/api/admin/outreach", { method: "POST", body: fd });
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
        onClick={() => post("redraft")}
        className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
      >
        {busy === "redraft" ? "Redrafting…" : "Redraft"}
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => post("skip", "Skip this restaurant? The draft is deleted and the restaurant is held (won't be drafted again until you unhold it).")}
        className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
      >
        {busy === "skip" ? "Skipping…" : "Skip"}
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
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
