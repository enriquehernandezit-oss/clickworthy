"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type PackageResult = { name: string; originalUrl: string; enhancedUrl: string | null; error: string | null };

// Paid-order production: per-photo finish (optional Claid re-run or upload an
// edited version), then review + edit the delivery email and send it (which
// unlocks the customer's page).
export default function PackageActions({
  magicLinkId,
  results,
  seed,
}: {
  magicLinkId: number;
  results: PackageResult[];
  seed: { subject: string; body: string } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState(seed?.subject ?? "");
  const [body, setBody] = useState(seed?.body ?? "");

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

      {allFinished && (
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
          <div className="text-xs font-medium text-stone-500">
            Delivery email — review and edit before sending. The order unlocks the moment you send.
          </div>
          <div className="mt-2 flex flex-col gap-2">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800"
              placeholder="Subject"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 font-sans text-sm leading-relaxed text-stone-800"
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy !== null || !allFinished || !subject.trim() || !body.trim()}
          title={allFinished ? "" : "Finish every photo before delivering"}
          onClick={() => {
            if (!window.confirm("Send this delivery email? The delivery page unlocks the moment it sends. No further edits after this.")) return;
            post("deliver", { subject, body });
          }}
          className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
        >
          {busy === "deliver:order" ? "Sending…" : "Send delivery email"}
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
      <div className={`aspect-square overflow-hidden rounded ${result.error ? "bg-red-50" : "bg-stone-100"}`}>
        {result.enhancedUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={result.enhancedUrl} alt={result.name} className="h-full w-full object-cover" />
        ) : result.error ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center">
            <span className="text-xs font-semibold text-red-700">Claid failed</span>
            <span className="line-clamp-3 text-[10px] leading-tight text-red-600">{result.error}</span>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-2 text-center text-xs text-stone-400">
            not finished
          </div>
        )}
      </div>
      <span className="truncate text-xs text-stone-500" title={result.name}>{result.name}</span>
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
