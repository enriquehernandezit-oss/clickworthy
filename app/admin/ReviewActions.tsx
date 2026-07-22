"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Approve / reject buttons for one pending sample. Approve flips the magic link
// to `approved` (the worker's Touch 2 job then emails it); reject flips it to
// `rejected` so it never goes out.
export default function ReviewActions({ magicLinkId }: { magicLinkId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ magicLinkId, action }),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? "Something went wrong.");
        setBusy(false);
        return;
      }
      router.refresh(); // re-render the server component; the item drops off the queue
    } catch {
      setError("Network error.");
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 flex items-center gap-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => act("approve")}
        className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-700 disabled:opacity-50"
      >
        Approve &amp; send
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => act("reject")}
        className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
      >
        Reject
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
