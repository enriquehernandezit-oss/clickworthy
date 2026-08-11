"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { BumpTemplate } from "@/lib/settings";
import { composeBump, hasComplianceFooter } from "@/worker/lib/outreachEmail";
import { TemplateRenderError } from "@/worker/lib/renderTemplate";

type PreviewRestaurant = { name: string; contactFirstName: string | null; signatureDish: string; city: string | null };
type Identity = { senderName: string; postalAddress: string };

const VARS_HELP: { key: string; desc: string }[] = [
  { key: "restaurant", desc: "restaurant name" },
  { key: "dish", desc: "signature dish" },
  { key: "firstName", desc: "owner first name — often empty; use {{greeting}} for the salutation instead of this directly" },
  { key: "greeting", desc: `"Hi Maria," or "Hi there," — already handles the missing-firstName fallback` },
  { key: "city", desc: "city (may be empty)" },
  { key: "senderName", desc: "the sender name set above" },
];

// Editor for the Touch 1.5 bump — body only, per language, no subject (it
// replies into the original Touch 1 thread). UNLIKE Touch 1, a bump has NO
// draft/approval stage: it composes and sends in the same pass, every 4
// minutes, for anyone due. Saving here takes effect on the very next run with
// no human in between — the confirm dialog on Save is the only checkpoint.
export default function BumpEditor({
  initialTemplate,
  identity,
  previewRestaurant,
}: {
  initialTemplate: BumpTemplate;
  identity: Identity;
  previewRestaurant: PreviewRestaurant;
}) {
  const router = useRouter();
  const [template, setTemplate] = useState<BumpTemplate>(initialTemplate);
  const [lang, setLang] = useState<"en" | "es">("en");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const dirty = JSON.stringify(template) !== JSON.stringify(initialTemplate);
  const branch = template[lang];

  const preview = useMemo(() => {
    try {
      const body = composeBump({
        restaurantName: previewRestaurant.name,
        firstName: previewRestaurant.contactFirstName,
        dish: previewRestaurant.signatureDish,
        city: previewRestaurant.city,
        language: lang,
        template,
        identity,
      });
      return { ok: true as const, body };
    } catch (err) {
      return { ok: false as const, error: err instanceof TemplateRenderError ? err.message : "Preview error." };
    }
  }, [template, lang, previewRestaurant, identity]);

  function setBody(text: string) {
    setTemplate((t) => ({ ...t, [lang]: { body: text } }));
  }

  async function save() {
    if (!window.confirm("Save & arm this bump template? It sends automatically — every due lead gets it on the next run, with no draft or approval step.")) {
      return;
    }
    setBusy("save");
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("key", "outreach_bump_template");
      fd.set("value", JSON.stringify(template));
      const res = await fetch("/api/admin/settings", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ text: body?.error ?? "Failed.", ok: false });
      } else {
        setMsg({ text: "Saved & armed. Takes effect on the next reply-cycle run.", ok: true });
        router.refresh();
      }
    } catch {
      setMsg({ text: "Network error.", ok: false });
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy("test");
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("action", "test_send");
      fd.set("which", "bump");
      fd.set("language", lang);
      fd.set("template", JSON.stringify(template));
      fd.set("senderName", identity.senderName);
      fd.set("postalAddress", identity.postalAddress);
      const res = await fetch("/api/admin/templates", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ text: body?.error ?? "Failed.", ok: false });
      } else {
        setMsg({
          text: `Sent to your inbox (previewed against "${body.previewedAgainst}").${body.complianceWarning ?? ""}`,
          ok: !body.complianceWarning,
        });
      }
    } catch {
      setMsg({ text: "Network error.", ok: false });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-stone-900">Touch 1.5 — the bump</div>
          <p className="mt-1 max-w-xl text-sm text-stone-600">
            One-time, same-thread follow-up when Touch 1 gets no reply. Sends automatically — see
            the warning below.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-stone-200 p-1">
          {(["en", "es"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              className={`rounded-md px-3 py-1 text-xs font-semibold ${lang === l ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100"}`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <span className="font-semibold">No review stage.</span> Unlike Touch 1, a bump has no draft
        or approval step — it composes and sends within 4 minutes of becoming due, for every
        restaurant that qualifies. Test it below before saving.
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* Editor */}
        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs font-medium text-stone-500">Body (no subject — replies into the Touch 1 thread)</label>
            <textarea
              value={branch.body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 font-mono text-xs text-stone-800"
            />
          </div>
          <details className="text-xs text-stone-500">
            <summary className="cursor-pointer font-medium text-stone-600">Available variables</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {VARS_HELP.map((v) => (
                <li key={v.key}>
                  <code className="rounded bg-stone-100 px-1 py-0.5">{`{{${v.key}}}`}</code> — {v.desc}
                </li>
              ))}
            </ul>
          </details>
        </div>

        {/* Preview */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-stone-500">
            Live preview — against &quot;{previewRestaurant.name}&quot;
          </label>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            {preview.ok ? (
              <>
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-stone-700">{preview.body}</pre>
                {!hasComplianceFooter(preview.body) && (
                  <p className="mt-2 text-xs font-semibold text-red-600">
                    ⚠ Missing compliance footer — set the postal address above.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm font-semibold text-red-600">{preview.error}</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-200 pt-4">
        <button
          type="button"
          disabled={busy !== null || !dirty}
          onClick={save}
          className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "save" ? "Saving…" : "Save & arm"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={sendTest}
          className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
        >
          {busy === "test" ? "Sending…" : "Send test to my inbox"}
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
