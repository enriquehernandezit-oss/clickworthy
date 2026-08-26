"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, Toast, fieldInputClass } from "../../ui";

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
  const [confirmingDeny, setConfirmingDeny] = useState(false);

  const post = async (action: string, extra: Record<string, string> = {}) => {
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
      setConfirmingDeny(false);
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <label className="text-xs font-medium text-faint">
        Subject
        <input value={draftSubject} onChange={(e) => setDraftSubject(e.target.value)} className={`mt-1 ${fieldInputClass}`} />
      </label>
      <label className="text-xs font-medium text-faint">
        Body
        <textarea value={draftBody} onChange={(e) => setDraftBody(e.target.value)} rows={6} className={`mt-1 ${fieldInputClass} leading-relaxed`} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="kbd-approve"
          variant="primary"
          size="sm"
          loading={busy === "payment_confirmation_send"}
          disabled={busy !== null || !draftSubject.trim() || !draftBody.trim()}
          onClick={() => post("payment_confirmation_send", { subject: draftSubject, body: draftBody })}
        >
          Send
        </Button>
        <Button className="kbd-deny" variant="danger" size="sm" disabled={busy !== null} onClick={() => setConfirmingDeny(true)}>
          Deny
        </Button>
      </div>
      {error && <Toast tone="error" message={error} onDismiss={() => setError(null)} />}
      <ConfirmDialog
        open={confirmingDeny}
        title="Deny this confirmation email?"
        description="It won't be sent — the customer already has Stripe's own redirect to their upload page."
        confirmLabel="Deny"
        danger
        busy={busy === "payment_confirmation_deny"}
        onConfirm={() => post("payment_confirmation_deny")}
        onCancel={() => setConfirmingDeny(false)}
      />
    </div>
  );
}
