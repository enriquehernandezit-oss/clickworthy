"use client";

// Interactive console primitives that need hooks — split from ui.tsx (which
// stays server-safe) so server pages that only need Badge/Card/etc. don't pay
// for a client boundary. Re-exported from ui.tsx so callers keep one import
// path; Next treats each named export's client-ness independently, so this
// doesn't force ui.tsx's other exports to become client components.

import { useCallback, useEffect, useId, useRef, useState } from "react";

// ---- Button -----------------------------------------------------------
// Replaces ~29 files' worth of ad-hoc button classes. `.btn-press` (global,
// scale(0.97) on :active) is the one motion every variant shares — already
// the correct pattern per the design plan, just not applied everywhere.

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-gold text-[#0F1216] hover:brightness-110",
  secondary: "border border-line bg-surface-2 text-text hover:border-line-strong",
  ghost: "text-muted hover:bg-surface-2 hover:text-text",
  danger: "border border-coral/40 bg-coral/10 text-coral hover:bg-coral/15",
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className = "",
  disabled,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`btn-press inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]} ${className}`}
    >
      {loading && (
        <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
      )}
      {children}
    </button>
  );
}

// ---- ConfirmDialog ------------------------------------------------------
// A real in-page confirm, replacing window.confirm(). Native <dialog> for a
// focus trap + Escape-to-close for free. Modals are the one place
// transform-origin stays centered (they aren't anchored to a trigger).
//
// Adoption note (2026-08-26): currently wired into the approval-queue deny/
// skip actions. Several genuinely irreversible sends (delivery email,
// compose-send, sample reject, RunNow triggers) still use window.confirm()
// and have NOT been migrated yet — they remain guarded, just by the browser
// dialog. Migrating those and giving the destructive ones the `requireText`
// fence below is the intended follow-up.
//
// `requireText`: when set, Confirm stays disabled until the operator types
// this exact string — a stronger fence for a second operator on an
// irreversible action ("type the restaurant name" instead of "click OK").
// Built and ready; no caller passes it yet.

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  requireText,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  requireText?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // The native `close` event fires for every path a <dialog> can close —
  // Escape, the backdrop, and our own programmatic el.close() above — so
  // resetting the typed-confirmation field here (rather than synchronously in
  // the effect body) covers all of them in one place without a setState-in-
  // effect cascade. Also routes Escape/backdrop through onCancel so parent
  // state never drifts from the dialog's real open state.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleClose = () => {
      setTyped("");
      onCancel();
    };
    el.addEventListener("close", handleClose);
    return () => el.removeEventListener("close", handleClose);
  }, [onCancel]);

  const locked = requireText !== undefined && typed !== requireText;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="m-auto rounded-xl border border-line bg-surface p-0 text-text shadow-2xl backdrop:bg-black/60"
      style={{ width: "min(420px, calc(100vw - 2rem))" }}
      // Deliberately NOT preventDefault()-ing the native `cancel` event: letting
      // the browser close the dialog itself is what makes Escape work reliably.
      // Preventing it made Escape depend on a React state round-trip to call
      // el.close(), and the dialog just stayed open. The `close` listener below
      // still fires either way, so parent state stays in sync.
    >
      <div
        className="animate-fade-scale-in p-5"
        style={{ transformOrigin: "center" }}
      >
        <h2 id={titleId} className="font-display text-base font-semibold text-text">
          {title}
        </h2>
        {description && <div className="mt-2 text-sm leading-relaxed text-muted">{description}</div>}

        {requireText && (
          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-faint">
              Type <span className="font-mono-label text-text">{requireText}</span> to confirm
            </label>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full rounded-lg border border-line-input bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-gold"
            />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} size="sm" onClick={onConfirm} disabled={locked || busy} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

// ---- useConfirm ---------------------------------------------------------
// Promise-based wrapper so ConfirmDialog is a near drop-in for window.confirm:
//
//   const { confirm, confirmDialog } = useConfirm();
//   ...
//   if (!(await confirm({ title, description, danger, requireText }))) return;
//   ...
//   return (<>{confirmDialog}...</>)
//
// `requireText` gives irreversible actions the typed-confirmation fence (the
// operator must type e.g. the restaurant name), which browser confirm() can't
// do. Only one confirm is in flight at a time (the action awaits it), so a
// single piece of state is enough.

type ConfirmOpts = {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  requireText?: string;
};

export function useConfirm() {
  const [pending, setPending] = useState<{ opts: ConfirmOpts } | null>(null);
  // The resolver lives in a ref, NOT in state: calling resolve() inside a
  // setState updater is a side effect in what React requires to be a pure
  // function (it may re-invoke or defer updaters), which can leave the
  // awaiting caller hanging. Settling outside the updater keeps it honest.
  // Nulling it first also makes settle idempotent — the Confirm path closes
  // the dialog, which fires `close`, which calls onCancel again; without the
  // guard that second call would resolve the same promise with `false`.
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
        setPending({ opts });
      }),
    []
  );

  const settle = useCallback((ok: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPending(null);
    resolve?.(ok);
  }, []);

  const confirmDialog = (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.opts.title ?? ""}
      description={pending?.opts.description}
      confirmLabel={pending?.opts.confirmLabel}
      cancelLabel={pending?.opts.cancelLabel}
      danger={pending?.opts.danger}
      requireText={pending?.opts.requireText}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return { confirm, confirmDialog };
}

// ---- Toast ---------------------------------------------------------------
// Replaces inline `<span role="alert">` feedback that vanishes on
// router.refresh(). Presentational + controlled (parent owns the message and
// clears it) rather than a global queue — matches how the ~29 action
// components already manage their own busy/error/message state locally.

export type ToastTone = "success" | "error";

export function Toast({ tone, message, onDismiss }: { tone: ToastTone; message: string; onDismiss?: () => void }) {
  const color = tone === "error" ? "var(--coral)" : "var(--teal)";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      className="animate-fade-scale-in mt-2 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
      style={{ borderColor: color, background: `color-mix(in oklch, ${color} 12%, var(--card))`, color }}
    >
      <span>{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="btn-press text-xs opacity-70 hover:opacity-100" aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}
