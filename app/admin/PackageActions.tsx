"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type PackageResult = { name: string; originalUrl: string; enhancedUrl: string | null; error: string | null };

// Paid-order production: per-photo finish (optional Claid re-run or upload an
// edited version), then deliver the whole order (unlocks the customer's page).
export default function PackageActions({
  magicLinkId,
  results,
}: {
  magicLinkId: number;
  results: PackageResult[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const post = async (action: string, extra: Record<string, string>, file?: File) => {
    const key = `${action}:${extra.photoIndex ?? "order"}`;
    setBusy(key);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("magicLinkId", String(magicLinkId));
      fd.set("action", action);
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      if (file) fd.set("photo", file);
      const res = await fetch("/api/admin/package", { method: "POST", body: fd });
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

  const allFinished = results.length > 0 && results.every((r) => r.enhancedUrl);

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {results.map((r, i) => (
          <PhotoRow key={i} index={i} result={r} busy={busy} onPost={post} />
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy !== null || !allFinished}
          title={allFinished ? "" : "Finish every photo before delivering"}
          onClick={() => post("deliver", {})}
          className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
        >
          {busy === "deliver:order" ? "Delivering…" : "Deliver order"}
        </button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}

function PhotoRow({
  index,
  result,
  busy,
  onPost,
}: {
  index: number;
  result: PackageResult;
  busy: string | null;
  onPost: (action: string, extra: Record<string, string>, file?: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-stone-200 p-3">
      <div className="aspect-square overflow-hidden rounded bg-stone-100">
        {result.enhancedUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={result.enhancedUrl} alt={result.name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center px-2 text-center text-xs text-stone-400">
            not finished
          </div>
        )}
      </div>
      <span className="truncate text-xs text-stone-500">{result.name}</span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => onPost("first_pass_one", { photoIndex: String(index) })}
          className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
        >
          {busy === `first_pass_one:${index}` ? "…" : "Claid"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPost("upload_edited", { photoIndex: String(index) }, f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => fileRef.current?.click()}
          className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
        >
          {busy === `upload_edited:${index}` ? "…" : "Upload edited"}
        </button>
      </div>
    </div>
  );
}
