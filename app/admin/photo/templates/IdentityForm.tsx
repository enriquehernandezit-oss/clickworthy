"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Sender name + postal address, both app_settings-backed (see lib/settings.ts).
// Same save-loop shape as NumberSetting in ../controls/ControlToggles.tsx —
// local text state, POST on Save, router.refresh() on success — just for text
// instead of numbers. Deliberately two independent fields/saves: editing one
// shouldn't require re-submitting the other.

async function postSetting(key: string, value: string): Promise<string | null> {
  const fd = new FormData();
  fd.set("key", key);
  fd.set("value", value);
  const res = await fetch("/api/admin/settings", { method: "POST", body: fd });
  if (!res.ok) return (await res.json().catch(() => ({})))?.error ?? "Something went wrong.";
  return null;
}

function TextField({
  settingKey,
  label,
  help,
  value,
  placeholder,
  multiline,
}: {
  settingKey: "outreach_sender_name" | "outreach_postal_address" | "outreach_signature";
  label: string;
  help: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  const router = useRouter();
  const [raw, setRaw] = useState(value);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const dirty = raw !== value;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const err = await postSetting(settingKey, raw).catch(() => "Network error.");
    setBusy(false);
    if (err) return setMsg({ text: err, ok: false });
    setMsg({ text: "Saved.", ok: true });
    router.refresh();
  };

  return (
    <div className="rounded-xl border border-line bg-surface-2 p-5">
      <div className="text-base font-semibold text-text">{label}</div>
      <p className="mt-1 max-w-xl text-sm text-muted">{help}</p>
      <div className={`mt-3 flex ${multiline ? "flex-col items-start" : "flex-wrap items-center"} gap-2`}>
        {multiline ? (
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={placeholder}
            rows={4}
            className="w-full max-w-md rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-text"
          />
        ) : (
          <input
            type="text"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={placeholder}
            className="w-full max-w-md rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-text"
          />
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || !dirty}
            onClick={save}
            className="rounded-lg bg-gold px-3 py-1.5 text-sm font-semibold text-[#0F1216] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {msg && (
            <span className={`text-xs ${msg.ok ? "text-teal" : "text-coral"}`} role="alert">
              {msg.text}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// Saving a new sender name or postal address only changes what FUTURE drafts
// say — drafts already waiting in Approvals keep the old signature and footer
// baked into their stored body. This button recomposes every pending draft with
// the current identity (and current templates), so an identity change actually
// reaches the review pile. Approved drafts are left alone.
function ApplyIdentityToPending({ pendingDrafts }: { pendingDrafts: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const apply = async () => {
    if (!window.confirm(`Rewrite all ${pendingDrafts} pending draft${pendingDrafts === 1 ? "" : "s"} with the current sender name and postal address? Approved drafts are left alone.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("action", "redraft_all");
      const res = await fetch("/api/admin/outreach", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setMsg({ text: body?.error ?? "Failed.", ok: false });
      else {
        setMsg({ text: `Rewrote ${body.updated} draft${body.updated === 1 ? "" : "s"}.`, ok: true });
        router.refresh();
      }
    } catch {
      setMsg({ text: "Network error.", ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-surface-2 p-5">
      <div className="text-base font-semibold text-text">Apply identity to pending drafts</div>
      <p className="mt-1 max-w-xl text-sm text-muted">
        Saving above only affects new drafts. Use this to push the current sender name and postal
        address into the {pendingDrafts} draft{pendingDrafts === 1 ? "" : "s"} already waiting for approval.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || pendingDrafts === 0}
          onClick={apply}
          title={pendingDrafts === 0 ? "No pending drafts to rewrite" : undefined}
          className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm font-semibold text-text hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Applying…" : `Apply to ${pendingDrafts} pending draft${pendingDrafts === 1 ? "" : "s"}`}
        </button>
        {msg && (
          <span className={`text-xs ${msg.ok ? "text-teal" : "text-coral"}`} role="alert">
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

export default function IdentityForm({
  senderName,
  postalAddress,
  signature,
  pendingDrafts,
}: {
  senderName: string;
  postalAddress: string;
  signature: string;
  pendingDrafts: number;
}) {
  return (
    <div className="flex flex-col gap-4">
      {!postalAddress.trim() && (
        <div className="rounded-lg border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral">
          <span className="font-semibold">No postal address set.</span> CAN-SPAM requires a real
          physical address in every commercial email — sending is blocked until this is filled in.
        </div>
      )}
      <TextField
        settingKey="outreach_sender_name"
        label="Sender name"
        help="Signs every outreach email and the Gmail From name — the two must match, so this is the only place to change it."
        value={senderName}
        placeholder="Enrique"
      />
      <TextField
        settingKey="outreach_postal_address"
        label="Postal address"
        help="Appears in the compliance footer of every Touch 1, bump, and Touch 2. Required by CAN-SPAM."
        value={postalAddress}
        placeholder="123 Main St, Miami, FL 33101"
      />
      <TextField
        settingKey="outreach_signature"
        label="Signature"
        help={
          'Appended under "Sender name / Clickworthy" on every outreach email (Touch 1, bump, Touch 2, ' +
          "and replies). Gmail's own signature never applies here — every send goes through the Gmail API " +
          "directly, bypassing the compose window entirely — so this is the only way it appears. Plain text " +
          "only (no logo/HTML)."
        }
        value={signature}
        placeholder={"Founder\n\n868 N Wells St, Chicago, IL 60610\ncontact@clickworthytool.com\nhttps://clickworthytool.com/"}
        multiline
      />
      <ApplyIdentityToPending pendingDrafts={pendingDrafts} />
    </div>
  );
}
