"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Admin-side counterpart to the customer's own upload at /l/[token]/upload —
// restaurant owners email a folder of photos regardless of what the upload
// page says, so this lets you drop those files straight into the same
// pipeline. See app/api/admin/package/route.ts's upload_originals action.
export default function UploadOnBehalfForm({ magicLinkId }: { magicLinkId: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<FileList | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const upload = async () => {
    if (!files || files.length === 0) {
      setMsg({ text: "Choose at least one photo first.", ok: false });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("magicLinkId", String(magicLinkId));
      fd.set("action", "upload_originals");
      for (const file of Array.from(files)) fd.append("photos", file);
      const res = await fetch("/api/admin/package", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ text: body?.error ?? "Failed.", ok: false });
      } else {
        setMsg({ text: `Uploaded ${body.count} photo${body.count === 1 ? "" : "s"} — queued for production.`, ok: true });
        setOpen(false);
        router.refresh();
      }
    } catch {
      setMsg({ text: "Network error.", ok: false });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-orange-700 hover:underline"
      >
        Upload photos for them ↗
      </button>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 p-2">
      <input
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        onChange={(e) => setFiles(e.target.files)}
        className="text-xs"
      />
      <button
        type="button"
        disabled={busy}
        onClick={upload}
        className="rounded-md bg-stone-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-50"
      >
        {busy ? "Uploading…" : "Upload"}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-stone-500 hover:underline">
        Cancel
      </button>
      {msg && (
        <span className={`text-xs ${msg.ok ? "text-teal-700" : "text-red-600"}`} role="alert">
          {msg.text}
        </span>
      )}
    </div>
  );
}
