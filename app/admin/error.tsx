"use client";

// Catch-all for any thrown error inside the admin tree. Renders inside the
// console shell (the layout wraps error boundaries too), so the sidebar stays
// visible and you can navigate away without a hard refresh.
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="rounded-xl border border-coral/40 bg-coral/10 px-6 py-8 text-coral">
      <div className="font-display text-lg font-semibold">Something broke on this page.</div>
      <p className="mt-1 max-w-xl text-sm">
        {error.message || "An unexpected error occurred."} You can retry, or navigate away using the sidebar — the rest of
        the console still works.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-[#0F1216] hover:brightness-110"
        >
          Retry
        </button>
        <a
          href="/admin"
          className="rounded-lg border border-coral/40 px-4 py-2 text-sm font-medium text-coral hover:bg-coral/10"
        >
          Back to overview
        </a>
      </div>
      {error.digest && (
        <p className="mt-3 font-mono-label text-[11px] uppercase tracking-wider text-coral/70">
          ref {error.digest}
        </p>
      )}
    </div>
  );
}
