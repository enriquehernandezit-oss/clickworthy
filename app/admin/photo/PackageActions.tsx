"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "../primitives";

type PackageResult = { name: string; originalUrl: string; enhancedUrl: string | null; error: string | null };

// Paid-order production: per-photo finish (optional Claid re-run or upload an
// edited version), then review + edit the delivery email and send it (which
// unlocks the customer's page).
export default function PackageActions({
  magicLinkId,
  results,
  seed,
}: {
  magicLinkId: number;
  results: PackageResult[];
  seed: { subject: string; body: string } | null;
}) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailFailed, setEmailFailed] = useState(false);
  const [subject, setSubject] = useState(seed?.subject ?? "");
  const [body, setBody] = useState(seed?.body ?? "");

  // Returns the parsed response body on success, or null on failure (error is
  // already set). Callers that need to react to the payload (deliver) read it.
  const post = async (action: string, extra: Record<string, string>, file?: File): Promise<Record<string, unknown> | null> => {
    const key = `${action}:${extra.photoIndex ?? "order"}`;
    setBusy(key);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("magicLinkId", String(magicLinkId));
      fd.set("action", action);
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      if (file) fd.set("photo", file);
      const res = await fetch("/api/admin/package", { method: "POST", body: fd });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? "Something went wrong.");
        setBusy(null);
        return null;
      }
      return (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      setError("Network error.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  // Deliver, then react to whether the customer email actually sent. On failure
  // we deliberately do NOT refresh — refreshing drops this order out of the
  // production queue (it's now "completed"), which would unmount this component
  // and hide the failure. Instead we keep it mounted with a resend affordance.
  // (A Needs-Attention bucket for kind='delivery'/status='cancelled' is the
  // durable backstop if they navigate away — see lib/photoStats.ts.)
  const deliver = async () => {
    // requireText: this is the irreversible one — it unlocks the customer's
    // delivery page and can't be edited afterwards. Typing SEND is the fence a
    // browser confirm() couldn't provide, and matters most for a second operator.
    const ok = await confirm({
      title: "Send the delivery email?",
      description: "The customer's delivery page unlocks the moment this sends, and the email can't be edited afterwards.",
      confirmLabel: "Send delivery email",
      requireText: "SEND",
    });
    if (!ok) return;
    const res = await post("deliver", { subject, body });
    if (!res) return;
    if (res.emailSent === false) {
      setEmailFailed(true);
    } else {
      router.refresh();
    }
  };

  const resend = async () => {
    // resend_delivery 409s (→ post sets error, returns null) when it can't send;
    // a null return means the failure is already surfaced.
    const res = await post("resend_delivery", {});
    if (!res) return;
    setEmailFailed(false);
    router.refresh();
  };

  const allFinished = results.length > 0 && results.every((r) => r.enhancedUrl);

  return (
    <div className="mt-4 flex flex-col gap-4">
      {confirmDialog}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {results.map((r, i) => (
          <PhotoRow key={i} index={i} result={r} busy={busy} onPost={post} />
        ))}
      </div>

      {allFinished && (
        <div className="rounded-lg border border-line bg-surface-2 p-3">
          <div className="text-xs font-medium text-muted">
            Delivery email — review and edit before sending. The order unlocks the moment you send.
          </div>
          <div className="mt-2 flex flex-col gap-2">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg border border-line-input bg-surface-2 px-3 py-1.5 text-sm text-text"
              placeholder="Subject"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              className="w-full rounded-lg border border-line-input bg-surface-2 px-3 py-2 font-sans text-sm leading-relaxed text-text"
            />
          </div>
        </div>
      )}

      {emailFailed && (
        <div className="rounded-lg border border-coral/40 bg-coral/10 p-3 text-sm text-coral">
          <p className="font-semibold">The order was marked delivered, but the email didn&apos;t send.</p>
          <p className="mt-1">
            The customer hasn&apos;t been told their photos are ready. Check their email on file and the
            Resend key (Setup), then resend.
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={resend}
            className="mt-2 rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-[#0F1216] transition-colors hover:brightness-110 disabled:opacity-50"
          >
            {busy === "resend_delivery:order" ? "Resending…" : "Resend delivery email"}
          </button>
        </div>
      )}

      {!emailFailed && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={busy !== null || !allFinished || !subject.trim() || !body.trim()}
            title={allFinished ? "" : "Finish every photo before delivering"}
            onClick={deliver}
            className="rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-[#0F1216] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted"
          >
            {busy === "deliver:order" ? "Sending…" : "Send delivery email"}
          </button>
          {error && <span className="text-sm text-coral">{error}</span>}
        </div>
      )}
    </div>
  );
}

function PhotoRow({
  index,
  result,
  busy,
  onPost,
}: {
  index: number;
  result: PackageResult;
  busy: string | null;
  onPost: (action: string, extra: Record<string, string>, file?: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <div className={`aspect-square overflow-hidden rounded ${result.error ? "bg-coral/10" : "bg-surface-2"}`}>
        {result.enhancedUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={result.enhancedUrl} alt={result.name} className="h-full w-full object-cover" />
        ) : result.error ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center">
            <span className="text-xs font-semibold text-coral">Claid failed</span>
            <span className="line-clamp-3 text-[10px] leading-tight text-coral">{result.error}</span>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-2 text-center text-xs text-faint">
            not finished
          </div>
        )}
      </div>
      <span className="truncate text-xs text-muted" title={result.name}>{result.name}</span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => onPost("first_pass_one", { photoIndex: String(index) })}
          className="rounded border border-line px-2 py-1 text-xs font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          {busy === `first_pass_one:${index}` ? "…" : "Claid"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPost("upload_edited", { photoIndex: String(index) }, f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => fileRef.current?.click()}
          className="rounded border border-line px-2 py-1 text-xs font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          {busy === `upload_edited:${index}` ? "…" : "Upload edited"}
        </button>
      </div>
    </div>
  );
}
