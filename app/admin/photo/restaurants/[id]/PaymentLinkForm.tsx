"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PACKAGE_ORDER, type PackageId, type PackageTier } from "@/lib/packages";

// Generates a Stripe Payment Link for a package this restaurant has already
// agreed to (on a call, by reply, however) and hands back a URL to paste into
// your own email/message — see app/api/admin/paymentlink/route.ts for why this
// exists separately from the /l/[token] funnel's own checkout.
export default function PaymentLinkForm({
  restaurantId,
  packages,
}: {
  restaurantId: number;
  // Live tiers, fetched server-side by the page (client component — can't call
  // getPackages()/getSetting() itself, see lib/packages.ts).
  packages: Record<PackageId, PackageTier>;
}) {
  const router = useRouter();
  const [packageId, setPackageId] = useState<PackageId>("glow_up");
  const [overrideDollars, setOverrideDollars] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; priceCents: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const listed = packages[packageId];

  const generate = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const fd = new FormData();
      fd.set("restaurantId", String(restaurantId));
      fd.set("packageId", packageId);
      if (overrideDollars.trim()) {
        const dollars = Number(overrideDollars);
        if (!Number.isFinite(dollars) || dollars <= 0) {
          setError("Override amount must be a positive number.");
          setBusy(false);
          return;
        }
        fd.set("overrideCents", String(Math.round(dollars * 100)));
      }
      const res = await fetch("/api/admin/paymentlink", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? "Failed.");
      } else {
        setResult({ url: body.url, priceCents: body.priceCents });
        router.refresh(); // the Magic links section below picks up the new row
      }
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be denied — the URL is still selectable/visible below.
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-muted" htmlFor="pkg">
            Package
          </label>
          <select
            id="pkg"
            value={packageId}
            onChange={(e) => {
              setPackageId(e.target.value as PackageId);
              setResult(null);
            }}
            className="mt-1 rounded-lg border border-line-input bg-surface-2 px-3 py-1.5 text-sm text-text"
          >
            {PACKAGE_ORDER.map((id) => (
              <option key={id} value={id}>
                {packages[id].name.en} — ${(packages[id].priceCents / 100).toFixed(0)}
                {id === "always_fresh" ? "/mo" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted" htmlFor="override">
            Override amount (optional)
          </label>
          <div className="mt-1 flex items-center gap-1">
            <span className="text-sm text-muted">$</span>
            <input
              id="override"
              type="number"
              min="1"
              step="0.01"
              value={overrideDollars}
              onChange={(e) => setOverrideDollars(e.target.value)}
              placeholder={(listed.priceCents / 100).toFixed(2)}
              className="w-28 rounded-lg border border-line-input bg-surface-2 px-3 py-1.5 text-sm text-text tabular-nums"
            />
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={generate}
          className="rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-[#0F1216] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Generating…" : "Generate link"}
        </button>
      </div>

      {listed.id === "always_fresh" && (
        <p className="text-xs text-muted">
          This charges the first month only ({(listed.priceCents / 100).toFixed(0)}). Renewals are recorded with
          &quot;Mark paid&quot; on the order until recurring billing exists.
        </p>
      )}

      {error && (
        <p className="rounded-lg border border-coral/40 bg-coral/10 px-3 py-2 text-sm text-coral" role="alert">
          {error}
        </p>
      )}

      {result && (
        <div className="rounded-lg border border-teal/40 bg-teal/10 px-3 py-2">
          <p className="text-xs font-semibold text-teal">
            Link created for ${(result.priceCents / 100).toFixed(2)} — doesn&apos;t expire. Paste it wherever
            you&apos;re closing the deal.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={result.url}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-lg border border-line-input bg-surface-2 px-3 py-1.5 text-xs text-text"
            />
            <button
              type="button"
              onClick={copy}
              className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-text hover:bg-surface-2"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
