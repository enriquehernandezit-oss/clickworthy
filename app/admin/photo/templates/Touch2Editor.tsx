"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Touch2Template } from "@/lib/settings";
import { composeTouch2, hasComplianceFooter } from "@/worker/lib/outreachEmail";
import { TemplateRenderError } from "@/worker/lib/renderTemplate";

type PreviewRestaurant = { name: string; contactFirstName: string | null; signatureDish: string; city: string | null };
type Identity = { senderName: string; postalAddress: string; signature: string };

// A clearly-fake link, only for the on-page preview below — never sent.
const PREVIEW_FUNNEL_URL = "https://clickworthytool.com/l/preview-token";

const VARS_HELP: { key: string; desc: string }[] = [
  { key: "restaurant", desc: "restaurant name" },
  { key: "dish", desc: "signature dish" },
  { key: "firstName", desc: "owner first name — often empty; use {{greeting}} for the salutation instead of this directly" },
  { key: "greeting", desc: `"Hi Maria," or "Hi there," — already handles the missing-firstName fallback` },
  { key: "city", desc: "city (may be empty)" },
  { key: "senderName", desc: "the sender name set above" },
  { key: "funnelUrl", desc: "the /l/[token] link to their before/after + packages — Touch 2 only" },
  { key: "talkLine", desc: "an optional \"or talk first\" booking line — Touch 2 only, empty unless a booking URL is configured" },
];

// Editor for Touch 2 — subject + body, per language. Unlike Touch 1 / bump,
// this template only sets the SEED text: every real send is also reviewed and
// hand-editable in the moment on the Samples page (approving a finished photo
// reveals this text, editable, right there) — saving here just changes what
// that editable box starts out saying.
export default function Touch2Editor({
  initialTemplate,
  identity,
  previewRestaurant,
}: {
  initialTemplate: Touch2Template;
  identity: Identity;
  previewRestaurant: PreviewRestaurant;
}) {
  const router = useRouter();
  const [template, setTemplate] = useState<Touch2Template>(initialTemplate);
  const [lang, setLang] = useState<"en" | "es">("en");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const dirty = JSON.stringify(template) !== JSON.stringify(initialTemplate);
  const branch = template[lang];

  const preview = useMemo(() => {
    try {
      const composed = composeTouch2({
        restaurantName: previewRestaurant.name,
        firstName: previewRestaurant.contactFirstName,
        dish: previewRestaurant.signatureDish,
        city: previewRestaurant.city,
        funnelUrl: PREVIEW_FUNNEL_URL,
        bookingUrl: null,
        language: lang,
        template,
        identity,
      });
      return { ok: true as const, ...composed };
    } catch (err) {
      return { ok: false as const, error: err instanceof TemplateRenderError ? err.message : "Preview error." };
    }
  }, [template, lang, previewRestaurant, identity]);

  function setBody(text: string) {
    setTemplate((t) => ({ ...t, [lang]: { ...t[lang], body: text } }));
  }
  function setSubject(text: string) {
    setTemplate((t) => ({ ...t, [lang]: { ...t[lang], subject: text } }));
  }

  async function save() {
    setBusy("save");
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("key", "outreach_touch2_template");
      fd.set("value", JSON.stringify(template));
      const res = await fetch("/api/admin/settings", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ text: body?.error ?? "Failed.", ok: false });
      } else {
        setMsg({ text: "Saved. New Touch 2 emails will start from this.", ok: true });
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
      fd.set("which", "touch2");
      fd.set("language", lang);
      fd.set("template", JSON.stringify(template));
      fd.set("senderName", identity.senderName);
      fd.set("postalAddress", identity.postalAddress);
      fd.set("signature", identity.signature);
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
          <div className="text-base font-semibold text-stone-900">Touch 2 — the sample delivery</div>
          <p className="mt-1 max-w-xl text-sm text-stone-600">
            Sent the moment you approve a finished free sample. This sets the SEED text only — every
            send is reviewed and hand-editable on the Samples page before it goes out.
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

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* Editor */}
        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs font-medium text-stone-500">Subject</label>
            <input
              type="text"
              value={branch.subject}
              onChange={(e) => setSubject(e.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-stone-500">Body</label>
            <textarea
              value={branch.body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
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
                <div className="border-b border-stone-200 pb-2 text-sm font-semibold text-stone-900">{preview.subject}</div>
                <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed text-stone-700">{preview.body}</pre>
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
          {busy === "save" ? "Saving…" : "Save"}
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
