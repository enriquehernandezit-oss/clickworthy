import { Suspense } from "react";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

// Full-screen login overlay (fixed inset-0), so it covers the admin chrome
// regardless of the surrounding layout. This route has no layout.tsx of its
// own, so it inherits app/admin/layout.tsx's `.console` wrapper — including
// `color-scheme: dark`. The card here is deliberately a light island on a
// dark backdrop, not dark itself, so `colorScheme: "light"` overrides that
// inheritance for this subtree. Without it, the browser renders native input
// text using its dark-mode default (near-white) inside these still-light
// (bg-stone-50) fields — unreadable while typing.
export default function LoginPage() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950 px-4" style={{ colorScheme: "light" }}>
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(circle at 20% 20%, rgba(227,168,59,0.10), transparent 45%), radial-gradient(circle at 80% 80%, rgba(47,122,111,0.10), transparent 45%)",
        }}
      />
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
