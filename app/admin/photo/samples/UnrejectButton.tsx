"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Restore a rejected sample back to the edit queue. Rejecting used to be a
// permanent one-click loss of a lead that had replied with a photo.
export default function UnrejectButton({ magicLinkId }: { magicLinkId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restore = async () => {
    if (!window.confirm("Restore this rejected sample to the edit queue?")) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("magicLinkId", String(magicLinkId));
      fd.set("action", "unreject");
      const res = await fetch("/api/admin/sample", { method: "POST", body: fd });
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
        onClick={restore}
        className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
      >
        {busy ? "…" : "Restore"}
      </button>
      {error && <span className="text-xs text-coral" role="alert">{error}</span>}
    </div>
  );
}
