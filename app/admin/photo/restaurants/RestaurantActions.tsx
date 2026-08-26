"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Per-row controls in the restaurant browser. Same shape as SampleActions:
// FormData → /api/admin/restaurants → router.refresh().
export default function RestaurantActions({
  restaurantId,
  email,
  suppressed,
  needsEmail,
  held,
  rejected,
  showEmail = true,
}: {
  restaurantId: number;
  email: string | null;
  suppressed: boolean;
  needsEmail: boolean;
  held: boolean;
  rejected?: boolean;
  // false on the detail page — EditFields owns the email input there, so
  // rendering another one would give the page two disagreeing sources of truth.
  showEmail?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(email ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const post = async (action: string, extra: Record<string, string> = {}) => {
    setBusy(action);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("restaurantId", String(restaurantId));
      fd.set("action", action);
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      const res = await fetch("/api/admin/restaurants", { method: "POST", body: fd });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? "Something went wrong.");
        setBusy(null);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  };

  const dirty = value.trim() !== (email ?? "").trim();

  return (
    <div className="flex flex-col gap-2">
      {showEmail && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="email"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="no email on file"
            className={`w-56 rounded-lg border px-2.5 py-1.5 text-sm text-text placeholder:text-faint ${
              needsEmail && !email ? "border-gold/40 bg-gold/10" : "border-line bg-surface-2"
            }`}
          />
          <button
            type="button"
            disabled={busy !== null || !dirty || !value.trim()}
            onClick={() => post("set_email", { email: value.trim() })}
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-text transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "set_email" ? "Saving…" : "Save"}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {suppressed ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post("unsuppress")}
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            {busy === "unsuppress" ? "Working…" : "Unsuppress"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post("suppress")}
            className="rounded-lg border border-coral/40 px-3 py-1.5 text-sm font-medium text-coral transition-colors hover:bg-coral/10 disabled:opacity-50"
          >
            {busy === "suppress" ? "Working…" : "Suppress"}
          </button>
        )}
        {held ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post("unhold")}
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            {busy === "unhold" ? "Working…" : "Unhold"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post("hold")}
            className="rounded-lg border border-gold/40 px-3 py-1.5 text-sm font-medium text-gold transition-colors hover:bg-gold/10 disabled:opacity-50"
          >
            {busy === "hold" ? "Working…" : "Hold"}
          </button>
        )}
        {rejected && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post("requeue")}
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            {busy === "requeue" ? "Working…" : "Requeue"}
          </button>
        )}
        {needsEmail && !email && <span className="text-xs text-gold">needs an email to send</span>}
      </div>

      {error && <span className="text-sm text-coral">{error}</span>}
    </div>
  );
}
