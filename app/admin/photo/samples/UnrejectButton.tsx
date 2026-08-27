"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "../../primitives";

// Restore a rejected sample back to the edit queue. Rejecting used to be a
// permanent one-click loss of a lead that had replied with a photo.
export default function UnrejectButton({ magicLinkId }: { magicLinkId: number }) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restore = async () => {
    const ok = await confirm({
      title: "Restore this sample?",
      description: "It goes back to the edit queue so you can finish and send it.",
      confirmLabel: "Restore",
    });
    if (!ok) return;
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
      {confirmDialog}
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
