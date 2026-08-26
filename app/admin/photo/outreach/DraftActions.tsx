"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, Toast, fieldInputClass } from "../../ui";

// Per-draft controls (approve / edit / redraft / skip). Same FormData →
// /api/admin/outreach → router.refresh() pattern as SampleActions.
//
// Approve gets no confirmation — it's the expected, high-frequency action on
// this page (per Emil's frequency rule: an action done tens of times a day
// shouldn't carry friction or motion). Redraft and Skip go through
// ConfirmDialog instead of window.confirm() — both are recoverable (a redraft
// can be re-edited, a skip can be unheld from the restaurant page) so neither
// needs the typed-confirmation fence reserved for irreversible sends.
export default function DraftActions({
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
  const [editing, setEditing] = useState(false);
  const [draftSubject, setDraftSubject] = useState(subject);
  const [draftBody, setDraftBody] = useState(body);
  const [confirming, setConfirming] = useState<"redraft" | "skip" | null>(null);

  const post = async (action: string, extra: Record<string, string> = {}) => {
    setBusy(action);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("action", action);
      fd.set("outreachJobId", String(outreachJobId));
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      const res = await fetch("/api/admin/outreach", { method: "POST", body: fd });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? "Something went wrong.");
        setBusy(null);
        return;
      }
      if (action === "set_content") setEditing(false);
      setConfirming(null);
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
          Subject
          <input value={draftSubject} onChange={(e) => setDraftSubject(e.target.value)} className={`mt-1 ${fieldInputClass}`} />
        </label>
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
          <Button variant="primary" size="sm" loading={busy === "set_content"} disabled={busy !== null} onClick={() => post("set_content", { subject: draftSubject, body: draftBody })}>
            Save edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              setEditing(false);
              setDraftSubject(subject);
              setDraftBody(body);
            }}
          >
            Cancel
          </Button>
          <span className="text-xs text-faint">Saving keeps it a draft. Redraft later overwrites your edit.</span>
        </div>
        {error && <Toast tone="error" message={error} onDismiss={() => setError(null)} />}
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button className="kbd-approve" variant="primary" size="sm" loading={busy === "approve"} disabled={busy !== null} onClick={() => post("approve")}>
          Approve
        </Button>
        <Button className="kbd-edit" variant="secondary" size="sm" disabled={busy !== null} onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setConfirming("redraft")}>
          Redraft
        </Button>
        <Button className="kbd-deny" variant="secondary" size="sm" disabled={busy !== null} onClick={() => setConfirming("skip")}>
          Skip
        </Button>
      </div>
      {error && <Toast tone="error" message={error} onDismiss={() => setError(null)} />}

      <ConfirmDialog
        open={confirming === "redraft"}
        title="Redraft this email?"
        description="Recomposes it from the restaurant's current fields. Any hand-edits you've made will be lost."
        confirmLabel="Redraft"
        busy={busy === "redraft"}
        onConfirm={() => post("redraft")}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDialog
        open={confirming === "skip"}
        title="Skip this restaurant?"
        description="The draft is deleted and the restaurant is held — it won't be drafted again until you unhold it from its profile."
        confirmLabel="Skip"
        danger
        busy={busy === "skip"}
        onConfirm={() => post("skip")}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}

export function ApproveAllButton({ count }: { count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const approveAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("action", "approve_all");
      const res = await fetch("/api/admin/outreach", { method: "POST", body: fd });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? "Something went wrong.");
        setBusy(false);
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <Button variant="primary" size="sm" onClick={() => setConfirming(true)}>
        Approve all ({count})
      </Button>
      {error && <Toast tone="error" message={error} onDismiss={() => setError(null)} />}
      <ConfirmDialog
        open={confirming}
        title={`Approve all ${count} drafts?`}
        description="They'll send on the next send run, subject to the daily cap."
        confirmLabel="Approve all"
        busy={busy}
        onConfirm={approveAll}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
