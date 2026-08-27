"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "../../primitives";
import type { BumpTemplate } from "@/lib/settings";
import { composeBump, hasComplianceFooter } from "@/worker/lib/outreachEmail";
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

// Editor for the Touch 1.5 bump — body only, per language, no subject (it
// replies into the original Touch 1 thread). Like Touch 1, a bump is drafted
// automatically and then waits for a human to approve or deny it in
// Approvals — saving here only changes what a NEW draft starts out saying;
// anything already drafted keeps its current copy.
export default function BumpEditor({
  initialTemplate,
  identity,
  previewRestaurant,
  pendingDrafts,
}: {
  initialTemplate: BumpTemplate;
  identity: Identity;
  previewRestaurant: PreviewRestaurant;
  pendingDrafts: number;
}) {
  const router = useRouter();
  const [template, setTemplate] = useState<BumpTemplate>(initialTemplate);
  const [lang, setLang] = useState<"en" | "es">("en");
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState<"save" | "apply" | "test" | null>(null);
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

  async function save(): Promise<boolean> {
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
        return false;
      }
      setMsg({ text: "Saved. New bump drafts will use this — still waiting on your approval before they send.", ok: true });
      router.refresh();
      return true;
    } catch {
      setMsg({ text: "Network error.", ok: false });
      return false;
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

  // Saving only changes what a NEW bump draft starts out saying; bumps already
  // waiting in Approvals keep their old copy. This pushes the current template
  // into those pending drafts — the bump equivalent of Touch 1's same button.
  // Approved-but-unsent bumps are deliberately left alone by the API.
  async function applyToPending() {
    const ok = await confirm({
      title: `Rewrite ${pendingDrafts} pending bump draft${pendingDrafts === 1 ? "" : "s"}?`,
      description: "They'll be recomposed with this template. Bumps you've already approved are left alone.",
      confirmLabel: "Rewrite drafts",
    });
    if (!ok) return;
    setBusy("apply");
    setMsg(null);
    const saved = dirty ? await save() : true;
    if (!saved) {
      setBusy(null);
      return;
    }
    try {
      const fd = new FormData();
      fd.set("action", "redraft_all_bumps");
      const res = await fetch("/api/admin/outreach", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ text: body?.error ?? "Failed.", ok: false });
      } else {
        const skippedNote = body.skipped > 0 ? ` (${body.skipped} skipped)` : "";
        setMsg({ text: `Rewrote ${body.updated} bump draft${body.updated === 1 ? "" : "s"}${skippedNote}.`, ok: true });
        router.refresh();
      }
    } catch {
      setMsg({ text: "Network error.", ok: false });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface-2 p-5">
      {confirmDialog}
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-text">Touch 1.5 — the bump</div>
          <p className="mt-1 max-w-xl text-sm text-muted">
            One-time, same-thread follow-up when Touch 1 gets no reply. Drafted automatically —
            approve or deny each one in Approvals.
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
            <label className="text-xs font-medium text-muted">Body (no subject — replies into the Touch 1 thread)</label>
            <textarea
              value={branch.body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="mt-1 w-full rounded-lg border border-line-input bg-surface-2 px-3 py-2 font-mono text-xs text-text"
            />
          </div>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer font-medium text-muted">Available variables</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {VARS_HELP.map((v) => (
                <li key={v.key}>
                  <code className="rounded bg-surface-2 px-1 py-0.5">{`{{${v.key}}}`}</code> — {v.desc}
                </li>
              ))}
            </ul>
          </details>
        </div>

        {/* Preview */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-muted">
            Live preview — against &quot;{previewRestaurant.name}&quot;
          </label>
          <div className="rounded-lg border border-line bg-surface-2 p-3">
            {preview.ok ? (
              <>
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-text">{preview.body}</pre>
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
        {pendingDrafts > 0 && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={applyToPending}
            className="rounded-lg border border-gold/40 bg-gold/10 px-4 py-2 text-sm font-medium text-gold hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "apply" ? "Rewriting…" : `Apply to ${pendingDrafts} pending draft${pendingDrafts === 1 ? "" : "s"}`}
          </button>
        )}
        {msg && (
          <span className={`text-xs ${msg.ok ? "text-teal" : "text-coral"}`} role="alert">
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
