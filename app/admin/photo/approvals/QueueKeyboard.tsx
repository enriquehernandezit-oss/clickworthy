"use client";

import { useEffect, useState } from "react";

// Keyboard triage for the approval queue — j/k to move between drafts, a to
// approve/send, e to edit, x to deny/skip/redraft-cancel (whichever the card
// exposes as its destructive action). Approvals is the delegate's
// highest-volume page, so this is the one surface in the console where a
// shortcut earns its keep.
//
// Deliberately imperative rather than lifting all 4 kind-specific editor
// components' state up into this component: each queue card is one of four
// independently-implemented editors (DraftActions/BumpDraftActions/
// ReplyDraftActions/PaymentConfirmationDraftActions) that already render a
// real <button> for every action. Dispatching a synthetic click on that same
// button reuses its exact handler (including the confirm dialog for deny/
// skip) instead of a second, parallel action-dispatch path that could drift
// from the real one.
//
// Never fires while focus is inside a form control or an open <dialog> — "a"
// approving a draft while the delegate is mid-sentence in the reply textarea
// would be a real, expensive mistake, not just an annoyance.
export default function QueueKeyboard({ count }: { count: number }) {
  const [focused, setFocused] = useState(0);
  // Clamp for RENDER/read purposes only (e.g. the card ahead got approved and
  // the list shrank) — never written back via setState-in-effect. `focused`
  // itself only ever changes from the keydown handler below, which is an
  // event callback, not an effect body.
  const safeFocused = count === 0 ? 0 : Math.min(focused, count - 1);

  useEffect(() => {
    if (count > 0) highlight(safeFocused);
  }, [count, safeFocused]);

  useEffect(() => {
    function isTypingTarget(el: Element | null): boolean {
      if (!el) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (document.querySelector("dialog[open]")) return true; // a confirm dialog is up — don't act underneath it
      return false;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(document.activeElement)) return;
      if (count === 0) return;

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        setFocused((i) => {
          const next = e.key === "j" ? Math.min(i + 1, count - 1) : Math.max(i - 1, 0);
          highlight(next);
          return next;
        });
        return;
      }

      const trigger: Record<string, string> = { a: ".kbd-approve", e: ".kbd-edit", x: ".kbd-deny" };
      const sel = trigger[e.key];
      if (!sel) return;
      const card = document.querySelector<HTMLElement>(`[data-queue-index="${safeFocused}"]`);
      const btn = card?.querySelector<HTMLButtonElement>(sel);
      if (btn && !btn.disabled) {
        e.preventDefault();
        btn.click();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [safeFocused, count]);

  return null;
}

function highlight(index: number) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll<HTMLElement>("[data-queue-index]").forEach((el) => {
    el.classList.remove("kbd-focused");
  });
  const el = document.querySelector<HTMLElement>(`[data-queue-index="${index}"]`);
  if (!el) return;
  el.classList.add("kbd-focused");
  el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
}
