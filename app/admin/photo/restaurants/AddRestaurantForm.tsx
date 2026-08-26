"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Walk-in lead entry — the only path into `restaurants` besides Google Places
// sourcing. If the row has an email + a signature dish it enters the pipeline
// as `queued`; otherwise it lands `needs_manual_email` and shows the "needs an
// email to send" nudge in the list.
export default function AddRestaurantForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", city: "", email: "", signatureDish: "", contactFirstName: "", language: "en" });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("action", "create");
      for (const [k, v] of Object.entries(form)) fd.set(k, v.trim());
      const res = await fetch("/api/admin/restaurants", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? "Failed.");
        setBusy(false);
        return;
      }
      setOpen(false);
      setForm({ name: "", city: "", email: "", signatureDish: "", contactFirstName: "", language: "en" });
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "mt-1 w-full rounded-lg border border-line-input bg-surface-2 px-3 py-1.5 text-sm text-text";
  const labelCls = "block text-xs font-medium text-muted";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-black/[0.03]"
        style={{ borderColor: "var(--line)", color: "var(--c-text)" }}
      >
        + Add restaurant
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-2 rounded-xl border bg-surface-2 p-4" style={{ borderColor: "var(--line)" }}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="ar-name">Name *</label>
          <input id="ar-name" required value={form.name} onChange={set("name")} className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="ar-city">City</label>
          <input id="ar-city" value={form.city} onChange={set("city")} className={inputCls} placeholder="Miami, FL" />
        </div>
        <div>
          <label className={labelCls} htmlFor="ar-email">Email</label>
          <input id="ar-email" type="email" value={form.email} onChange={set("email")} className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="ar-dish">Signature dish</label>
          <input id="ar-dish" value={form.signatureDish} onChange={set("signatureDish")} className={inputCls} placeholder="e.g. birria tacos" />
        </div>
        <div>
          <label className={labelCls} htmlFor="ar-name-first">Contact first name</label>
          <input id="ar-name-first" value={form.contactFirstName} onChange={set("contactFirstName")} className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="ar-lang">Language</label>
          <select id="ar-lang" value={form.language} onChange={set("language")} className={inputCls}>
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-[#0F1216] hover:brightness-110 disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add lead"}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(null); }}
          className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-black/[0.03]"
          style={{ borderColor: "var(--line)" }}
        >
          Cancel
        </button>
        <span className="text-xs text-muted">Email + signature dish → enters the queue. Missing either → held for a human to complete.</span>
        {error && <span className="text-sm text-coral" role="alert">{error}</span>}
      </div>
    </form>
  );
}
