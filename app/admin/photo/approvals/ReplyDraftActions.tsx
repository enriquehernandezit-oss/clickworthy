"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Reply draft controls. The body starts BLANK, always — no LLM drafting
// anywhere in this path, by design. Send writes and sends atomically (no
// separate approve step): there's nothing to approve until a person has
// actually written something.
export default function ReplyDraftActions({
  outreachJobId,
  quotedMessage,
  quotedFrom,
}: {
  outreachJobId: number;
  quotedMessage: string;
  quotedFrom: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");

  const post = async (action: string, extra: Record<string, string> = {}, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(action);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("action", action);
      fd.set("outreachJobId", String(outreachJobId));
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      const res = await fetch("/api/admin/approvals", { method: "POST", body: fd });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? "Something went wrong.");
        setBusy(null);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
        <div className="text-xs font-medium text-stone-500">{quotedFrom ?? "They"} wrote:</div>
        <p className="mt-1 whitespace-pre-wrap text-sm text-stone-700">{quotedMessage || "(no message text)"}</p>
      </div>
      <label className="text-xs font-medium text-stone-500">
        Your reply
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="Write your reply…"
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm leading-relaxed text-stone-800"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy !== null || !body.trim()}
          onClick={() => post("reply_send", { body })}
          className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
        >
          {busy === "reply_send" ? "Sending…" : "Send"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => post("reply_deny", {}, "Deny this reply? Nothing will be sent back for this message.")}
          className="rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
        >
          {busy === "reply_deny" ? "Denying…" : "Deny"}
        </button>
        {error && <span className="text-sm text-red-600" role="alert">{error}</span>}
      </div>
    </div>
  );
}
