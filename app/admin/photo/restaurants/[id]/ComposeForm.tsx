"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// One-off manual email to this restaurant. Goes through the same warmed
// mail@ mailbox as cold outreach, but is logged as touchNumber:0 so it's
// excluded from the daily ramp / bump / Touch-2 flow.
export default function ComposeForm({ restaurantId, hasEmail }: { restaurantId: number; hasEmail: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.confirm(`Send this email now from mail@clickworthytool.com?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("restaurantId", String(restaurantId));
      fd.set("subject", subject.trim());
      fd.set("body", body.trim());
      const res = await fetch("/api/admin/compose", { method: "POST", body: fd });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ text: b?.error ?? "Send failed.", ok: false });
        setBusy(false);
        return;
      }
      setMsg({ text: "Sent.", ok: true });
      setSubject("");
      setBody("");
      setOpen(false);
      router.refresh();
    } catch {
      setMsg({ text: "Network error.", ok: false });
    } finally {
      setBusy(false);
    }
  };

  if (!hasEmail) {
    return <p className="text-xs text-muted">Add an email above to send a message.</p>;
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-black/[0.03]"
          style={{ borderColor: "var(--line)", color: "var(--c-text)" }}
        >
          Send one-off email
        </button>
        {msg && (
          <span className="text-xs" style={{ color: msg.ok ? "var(--teal)" : "var(--coral)" }} role="alert">
            {msg.text}
          </span>
        )}
      </div>
    );
  }

  const inputCls = "mt-1 w-full rounded-lg border border-line-input bg-surface-2 px-3 py-2 text-sm text-text";

  return (
    <form onSubmit={submit} className="rounded-xl border bg-surface-2 p-4" style={{ borderColor: "var(--line)" }}>
      <label className="block text-xs font-medium text-muted">
        Subject
        <input required value={subject} onChange={(e) => setSubject(e.target.value)} className={inputCls} />
      </label>
      <label className="mt-3 block text-xs font-medium text-muted">
        Body
        <textarea required rows={8} value={body} onChange={(e) => setBody(e.target.value)} className={`${inputCls} font-sans leading-relaxed`} />
      </label>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-[#0F1216] hover:brightness-110 disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send now"}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setMsg(null); }}
          className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-black/[0.03]"
          style={{ borderColor: "var(--line)" }}
        >
          Cancel
        </button>
        <span className="text-xs text-muted">Sends from mail@clickworthytool.com · logged as manual (touch 0) · does not count toward the daily ramp.</span>
        {msg && (
          <span className="text-xs" style={{ color: msg.ok ? "var(--teal)" : "var(--coral)" }} role="alert">
            {msg.text}
          </span>
        )}
      </div>
    </form>
  );
}
