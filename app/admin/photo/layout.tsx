import PhotoSubnav from "./PhotoSubnav";

// Photo venture chrome: the gold accent + a page header + the subtab row.
// Sets --accent so every card/eyebrow/subtab inside recolors to the venture.
export default function PhotoLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ["--accent" as string]: "var(--gold)", ["--accent-soft" as string]: "var(--gold-soft)" }}>
      <div className="mb-4">
        <div className="font-mono-label text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--accent)" }}>
          High ticket · Photo Enhancement
        </div>
        <h1 className="font-display text-[22px] font-bold tracking-tight text-[var(--c-text)]">Photo Enhancement</h1>
      </div>
      <PhotoSubnav />
      <div className="mt-6">{children}</div>
    </div>
  );
}
