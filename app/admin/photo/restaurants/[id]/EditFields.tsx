"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Inline dossier edit — the place to fix a wrong signature dish or name before
// approving the draft (then use Redraft in Outreach to recompose from these).
export default function EditFields({
  restaurantId,
  email,
  signatureDish,
  contactFirstName,
  language,
}: {
  restaurantId: number;
  email: string | null;
  signatureDish: string | null;
  contactFirstName: string | null;
  language: string;
}) {
  const router = useRouter();
  const [form, setForm] = useState({
    email: email ?? "",
    signatureDish: signatureDish ?? "",
    contactFirstName: contactFirstName ?? "",
    language: language === "es" ? "es" : "en",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("action", "set_fields");
      fd.set("restaurantId", String(restaurantId));
      fd.set("email", form.email.trim());
      fd.set("signatureDish", form.signatureDish);
      fd.set("contactFirstName", form.contactFirstName);
      fd.set("language", form.language);
      const res = await fetch("/api/admin/restaurants", { method: "POST", body: fd });
      if (!res.ok) {
        setMsg({ text: (await res.json().catch(() => ({})))?.error ?? "Failed.", ok: false });
        setBusy(false);
        return;
      }
      setMsg({ text: "Saved.", ok: true });
      router.refresh();
    } catch {
      setMsg({ text: "Network error.", ok: false });
    } finally {
      setBusy(false);
    }
  };

  const field = "mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800";
  const label = "block text-xs font-medium text-stone-500";

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label className={label} htmlFor="ef-email">Email</label>
        <input id="ef-email" type="email" value={form.email} onChange={set("email")} className={field} placeholder="none on file" />
      </div>
      <div>
        <label className={label} htmlFor="ef-dish">Signature dish</label>
        <input id="ef-dish" value={form.signatureDish} onChange={set("signatureDish")} className={field} placeholder="e.g. birria tacos" />
      </div>
      <div>
        <label className={label} htmlFor="ef-name">Contact first name</label>
        <input id="ef-name" value={form.contactFirstName} onChange={set("contactFirstName")} className={field} placeholder="optional" />
      </div>
      <div>
        <label className={label} htmlFor="ef-lang">Language</label>
        <select id="ef-lang" value={form.language} onChange={set("language")} className={field}>
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>
      </div>
      <div className="sm:col-span-2 flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={save}
          className="btn-press rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-800 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save fields"}
        </button>
        {msg && <span className={`text-sm ${msg.ok ? "text-green-700" : "text-red-600"}`}>{msg.text}</span>}
        <span className="text-xs text-stone-500">
          Fixing the dish or name? Redraft the pending Touch 1 in Outreach afterward.
        </span>
      </div>
    </div>
  );
}
