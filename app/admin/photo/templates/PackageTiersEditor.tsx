"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PACKAGE_ORDER, type PackageId, type PackageTier } from "@/lib/packages";
import { formatPricingBlock } from "@/worker/lib/outreachEmail";

// Editor for the 3 package tiers — the single source of truth for what Touch 2
// quotes in {{pricing}} AND what the /l/[token] funnel actually charges (see
// the PackageTier comment in lib/settings.ts). `id` and the tier count are
// permanent — not editable here, only the display fields, price, and limit.
export default function PackageTiersEditor({ initialTiers }: { initialTiers: Record<PackageId, PackageTier> }) {
  const router = useRouter();
  const [tiers, setTiers] = useState<Record<PackageId, PackageTier>>(initialTiers);
  // Kept as raw text, separate from `tiers[id].priceCents` — a controlled
  // number input reformatted from cents on every keystroke fights the user's
  // cursor (e.g. typing "499." collapses back to "499" mid-edit). Same
  // raw-string-beside-typed-value split as NumberSetting in ControlToggles.tsx.
  const [priceInputs, setPriceInputs] = useState<Record<PackageId, string>>(
    () => Object.fromEntries(PACKAGE_ORDER.map((id) => [id, (initialTiers[id].priceCents / 100).toFixed(2)])) as Record<PackageId, string>
  );
  const [lang, setLang] = useState<"en" | "es">("en");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const dirty = JSON.stringify(tiers) !== JSON.stringify(initialTiers);

  function setPrice(id: PackageId, value: string) {
    setPriceInputs((p) => ({ ...p, [id]: value }));
    const dollars = Number(value);
    if (Number.isFinite(dollars) && dollars >= 0) {
      setTiers((t) => ({ ...t, [id]: { ...t[id], priceCents: Math.round(dollars * 100) } }));
    }
  }

  function setPhotoLimit(id: PackageId, value: string) {
    const n = Math.trunc(Number(value));
    if (Number.isFinite(n) && n > 0) {
      setTiers((t) => ({ ...t, [id]: { ...t[id], photoLimit: n } }));
    }
  }

  function setLangField(id: PackageId, field: "name" | "blurb" | "billingNote", value: string) {
    setTiers((t) => ({ ...t, [id]: { ...t[id], [field]: { ...t[id][field], [lang]: value } } }));
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("key", "package_tiers");
      fd.set("value", JSON.stringify(tiers));
      const res = await fetch("/api/admin/settings", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ text: body?.error ?? "Failed.", ok: false });
      } else {
        setMsg({ text: "Saved. New Touch 2 drafts and the checkout page use these prices immediately.", ok: true });
        router.refresh();
      }
    } catch {
      setMsg({ text: "Network error.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface-2 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-text">Package pricing</div>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Drives the Touch 2 {"{{pricing}}"} block below AND the /l/[token] checkout page — one edit, both
            update, so the email can never quote a number checkout won&apos;t charge.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-line p-1">
          {(["en", "es"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              className={`rounded-md px-3 py-1 text-xs font-semibold ${lang === l ? "bg-gold text-[#0F1216]" : "text-muted hover:bg-surface-2"}`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {PACKAGE_ORDER.map((id) => {
          const tier = tiers[id];
          return (
            <div key={id} className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface-2 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <code className="text-[10px] uppercase tracking-wide text-faint">{id}</code>
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                  {tier.checkoutEnabled ? "online checkout" : "book a call"}
                </span>
              </div>

              <div>
                <label className="text-xs font-medium text-muted">Name ({lang.toUpperCase()})</label>
                <input
                  type="text"
                  value={tier.name[lang]}
                  onChange={(e) => setLangField(id, "name", e.target.value)}
                  className="mt-1 w-full rounded-lg border border-line-input bg-surface-2 px-3 py-1.5 text-sm text-text"
                />
              </div>

              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-xs font-medium text-muted">Price</label>
                  <div className="mt-1 flex items-center gap-1">
                    <span className="text-sm text-muted">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={priceInputs[id]}
                      onChange={(e) => setPrice(id, e.target.value)}
                      className="w-full rounded-lg border border-line-input bg-surface-2 px-3 py-1.5 text-sm text-text tabular-nums"
                    />
                  </div>
                </div>
                <div className="w-24">
                  <label className="text-xs font-medium text-muted">Photos</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={tier.photoLimit}
                    onChange={(e) => setPhotoLimit(id, e.target.value)}
                    className="mt-1 w-full rounded-lg border border-line-input bg-surface-2 px-3 py-1.5 text-sm text-text tabular-nums"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted">Billing note ({lang.toUpperCase()})</label>
                <input
                  type="text"
                  value={tier.billingNote[lang]}
                  onChange={(e) => setLangField(id, "billingNote", e.target.value)}
                  placeholder="one-time"
                  className="mt-1 w-full rounded-lg border border-line-input bg-surface-2 px-3 py-1.5 text-sm text-text"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted">Description ({lang.toUpperCase()})</label>
                <textarea
                  value={tier.blurb[lang]}
                  onChange={(e) => setLangField(id, "blurb", e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-line-input bg-surface-2 px-3 py-2 text-xs text-text"
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <label className="text-xs font-medium text-muted">Live preview of the Touch 2 {"{{pricing}}"} block</label>
        <div className="rounded-lg border border-line bg-surface-2 p-3">
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-text">{formatPricingBlock(tiers, lang)}</pre>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={save}
          className="rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-[#0F1216] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {msg && (
          <span className={`text-xs ${msg.ok ? "text-teal" : "text-coral"}`} role="alert">
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
