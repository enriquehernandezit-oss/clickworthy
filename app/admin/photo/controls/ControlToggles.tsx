"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

async function postSetting(key: string, value: boolean): Promise<string | null> {
  const fd = new FormData();
  fd.set("key", key);
  fd.set("value", String(value));
  const res = await fetch("/api/admin/settings", { method: "POST", body: fd });
  if (!res.ok) return (await res.json().catch(() => ({})))?.error ?? "Something went wrong.";
  return null;
}

// The panic button. Paused = a loud red strip + a green Resume; running = a
// quiet red Pause.
export function PauseControl({ paused }: { paused: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flip = async (to: boolean) => {
    if (to && !window.confirm("Pause ALL outreach sending (Touch 1, bumps, Touch 2)? Drafting and reply-reading continue.")) return;
    setBusy(true);
    setError(null);
    const err = await postSetting("outreach_paused", to).catch(() => "Network error.");
    setBusy(false);
    if (err) return setError(err);
    router.refresh();
  };

  return (
    <div
      className={`rounded-xl border p-5 ${
        paused ? "border-red-300 bg-red-50" : "border-stone-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className={`text-base font-semibold ${paused ? "text-red-700" : "text-stone-900"}`}>
              {paused ? "OUTREACH PAUSED" : "Outreach sending is live"}
            </span>
          </div>
          <p className="mt-1 text-sm text-stone-600">
            {paused
              ? "No Touch 1, bumps, or Touch 2 will send. Reply reading + drafting still run."
              : "The panic button — stops all Gmail sending immediately, without touching your drafts or settings."}
          </p>
        </div>
        {paused ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => flip(false)}
            className="btn-press rounded-lg bg-green-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? "Resuming…" : "Resume sending"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => flip(true)}
            className="btn-press rounded-lg bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? "Pausing…" : "Pause all sending"}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

// Approval-mode vs autosend.
export function AutosendControl({ autosend }: { autosend: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flip = async (to: boolean) => {
    if (
      to &&
      !window.confirm(
        "Turn ON autosend? New Touch-1 drafts will approve and send themselves, up to the daily cap, with no review. (Drafts already waiting are NOT auto-approved.)"
      )
    )
      return;
    setBusy(true);
    setError(null);
    const err = await postSetting("outreach_autosend", to).catch(() => "Network error.");
    setBusy(false);
    if (err) return setError(err);
    router.refresh();
  };

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-base font-semibold text-stone-900">
            {autosend ? "Autosend is ON" : "Approval mode"}
          </div>
          <p className="mt-1 max-w-xl text-sm text-stone-600">
            {autosend
              ? "The nightly job drafts AND sends automatically, up to the daily cap. No human review."
              : "The nightly job only drafts — you approve each one in Outreach before it sends."}
          </p>
          <p className="mt-1 text-xs text-stone-500">
            Flipping this on does not approve drafts already waiting — use “Approve all” in Outreach for those.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => flip(!autosend)}
          className={`btn-press rounded-lg px-5 py-2.5 text-sm font-semibold disabled:opacity-50 ${
            autosend
              ? "border border-stone-300 bg-white text-stone-800 hover:bg-stone-100"
              : "bg-orange-600 text-white hover:bg-orange-700"
          }`}
        >
          {busy ? "Saving…" : autosend ? "Switch to approval mode" : "Turn on autosend"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
