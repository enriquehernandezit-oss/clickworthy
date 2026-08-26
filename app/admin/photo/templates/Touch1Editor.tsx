"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Touch1Template } from "@/lib/settings";
import { composeTouch1, hasComplianceFooter } from "@/worker/lib/outreachEmail";
import { TemplateRenderError } from "@/worker/lib/renderTemplate";

type PreviewRestaurant = { name: string; contactFirstName: string | null; signatureDish: string; city: string | null };
type Identity = { senderName: string; postalAddress: string; signature: string };

const VARS_HELP: { key: string; desc: string }[] = [
  { key: "restaurant", desc: "restaurant name" },
  { key: "dish", desc: "signature dish" },
  { key: "firstName", desc: "owner first name — often empty; use {{greeting}} for the salutation instead of this directly" },
  { key: "greeting", desc: `"Hi Maria," or "Hi there," — already handles the missing-firstName fallback` },
  { key: "city", desc: "city (may be empty)" },
  { key: "senderName", desc: "the sender name set above" },
];

// Editor for the Touch 1 cold-open template — subjects (3 rotating variants) +
// body, per language. Saves to app_settings (outreach_touch1_template) via the
// existing /api/admin/settings route, which validates syntax server-side too;
// this component's own composeTouch1() call is what powers the live preview,
// so a typo'd {{variable}} is caught here before Save is even clicked.
export default function Touch1Editor({
  initialTemplate,
  identity,
  previewRestaurant,
  pendingDrafts,
  settingsKey = "outreach_touch1_template",
  title = "Touch 1 — the cold open",
  variant = "dish",
}: {
  initialTemplate: Touch1Template;
  identity: Identity;
  previewRestaurant: PreviewRestaurant;
  pendingDrafts: number;
  settingsKey?: "outreach_touch1_template" | "outreach_touch1_nodish_template";
  title?: string;
  variant?: "dish" | "nodish";
}) {
  const router = useRouter();
  const [template, setTemplate] = useState<Touch1Template>(initialTemplate);
  const [lang, setLang] = useState<"en" | "es">("en");
  const [subjectIdx, setSubjectIdx] = useState<0 | 1 | 2>(0);
  const [busy, setBusy] = useState<"save" | "apply" | "test" | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const dirty = JSON.stringify(template) !== JSON.stringify(initialTemplate);
  const branch = template[lang];

  const preview = useMemo(() => {
    try {
      const composed = composeTouch1({
        restaurantName: previewRestaurant.name,
        firstName: previewRestaurant.contactFirstName,
        dish: variant === "nodish" ? "" : previewRestaurant.signatureDish,
        city: previewRestaurant.city,
        language: lang,
        subjectVariant: subjectIdx,
        template,
        identity,
      });
      return { ok: true as const, ...composed };
    } catch (err) {
      return { ok: false as const, error: err instanceof TemplateRenderError ? err.message : "Preview error." };
    }
  }, [template, lang, subjectIdx, previewRestaurant, identity]);

  function setBody(text: string) {
    setTemplate((t) => ({ ...t, [lang]: { ...t[lang], body: text } }));
  }
  function setSubject(i: number, text: string) {
    setTemplate((t) => {
      const subjects = [...t[lang].subjects] as [string, string, string];
      subjects[i] = text;
      return { ...t, [lang]: { ...t[lang], subjects } };
    });
  }

  async function save(): Promise<boolean> {
    setBusy("save");
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("key", settingsKey);
      fd.set("value", JSON.stringify(template));
      const res = await fetch("/api/admin/settings", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ text: body?.error ?? "Failed.", ok: false });
        return false;
      }
      setMsg({ text: "Saved. New drafts will use this.", ok: true });
      router.refresh();
      return true;
    } catch {
      setMsg({ text: "Network error.", ok: false });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function applyToPending() {
    if (
      !window.confirm(
        `Rewrite all ${pendingDrafts} pending draft${pendingDrafts === 1 ? "" : "s"} with this template? Drafts already approved are left alone.`
      )
    )
      return;
    setBusy("apply");
    setMsg(null);
    const saved = dirty ? await save() : true;
    if (!saved) {
      setBusy(null);
      return;
    }
    try {
      const fd = new FormData();
      fd.set("action", "redraft_all");
      const res = await fetch("/api/admin/outreach", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ text: body?.error ?? "Failed.", ok: false });
      } else {
        const skippedNote = body.skipped > 0 ? ` (${body.skipped} skipped — no signature dish on file)` : "";
        setMsg({ text: `Rewrote ${body.updated} draft${body.updated === 1 ? "" : "s"}${skippedNote}.`, ok: true });
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
      fd.set("which", "touch1");
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
    <div className="rounded-xl border border-line bg-surface-2 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-text">{title}</div>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Sent to a queued restaurant once a human approves the draft. Link-free and price-free —
            the only ask is a reply.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-line p-1">
          {(["en", "es"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              className={`rounded-md px-3 py-1 text-xs font-semibold ${lang === l ? "bg-gold text-[#0F1216]" : "text-muted hover:bg-surface-2"}`}
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
            <label className="text-xs font-medium text-muted">Subject lines (rotates across 3, one per restaurant)</label>
            <div className="mt-1 flex flex-col gap-1.5">
              {branch.subjects.map((s, i) => (
                <input
                  key={i}
                  type="text"
                  value={s}
                  onChange={(e) => setSubject(i, e.target.value)}
                  className="w-full rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-text"
                  placeholder={`Subject variant ${i + 1}`}
                />
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted">Body</label>
            <textarea
              value={branch.body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs text-text"
            />
          </div>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer font-medium text-muted">Available variables</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {VARS_HELP.filter((v) => variant === "dish" || v.key !== "dish").map((v) => (
                <li key={v.key}>
                  <code className="rounded bg-surface-2 px-1 py-0.5">{`{{${v.key}}}`}</code> — {v.desc}
                </li>
              ))}
            </ul>
          </details>
        </div>

        {/* Preview */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted">
              Live preview — against &quot;{previewRestaurant.name}&quot;
            </label>
            <div className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSubjectIdx(i as 0 | 1 | 2)}
                  className={`rounded px-2 py-0.5 text-[11px] font-semibold ${subjectIdx === i ? "bg-gold text-[#0F1216]" : "bg-surface-2 text-muted"}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-surface-2 p-3">
            {preview.ok ? (
              <>
                <div className="border-b border-line pb-2 text-sm font-semibold text-text">{preview.subject}</div>
                <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed text-text">{preview.body}</pre>
                {!hasComplianceFooter(preview.body) && (
                  <p className="mt-2 text-xs font-semibold text-coral">
                    ⚠ Missing compliance footer — set the postal address above.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm font-semibold text-coral">{preview.error}</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <button
          type="button"
          disabled={busy !== null || !dirty}
          onClick={save}
          className="rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-[#0F1216] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={sendTest}
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-text hover:bg-surface-2 disabled:opacity-50"
        >
          {busy === "test" ? "Sending…" : "Send test to my inbox"}
        </button>
        <button
          type="button"
          disabled={busy !== null || pendingDrafts === 0}
          onClick={applyToPending}
          className="rounded-lg border border-gold/40 bg-gold/10 px-4 py-2 text-sm font-medium text-gold hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          title={pendingDrafts === 0 ? "No pending drafts to rewrite" : undefined}
        >
          {busy === "apply" ? "Applying…" : `Apply to ${pendingDrafts} pending draft${pendingDrafts === 1 ? "" : "s"}`}
        </button>
        {msg && (
          <span className={`text-xs ${msg.ok ? "text-teal" : "text-coral"}`} role="alert">
            {msg.text}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        Saving only changes future drafts — restaurants already drafted keep their current copy
        until you redraft them individually or use &quot;Apply to pending drafts&quot; above.
      </p>
    </div>
  );
}
