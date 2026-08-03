"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { funnelCopy, type Lang } from "../copy";

type PackageResult = { name: string; originalUrl: string; enhancedUrl: string | null; error: string | null };
// processing = Claid first pass · ready_for_review = our team finishing by hand ·
// completed = delivered (admin pressed "Deliver order"). The customer only ever
// sees their photos once status is `completed`.
type Status = "processing" | "ready_for_review" | "completed" | "failed" | null;

const IN_PROGRESS = (s: Status) => s === "processing" || s === "ready_for_review";

type UploadedPhoto = { id: string; file: File; previewUrl: string };

function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`animate-spin ${className ?? ""}`}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default function UploadClient({
  token,
  language,
  photoLimit,
  initialStatus,
  initialResults,
}: {
  token: string;
  language: string;
  photoLimit: number;
  initialStatus: Status;
  initialResults: PackageResult[] | null;
}) {
  const copy = funnelCopy[(language as Lang) === "es" ? "es" : "en"];
  const [status, setStatus] = useState<Status>(initialStatus);
  const [results, setResults] = useState<PackageResult[] | null>(initialResults);

  // Poll while the order is still being produced (Claid pass or human finishing),
  // until it's delivered. The wait can be days, so this only advances the page
  // if the customer happens to have it open — delivery isn't gated on polling.
  useEffect(() => {
    if (!IN_PROGRESS(status)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch(`/api/outreach/status?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (cancelled) return;
        if (data.status === "completed" || data.status === "failed") {
          setResults(data.results ?? null);
          setStatus(data.status);
          return;
        }
        setStatus(data.status ?? status);
      } catch {
        /* keep polling */
      }
      timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 5000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status, token]);

  if (status === "completed" || status === "failed") {
    return <Delivery copy={copy} results={results} />;
  }
  if (IN_PROGRESS(status)) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border border-stone-200 bg-white px-6 py-16 text-center">
        <Spinner className="h-8 w-8 text-orange-600" />
        <p className="text-sm font-medium text-stone-700">{copy.enhancing}</p>
        <p className="text-xs text-stone-500">{copy.autoUpdate}</p>
      </div>
    );
  }
  return <UploadForm copy={copy} token={token} photoLimit={photoLimit} onSubmitted={() => setStatus("processing")} />;
}

function Delivery({ copy, results }: { copy: (typeof funnelCopy)[Lang]; results: PackageResult[] | null }) {
  return (
    <div>
      <h1 className="text-3xl font-bold [text-wrap:balance] [letter-spacing:-0.02em] sm:text-4xl">
        {copy.deliveryTitle}
      </h1>
      <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
        {(results ?? []).map((r, i) => (
          <div
            key={i}
            className="animate-fade-scale-in flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
            style={{ animationDelay: `${(i % 10) * 40}ms` }}
          >
            <div className="aspect-square overflow-hidden rounded-lg bg-stone-100">
              {r.enhancedUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.enhancedUrl} alt={r.name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center px-4 text-center text-xs text-stone-500">
                  {copy.photoFailed}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-xs text-stone-500">{r.name}</span>
              {r.enhancedUrl && (
                <a
                  href={r.enhancedUrl}
                  download
                  className="btn-press rounded-md bg-orange-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-orange-700"
                >
                  {copy.download}
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UploadForm({
  copy,
  token,
  photoLimit,
  onSubmitted,
}: {
  copy: (typeof funnelCopy)[Lang];
  token: string;
  photoLimit: number;
  onSubmitted: () => void;
}) {
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      const allowed = ["image/jpeg", "image/png", "image/webp"];
      const incoming = Array.from(list).filter((f) => allowed.includes(f.type));
      setPhotos((prev) => {
        const room = photoLimit - prev.length;
        return [
          ...prev,
          ...incoming.slice(0, Math.max(0, room)).map((file) => ({
            id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
            file,
            previewUrl: URL.createObjectURL(file),
          })),
        ];
      });
    },
    [photoLimit]
  );

  const removePhoto = (id: string) =>
    setPhotos((prev) => {
      const t = prev.find((p) => p.id === id);
      if (t) URL.revokeObjectURL(t.previewUrl);
      return prev.filter((p) => p.id !== id);
    });

  const submit = async () => {
    if (photos.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("token", token);
      photos.forEach((p) => fd.append("photos", p.file));
      const res = await fetch("/api/outreach/enhance", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? copy.error);
        setSubmitting(false);
        return;
      }
      onSubmitted();
    } catch {
      setError(copy.error);
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-3xl font-bold [text-wrap:balance] [letter-spacing:-0.02em] sm:text-4xl">
          {copy.uploadTitle}
        </h1>
        <p className="mt-3 text-stone-600">{copy.uploadBody(photoLimit)}</p>
      </div>

      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
          dragActive ? "border-orange-400 bg-orange-50" : "border-stone-300 bg-white hover:border-stone-400 hover:bg-stone-100"
        }`}
      >
        <p className="text-sm font-medium text-stone-700">{copy.uploadZone}</p>
        <p className="text-xs text-stone-500">
          {copy.uploadFormats} · {photos.length}/{photoLimit}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {photos.length > 0 && (
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5">
          {photos.map((photo) => (
            <div key={photo.id} className="relative aspect-square overflow-hidden rounded-lg border border-stone-200 bg-stone-100">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.previewUrl} alt={photo.file.name} className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => removePhoto(photo.id)}
                aria-label={`Remove ${photo.file.name}`}
                className="btn-press absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="6" y1="18" x2="18" y2="6" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <button
        type="button"
        onClick={submit}
        disabled={photos.length === 0 || submitting}
        className="btn-press flex items-center justify-center gap-2 self-start rounded-lg bg-orange-600 px-6 py-3.5 text-base font-semibold text-white shadow-sm hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
      >
        {submitting && <Spinner className="h-4 w-4" />}
        {copy.enhanceBtn}
      </button>
    </div>
  );
}
