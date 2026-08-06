import { Suspense } from "react";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

// Full-screen login overlay (fixed inset-0), so it covers the admin chrome
// regardless of the surrounding layout.
export default function LoginPage() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950 px-4">
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
