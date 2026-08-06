"use client";

// Catch-all for any thrown error inside the admin tree. Renders inside the
// console shell (the layout wraps error boundaries too), so the sidebar stays
// visible and you can navigate away without a hard refresh.
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-6 py-8 text-red-900">
      <div className="font-display text-lg font-semibold">Something broke on this page.</div>
      <p className="mt-1 max-w-xl text-sm">
        {error.message || "An unexpected error occurred."} You can retry, or navigate away using the sidebar — the rest of
        the console still works.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800"
        >
          Retry
        </button>
        <a
          href="/admin"
          className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-800 hover:bg-red-100"
        >
          Back to overview
        </a>
      </div>
      {error.digest && (
        <p className="mt-3 font-mono-label text-[11px] uppercase tracking-wider text-red-700/70">
          ref {error.digest}
        </p>
      )}
    </div>
  );
}
