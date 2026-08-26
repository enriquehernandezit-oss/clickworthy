"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const REASONS = ["manual", "opt_out", "bounce", "complaint"] as const;

async function postAction(action: string, fields: Record<string, string>): Promise<string | null> {
  const fd = new FormData();
  fd.set("action", action);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const res = await fetch("/api/admin/suppressions", { method: "POST", body: fd });
  if (!res.ok) return (await res.json().catch(() => ({})))?.error ?? "Something went wrong.";
  return null;
}

// Manual add. Suppressing here also flags any restaurant row with that address,
// so the lead browser and the send-time check agree.
export function AddSuppressionForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState<string>("manual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const err = await postAction("add", { email: email.trim(), reason }).catch(() => "Network error.");
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setEmail("");
    router.refresh();
  };

  return (
    <div className="mt-5 flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="supp-email" className="block text-xs font-medium text-muted">
          Email
        </label>
        <input
          id="supp-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="owner@restaurant.com"
          className="mt-1 w-64 rounded-lg border border-line-input bg-surface-2 px-3 py-1.5 text-sm text-text placeholder:text-faint"
        />
      </div>
      <div>
        <label htmlFor="supp-reason" className="block text-xs font-medium text-muted">
          Reason
        </label>
        <select
          id="supp-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1 rounded-lg border border-line-input bg-surface-2 px-3 py-1.5 text-sm text-text"
        >
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        disabled={busy || !email.trim()}
        onClick={submit}
        className="btn-press rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-[#0F1216] hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted"
      >
        {busy ? "Adding…" : "Add"}
      </button>
      {error && <span className="pb-2 text-sm text-coral">{error}</span>}
    </div>
  );
}

export default function SuppressionActions({ email }: { email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!window.confirm(`Remove ${email} from the do-not-contact list? They will become eligible for cold email again — someone who opted out could get contacted.`)) return;
    setBusy(true);
    setError(null);
    const err = await postAction("remove", { email }).catch(() => "Network error.");
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    router.refresh();
  };

  return (
    <div className="flex items-center justify-end gap-2">
      {error && <span className="text-xs text-coral">{error}</span>}
      <button
        type="button"
        disabled={busy}
        onClick={remove}
        className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
      >
        {busy ? "Removing…" : "Remove"}
      </button>
    </div>
  );
}
