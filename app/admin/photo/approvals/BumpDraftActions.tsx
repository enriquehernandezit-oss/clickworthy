"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, Toast, fieldInputClass } from "../../ui";

// Bump draft controls — body only, no subject (it replies into the Touch 1
// thread). Same FormData -> /api/admin/approvals -> router.refresh() pattern
// as Touch 1's own DraftActions.tsx, just posting bump_* actions instead.
export default function BumpDraftActions({ outreachJobId, body }: { outreachJobId: number; body: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
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
      if (action === "bump_edit") setEditing(false);
      setConfirmingDeny(false);
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  };

  if (editing) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <label className="text-xs font-medium text-faint">
          Body
          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            rows={8}
            className={`mt-1 ${fieldInputClass} font-sans leading-relaxed`}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" loading={busy === "bump_edit"} disabled={busy !== null} onClick={() => post("bump_edit", { body: draftBody })}>
            Save edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              setEditing(false);
              setDraftBody(body);
            }}
          >
            Cancel
          </Button>
        </div>
        {error && <Toast tone="error" message={error} onDismiss={() => setError(null)} />}
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button className="kbd-approve" variant="primary" size="sm" loading={busy === "bump_approve"} disabled={busy !== null} onClick={() => post("bump_approve")}>
          Approve
        </Button>
        <Button className="kbd-edit" variant="secondary" size="sm" disabled={busy !== null} onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button className="kbd-deny" variant="danger" size="sm" disabled={busy !== null} onClick={() => setConfirmingDeny(true)}>
          Deny
        </Button>
      </div>
      {error && <Toast tone="error" message={error} onDismiss={() => setError(null)} />}
      <ConfirmDialog
        open={confirmingDeny}
        title="Deny this bump?"
        description="It won't be drafted again for this restaurant — that's a promise the copy itself makes."
        confirmLabel="Deny"
        danger
        busy={busy === "bump_deny"}
        onConfirm={() => post("bump_deny")}
        onCancel={() => setConfirmingDeny(false)}
      />
    </div>
  );
}
