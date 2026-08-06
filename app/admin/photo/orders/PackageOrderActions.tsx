"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Row actions for a package order in the "all package orders" table:
//   - Mark paid   (package paid off-Stripe, e.g. check/Zelle → enters pipeline)
//   - Resend email (re-send the delivery email on a completed order)
// Which buttons show depends on the order's current state (passed in).
export default function PackageOrderActions({
  magicLinkId,
  isPaid,
  isCompleted,
  hasPackage,
}: {
  magicLinkId: number;
  isPaid: boolean;
  isCompleted: boolean;
  hasPackage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const post = async (action: string, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(action);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("magicLinkId", String(magicLinkId));
      fd.set("action", action);
      const res = await fetch("/api/admin/package", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ text: body?.error ?? "Failed.", ok: false });
      } else if (body.ok === false) {
        setMsg({ text: body.error ?? "Nothing sent.", ok: false });
      } else {
        setMsg({ text: action === "mark_paid" ? "Marked paid." : "Email resent.", ok: true });
        router.refresh();
      }
    } catch {
      setMsg({ text: "Network error.", ok: false });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!isPaid && hasPackage && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => post("mark_paid", "Mark this package as paid (off-Stripe, e.g. check/Zelle)? It will enter the production pipeline.")}
          className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-black/[0.03] disabled:opacity-50"
          style={{ borderColor: "var(--line)", color: "var(--c-text)" }}
        >
          {busy === "mark_paid" ? "…" : "Mark paid"}
        </button>
      )}
      {isCompleted && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => post("resend_delivery")}
          className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-black/[0.03] disabled:opacity-50"
          style={{ borderColor: "var(--line)", color: "var(--c-text)" }}
        >
          {busy === "resend_delivery" ? "…" : "Resend email"}
        </button>
      )}
      {msg && (
        <span className="text-xs" style={{ color: msg.ok ? "var(--teal)" : "var(--coral)" }} role="alert">
          {msg.text}
        </span>
      )}
    </div>
  );
}
