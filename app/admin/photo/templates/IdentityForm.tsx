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
}: {
  settingKey: "outreach_sender_name" | "outreach_postal_address";
  label: string;
  help: string;
  value: string;
  placeholder?: string;
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
    <div className="rounded-xl border border-stone-200 bg-white p-5">
      <div className="text-base font-semibold text-stone-900">{label}</div>
      <p className="mt-1 max-w-xl text-sm text-stone-600">{help}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={placeholder}
          className="w-full max-w-md rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800"
        />
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={save}
          className="rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {msg && (
          <span className={`text-xs ${msg.ok ? "text-teal-700" : "text-red-600"}`} role="alert">
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

export default function IdentityForm({ senderName, postalAddress }: { senderName: string; postalAddress: string }) {
  return (
    <div className="flex flex-col gap-4">
      {!postalAddress.trim() && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
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
    </div>
  );
}
