// Styled "not built yet" panel for the ventures that don't exist as software yet
// (HVAC, Analytics, RE Videos). Keeps the shell complete without faking data.
export default function VenturePlaceholder({
  eyebrow,
  title,
  accent,
  accentSoft,
  tracks,
}: {
  eyebrow: string;
  title: string;
  accent: string;
  accentSoft: string;
  tracks: string;
}) {
  return (
    <div style={{ ["--accent" as string]: accent, ["--accent-soft" as string]: accentSoft }}>
      <div className="mb-6">
        <div className="font-mono-label text-[11px] font-semibold uppercase tracking-wider" style={{ color: accent }}>
          {eyebrow}
        </div>
        <h1 className="font-display text-[22px] font-bold tracking-tight text-[var(--c-text)]">{title}</h1>
      </div>

      <div
        className="flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-20 text-center"
        style={{ borderColor: "var(--line)", background: "var(--card)" }}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: accentSoft }}>
          <svg viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="1.8" className="h-6 w-6">
            <path d="M12 8v4M12 16h.01" />
            <circle cx="12" cy="12" r="9" />
          </svg>
        </div>
        <h2 className="mt-4 font-display text-lg font-semibold text-[var(--c-text)]">Not built yet</h2>
        <p className="mt-2 max-w-md text-sm text-[var(--c-text-muted)]">
          This venture lives in the console for switching, but its software isn&apos;t built. When it is, this panel will
          track {tracks}.
        </p>
      </div>
    </div>
  );
}
