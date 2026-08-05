"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Pull an approved-but-unsent draft back to draft so it won't send on the next
// run — without needing the global pause.
export default function UnapproveButton({ outreachJobId }: { outreachJobId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unapprove = async () => {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("action", "unapprove");
      fd.set("outreachJobId", String(outreachJobId));
      const res = await fetch("/api/admin/outreach", { method: "POST", body: fd });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? "Failed.");
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
    <div className="mt-3 flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={unapprove}
        className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
      >
        {busy ? "Un-approving…" : "Un-approve (back to draft)"}
      </button>
      {error && <span className="text-sm text-red-600" role="alert">{error}</span>}
    </div>
  );
}
