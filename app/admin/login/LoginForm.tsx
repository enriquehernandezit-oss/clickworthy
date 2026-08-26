"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// The mockup's login card with the aperture logo that closes on submit.
export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/admin";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("action", "login");
      fd.set("email", email.trim());
      fd.set("password", password);
      const res = await fetch("/api/admin/auth", { method: "POST", body: fd });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? "Login failed.");
        setBusy(false);
        return;
      }
      // Aperture-close flourish, then navigate.
      setClosing(true);
      setTimeout(() => {
        router.replace(next);
        router.refresh();
      }, 420);
    } catch {
      setError("Network error.");
      setBusy(false);
    }
  };

  return (
    <div className="relative w-[380px] max-w-full rounded-2xl bg-white p-9 pb-8 text-center shadow-2xl">
      <div className="mx-auto mb-4 h-14 w-14">
        <svg
          viewBox="0 0 100 100"
          className={`h-full w-full transition-transform duration-500 ${closing ? "rotate-[140deg] scale-[0.35]" : ""}`}
          style={{ transitionTimingFunction: "cubic-bezier(.65,0,.35,1)" }}
        >
          <circle cx="50" cy="50" r="46" fill="none" stroke="#EDEDED" strokeWidth="1.5" />
          {[
            "50,50 50,8 68,14",
            "50,50 84,26 88,46",
            "50,50 88,60 76,84",
            "50,50 56,92 32,90",
            "50,50 16,80 8,60",
            "50,50 8,42 20,16",
          ].map((pts, i) => (
            <polygon key={i} points={pts} fill="#E3A83B" />
          ))}
        </svg>
      </div>
      <div className="text-[22px] font-bold tracking-tight text-stone-900" style={{ fontFamily: "var(--font-display)" }}>
        ClickWorthy Admin
      </div>
      <div className="mb-7 mt-1.5 text-[13px] text-stone-500">Sign in to access the operations console</div>

      <form onSubmit={submit} className="text-left">
        <div className="mb-3.5">
          <label htmlFor="login-email" className="mb-1.5 block font-mono text-[11px] font-semibold uppercase tracking-wider text-stone-500">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-stone-200 bg-stone-50 px-3.5 py-2.5 text-sm text-stone-900 focus:border-[#E3A83B] focus:outline-none"
          />
        </div>
        <div className="mb-3.5">
          <label htmlFor="login-pass" className="mb-1.5 block font-mono text-[11px] font-semibold uppercase tracking-wider text-stone-500">
            Password
          </label>
          <input
            id="login-pass"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-stone-200 bg-stone-50 px-3.5 py-2.5 text-sm text-stone-900 focus:border-[#E3A83B] focus:outline-none"
          />
        </div>
        {error && (
          <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={busy}
          className="mt-2.5 w-full rounded-lg bg-stone-900 py-3 text-sm font-semibold text-white transition-colors hover:bg-black disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Log in"}
        </button>
      </form>
    </div>
  );
}
