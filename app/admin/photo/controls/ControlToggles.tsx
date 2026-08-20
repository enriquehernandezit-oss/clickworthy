"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CostKey } from "@/lib/costs";

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
              ? "No Touch 1, bumps, or Touch 2 will send — including ones you've already approved. Reply reading + drafting still run."
              : "The panic button — stops all Gmail sending immediately. Only holds back already-approved sends; it never approves or skips anything on its own."}
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
              ? "The nightly job drafts AND approves itself automatically, up to the daily cap. No human review."
              : "The nightly job only drafts — you approve each one in Approvals before it can ever send."}
          </p>
          <p className="mt-1 text-xs text-stone-500">
            Flipping this on does not approve drafts already waiting — use “Approve all” in Approvals for those.
            {" "}This decides whether a draft gets approved at all — it&apos;s separate from Pause/Resume above, which
            only holds back sends that are already approved.
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

// Editable numeric setting (positive int, or nullable positive int). Renders
// as an inline field + Save button + optional Reset (nullable variant). The
// worker reads the setting on every job run, so a change takes effect on the
// next tick — no restart.
export function NumberSetting({
  settingKey,
  label,
  help,
  value,
  nullable,
  suffix,
  formulaHint,
  step,
  min = 1,
}: {
  settingKey: "outreach_daily_cap" | "bump_after_days" | "outreach_daily_draft_target" | CostKey;
  label: string;
  help: string;
  value: number | null;
  nullable: boolean;
  suffix?: string;
  formulaHint?: string;
  // Cost assumptions are fractional and can be 0 — pass step="0.1" min={0}.
  step?: string | number;
  min?: number;
}) {
  const router = useRouter();
  const [raw, setRaw] = useState(value == null ? "" : String(value));
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const write = async (v: string, kind: "save" | "reset") => {
    setBusy(kind);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("key", settingKey);
      fd.set("value", v);
      const res = await fetch("/api/admin/settings", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ text: body?.error ?? "Failed.", ok: false });
      } else {
        setMsg({ text: "Saved.", ok: true });
        router.refresh();
      }
    } catch {
      setMsg({ text: "Network error.", ok: false });
    } finally {
      setBusy(null);
    }
  };

  const dirty = (raw === "" ? null : Number(raw)) !== value;

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-stone-900">{label}</div>
          <p className="mt-1 max-w-xl text-sm text-stone-600">{help}</p>
          {formulaHint && value == null && (
            <p className="mt-1 text-xs text-stone-500">Currently: {formulaHint}</p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="number"
          min={min}
          step={step}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={nullable ? "(auto)" : ""}
          className="w-28 rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800 tabular-nums"
        />
        {suffix && <span className="text-sm text-stone-500">{suffix}</span>}
        <button
          type="button"
          disabled={busy !== null || !dirty}
          onClick={() => write(raw, "save")}
          className="rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        {nullable && value != null && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => { setRaw(""); write("", "reset"); }}
            className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          >
            {busy === "reset" ? "…" : "Reset"}
          </button>
        )}
        {msg && (
          <span className={`text-xs ${msg.ok ? "text-teal-700" : "text-red-600"}`} role="alert">
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
