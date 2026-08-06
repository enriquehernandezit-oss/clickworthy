"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    setBusy(true);
    const fd = new FormData();
    fd.set("action", "logout");
    await fetch("/api/admin/auth", { method: "POST", body: fd }).catch(() => {});
    router.replace("/admin/login");
    router.refresh();
  };

  return (
    <button
      type="button"
      onClick={logout}
      disabled={busy}
      className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-50"
    >
      {busy ? "…" : "Log out"}
    </button>
  );
}
