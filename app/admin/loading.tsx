// Shown while any admin page's server-side data is loading. Renders inside the
// console shell (the layout wraps this too), so the sidebar and topbar stay put
// and only the content area shows the spinner — page transitions never blank.
export default function AdminLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <div className="flex items-center gap-3" style={{ color: "var(--c-text-faint)" }}>
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 animate-spin">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="14 30" />
        </svg>
        <span className="font-mono-label text-[11px] uppercase tracking-wider">Loading…</span>
      </div>
    </div>
  );
}
