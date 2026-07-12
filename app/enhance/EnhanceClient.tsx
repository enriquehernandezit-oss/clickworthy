"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatCents, pricePerPhotoCents, totalPriceCents } from "@/lib/pricing";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const SOFT_WARNING_THRESHOLD = 20;

const PROMPT_PLACEHOLDER =
  "Brighten the lighting, sharpen the focus, and make the colors more vibrant and appetizing. Keep the food and setting exactly as they are.";

const PROMPT_CHIPS = [
  "Fix lighting and sharpness",
  "Replace background with clean white marble",
  "Make colors more vibrant",
];

type UploadedPhoto = {
  id: string;
  file: File;
  previewUrl: string;
};

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={className}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="6" y1="18" x2="18" y2="6" />
    </svg>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`animate-spin ${className ?? ""}`}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default function EnhanceClient() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id");
  const outcome = searchParams.get("outcome");

  if (outcome === "success" && sessionId) {
    return <ResultsView sessionId={sessionId} />;
  }

  return <UploadForm cancelled={outcome === "cancelled"} />;
}

function UploadForm({ cancelled }: { cancelled: boolean }) {
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [prompt, setPrompt] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Revoke object URLs on unmount to avoid leaking memory.
    return () => {
      photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const incoming = Array.from(fileList).filter((f) => ALLOWED_TYPES.includes(f.type));
    if (incoming.length === 0) return;
    setPhotos((prev) => [
      ...prev,
      ...incoming.map((file) => ({
        id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ]);
  }, []);

  const removePhoto = useCallback((id: string) => {
    setPhotos((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const handleChipClick = (chipText: string) => {
    setPrompt((prev) => (prev.trim().length === 0 ? chipText : `${prev.trim()} ${chipText}`));
  };

  const quantity = photos.length;
  const perPhotoCents = useMemo(() => (quantity > 0 ? pricePerPhotoCents(quantity) : 0), [quantity]);
  const totalCents = useMemo(() => (quantity > 0 ? totalPriceCents(quantity) : 0), [quantity]);

  const canSubmit = quantity > 0 && prompt.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.set("prompt", prompt.trim());
      photos.forEach((p) => formData.append("photos", p.file));

      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }

      window.location.href = data.url;
    } catch {
      setError("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <main className="flex-1">
      <section className="mx-auto max-w-5xl px-6 py-16 lg:px-8 lg:py-20">
        <div className="flex flex-col gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-orange-600">
            Photo enhancement
          </p>
          <h1 className="text-3xl font-bold [text-wrap:balance] tracking-tight text-stone-900 sm:text-4xl">
            Enhance your restaurant photos
          </h1>
          <p className="max-w-2xl text-base [text-wrap:pretty] leading-relaxed text-stone-600">
            Upload your food, menu, and interior photos, describe how you&apos;d like them
            enhanced, and get AI-enhanced versions back — ready to download.
          </p>
        </div>

        {cancelled && (
          <div className="animate-fade-scale-in mt-8 flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-5 py-4 text-sm text-stone-600">
            Checkout was cancelled — your photos weren&apos;t charged. You can try again below.
          </div>
        )}

        <div className="mt-10 flex flex-col gap-10">
          {/* Upload zone */}
          <div className="flex flex-col gap-4">
            <label className="text-sm font-semibold text-stone-900">Upload your photos</label>
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
              className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
                dragActive
                  ? "border-orange-400 bg-orange-50"
                  : "border-stone-300 bg-white hover:border-stone-400 hover:bg-stone-100"
              }`}
            >
              <UploadIcon className="h-8 w-8 text-stone-400" />
              <p className="text-sm font-medium text-stone-700">
                Drag and drop photos here, or click to browse
              </p>
              <p className="text-xs text-stone-500">JPEG, PNG, or WEBP — any number of photos</p>
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

            {quantity > SOFT_WARNING_THRESHOLD && (
              <div className="animate-fade-scale-in rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Large orders may take a few minutes to process.
              </div>
            )}

            {quantity > 0 && (
              <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5">
                {photos.map((photo, index) => (
                  <div
                    key={photo.id}
                    className="animate-fade-scale-in group relative aspect-square overflow-hidden rounded-lg border border-stone-200 bg-stone-100"
                    style={{ animationDelay: `${(index % 10) * 40}ms` }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.previewUrl}
                      alt={photo.file.name}
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removePhoto(photo.id)}
                      aria-label={`Remove ${photo.file.name}`}
                      className="btn-press absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Prompt */}
          <div className="flex flex-col gap-3">
            <label htmlFor="prompt" className="text-sm font-semibold text-stone-900">
              Describe how you&apos;d like these photos enhanced
            </label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={PROMPT_PLACEHOLDER}
              rows={4}
              className="[text-wrap:pretty] rounded-xl border border-stone-300 bg-white px-4 py-3 text-sm text-stone-900 placeholder:text-stone-400 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100"
            />
            <div className="flex flex-wrap gap-2">
              {PROMPT_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => handleChipClick(chip)}
                  className="btn-press rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>

          {/* Price + submit */}
          <div className="flex flex-col gap-5 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-sm text-stone-600">
                {quantity > 0 ? (
                  <>
                    <span className="font-semibold text-stone-900">{quantity}</span>{" "}
                    photo{quantity === 1 ? "" : "s"} ×{" "}
                    <span className="tabular-nums">{formatCents(perPhotoCents)}</span> each
                  </>
                ) : (
                  "Add photos to see your price"
                )}
              </span>
              <span className="text-2xl font-bold tabular-nums tracking-tight text-stone-900">
                {quantity > 0 ? formatCents(totalCents) : "—"}
              </span>
            </div>

            {error && (
              <div className="animate-fade-scale-in rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="btn-press flex items-center justify-center gap-2 rounded-lg bg-orange-600 px-6 py-3.5 text-base font-semibold text-white shadow-sm hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
            >
              {submitting && <SpinnerIcon className="h-4 w-4" />}
              {submitting ? "Starting checkout…" : "Enhance My Photos"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

type OrderStatusResponse = {
  status: "pending" | "processing" | "completed" | "failed";
  prompt: string;
  photoCount: number;
  totalCents: number;
  photos: { originalName: string; contentType: string; url: string }[];
  results: { originalName: string; enhancedUrl: string | null; error: string | null }[] | null;
};

function ResultsView({ sessionId }: { sessionId: string }) {
  const [order, setOrder] = useState<OrderStatusResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [showBefore, setShowBefore] = useState<Record<number, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await fetch(`/api/enhance/status?session_id=${encodeURIComponent(sessionId)}`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        const data: OrderStatusResponse = await res.json();
        if (cancelled) return;
        setOrder(data);
        if (data.status === "pending" || data.status === "processing") {
          timer = setTimeout(poll, 2500);
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 4000);
      }
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId]);

  return (
    <main className="flex-1">
      <section className="mx-auto max-w-5xl px-6 py-16 lg:px-8 lg:py-20">
        <div className="flex flex-col gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-orange-600">
            Payment confirmed
          </p>
          <h1 className="text-3xl font-bold [text-wrap:balance] tracking-tight text-stone-900 sm:text-4xl">
            Your enhanced photos
          </h1>
        </div>

        {notFound && (
          <div className="animate-fade-scale-in mt-8 rounded-xl border border-stone-200 bg-white px-5 py-4 text-sm text-stone-600">
            We couldn&apos;t find this order. If you were just charged, refresh this page in a
            moment — otherwise reach out to contact@clickworthytool.com.
          </div>
        )}

        {!notFound && (!order || order.status === "pending" || order.status === "processing") && (
          <div className="animate-fade-scale-in mt-10 flex flex-col items-center gap-4 rounded-xl border border-stone-200 bg-white px-6 py-16 text-center">
            <SpinnerIcon className="h-8 w-8 text-orange-600" />
            <p className="text-sm font-medium text-stone-700">
              Enhancing your photos — this can take a minute or two.
            </p>
            <p className="text-xs text-stone-500">This page will update automatically.</p>
          </div>
        )}

        {order && order.status === "failed" && (
          <div className="animate-fade-scale-in mt-10 rounded-xl border border-stone-200 bg-white px-6 py-8 text-center">
            <p className="text-sm font-medium text-stone-700">
              We ran into a problem enhancing these photos. Please reach out to{" "}
              <a href="mailto:contact@clickworthytool.com" className="text-orange-600 underline">
                contact@clickworthytool.com
              </a>{" "}
              with your order and we&apos;ll take care of it.
            </p>
          </div>
        )}

        {order && order.status === "completed" && order.results && (
          <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2">
            {order.results.map((result, i) => {
              const original = order.photos[i];
              const isBefore = showBefore[i] ?? false;
              return (
                <div
                  key={i}
                  className="animate-fade-scale-in flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
                  style={{ animationDelay: `${(i % 10) * 40}ms` }}
                >
                  <div className="relative aspect-square overflow-hidden rounded-lg bg-stone-100">
                    {result.error ? (
                      <div className="flex h-full w-full items-center justify-center px-4 text-center text-xs text-stone-500">
                        Couldn&apos;t enhance this photo — contact us and we&apos;ll fix it.
                      </div>
                    ) : (
                      <>
                        {/* Stacked before/after images cross-fade via opacity instead of a hard src swap. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={original?.url}
                          alt={`${result.originalName} (before)`}
                          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ease-[var(--ease-snappy)] ${
                            isBefore ? "opacity-100" : "opacity-0"
                          }`}
                        />
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={result.enhancedUrl ?? undefined}
                          alt={`${result.originalName} (after)`}
                          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ease-[var(--ease-snappy)] ${
                            isBefore ? "opacity-0" : "opacity-100"
                          }`}
                        />
                      </>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-xs text-stone-500">{result.originalName}</span>
                    {!result.error && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setShowBefore((prev) => ({ ...prev, [i]: !isBefore }))}
                          className="btn-press rounded-md border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
                        >
                          {isBefore ? "Show after" : "Show before"}
                        </button>
                        {result.enhancedUrl && (
                          <a
                            href={result.enhancedUrl}
                            download
                            className="btn-press rounded-md bg-orange-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-orange-700"
                          >
                            Download
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
