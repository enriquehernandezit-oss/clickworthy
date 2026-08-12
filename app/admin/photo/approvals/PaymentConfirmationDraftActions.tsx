"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Payment-confirmation draft controls — subject + body editable, prefilled
// from what the Stripe webhook composed. Send / Deny, no separate approve
// step (same shape as the reply's own actions).
export default function PaymentConfirmationDraftActions({
  outreachJobId,
  subject,
  body,
}: {
  outreachJobId: number;
  subject: string;
  body: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftSubject, setDraftSubject] = useState(subject);
  const [draftBody, setDraftBody] = useState(body);

  const post = async (action: string, extra: Record<string, string> = {}, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(action);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("action", action);
      fd.set("outreachJobId", String(outreachJobId));
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      const res = await fetch("/api/admin/approvals", { method: "POST", body: fd });
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

  return (
    <div className="mt-3 flex flex-col gap-2">
      <label className="text-xs font-medium text-stone-500">
        Subject
        <input
          value={draftSubject}
          onChange={(e) => setDraftSubject(e.target.value)}
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800"
        />
      </label>
      <label className="text-xs font-medium text-stone-500">
        Body
        <textarea
          value={draftBody}
          onChange={(e) => setDraftBody(e.target.value)}
          rows={6}
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm leading-relaxed text-stone-800"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy !== null || !draftSubject.trim() || !draftBody.trim()}
          onClick={() => post("payment_confirmation_send", { subject: draftSubject, body: draftBody })}
          className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
        >
          {busy === "payment_confirmation_send" ? "Sending…" : "Send"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => post("payment_confirmation_deny", {}, "Deny this confirmation email? It won't be sent — the customer already has Stripe's own redirect to their upload page.")}
          className="rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
        >
          {busy === "payment_confirmation_deny" ? "Denying…" : "Deny"}
        </button>
        {error && <span className="text-sm text-red-600" role="alert">{error}</span>}
      </div>
    </div>
  );
}
