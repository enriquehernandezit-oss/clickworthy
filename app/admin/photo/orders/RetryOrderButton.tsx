"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Re-queue a failed self-serve order. Without this a paid-but-failed order is
// permanently stuck (the worker pickup query skips rows that have results set).
export default function RetryOrderButton({ orderId }: { orderId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("orderId", String(orderId));
      fd.set("action", "retry");
      const res = await fetch("/api/admin/orders", { method: "POST", body: fd });
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
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={retry}
        className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
      >
        {busy ? "…" : "Retry"}
      </button>
      {error && <span className="text-xs text-coral" role="alert">{error}</span>}
    </div>
  );
}
