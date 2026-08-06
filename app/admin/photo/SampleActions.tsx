"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Free-sample production controls. Optional Claid first pass → download rough →
// edit locally → upload finished → approve (which sends Touch 2) or reject.
export default function SampleActions({
  magicLinkId,
  hasFinished,
}: {
  magicLinkId: number;
  hasFinished: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const post = async (action: string, file?: File) => {
    setBusy(action);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("magicLinkId", String(magicLinkId));
      fd.set("action", action);
      if (file) fd.set("photo", file);
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
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => post("first_pass")}
        className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
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
          if (f) post("upload_finished", f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => fileRef.current?.click()}
        className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
      >
        {busy === "upload_finished" ? "Uploading…" : "Upload finished photo"}
      </button>

      <button
        type="button"
        disabled={busy !== null || !hasFinished}
        title={hasFinished ? "" : "Upload the finished photo first"}
        onClick={() => post("approve")}
        className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
      >
        Approve &amp; send
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => {
          if (!window.confirm("Reject this sample? The customer gets no reply and the lead is closed — this cannot be undone from the queue.")) return;
          post("reject");
        }}
        className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
      >
        Reject
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
