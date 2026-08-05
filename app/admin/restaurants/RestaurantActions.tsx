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
}: {
  restaurantId: number;
  email: string | null;
  suppressed: boolean;
  needsEmail: boolean;
  held: boolean;
  rejected?: boolean;
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
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="no email on file"
          className={`w-56 rounded-lg border px-2.5 py-1.5 text-sm text-stone-800 placeholder:text-stone-400 ${
            needsEmail && !email ? "border-amber-400 bg-amber-50" : "border-stone-300 bg-white"
          }`}
        />
        <button
          type="button"
          disabled={busy !== null || !dirty || !value.trim()}
          onClick={() => post("set_email", { email: value.trim() })}
          className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "set_email" ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {suppressed ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post("unsuppress")}
            className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
          >
            {busy === "unsuppress" ? "Working…" : "Unsuppress"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post("suppress")}
            className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
          >
            {busy === "suppress" ? "Working…" : "Suppress"}
          </button>
        )}
        {held ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post("unhold")}
            className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
          >
            {busy === "unhold" ? "Working…" : "Unhold"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post("hold")}
            className="rounded-lg border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-50"
          >
            {busy === "hold" ? "Working…" : "Hold"}
          </button>
        )}
        {rejected && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => post("requeue")}
            className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
          >
            {busy === "requeue" ? "Working…" : "Requeue"}
          </button>
        )}
        {needsEmail && !email && <span className="text-xs text-amber-700">needs an email to send</span>}
      </div>

      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
