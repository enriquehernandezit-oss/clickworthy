// Photo venture chrome: the gold accent + a page header. Sets --accent so
// every card/eyebrow inside recolors to the venture. The subtab row this
// used to render is gone — the Sidebar now owns Photo navigation as four
// grouped sections (WORK/PIPELINE/MONEY/SYSTEM), so there's no longer a
// second, flatter nav competing with it in the same view.
export default function PhotoLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ["--accent" as string]: "var(--gold)", ["--accent-soft" as string]: "var(--gold-soft)" }}>
      <div className="mb-6">
        <div className="font-mono-label text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--accent)" }}>
          High ticket · Photo Enhancement
        </div>
        <h1 className="font-display text-[22px] font-bold tracking-tight text-[var(--c-text)]">Photo Enhancement</h1>
      </div>
      {children}
    </div>
  );
}
