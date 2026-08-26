"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, Toast, fieldInputClass } from "../../ui";

// Reply draft controls. The body starts BLANK, always — no LLM drafting
// anywhere in this path, by design. Send writes and sends atomically (no
// separate approve step, and no extra confirm on top — writing the reply IS
// the deliberate act here): there's nothing to approve until a person has
// actually written something.
export default function ReplyDraftActions({
  outreachJobId,
  quotedMessage,
  quotedFrom,
}: {
  outreachJobId: number;
  quotedMessage: string;
  quotedFrom: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
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
      <div className="rounded-lg border border-line bg-surface-2 p-3">
        <div className="text-xs font-medium text-faint">{quotedFrom ?? "They"} wrote:</div>
        <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{quotedMessage || "(no message text)"}</p>
      </div>
      <label className="text-xs font-medium text-faint">
        Your reply
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="Write your reply…"
          className={`mt-1 ${fieldInputClass} leading-relaxed`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button className="kbd-approve" variant="primary" size="sm" loading={busy === "reply_send"} disabled={busy !== null || !body.trim()} onClick={() => post("reply_send", { body })}>
          Send
        </Button>
        <Button className="kbd-deny" variant="danger" size="sm" disabled={busy !== null} onClick={() => setConfirmingDeny(true)}>
          Deny
        </Button>
      </div>
      {error && <Toast tone="error" message={error} onDismiss={() => setError(null)} />}
      <ConfirmDialog
        open={confirmingDeny}
        title="Deny this reply?"
        description="Nothing will be sent back for this message."
        confirmLabel="Deny"
        danger
        busy={busy === "reply_deny"}
        onConfirm={() => post("reply_deny")}
        onCancel={() => setConfirmingDeny(false)}
      />
    </div>
  );
}
