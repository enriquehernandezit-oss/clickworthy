import { Suspense } from "react";
import Header from "../components/Header";
import EnhanceClient from "./EnhanceClient";

export default function EnhancePage() {
  return (
    <div className="flex min-h-full flex-col bg-stone-50 text-stone-900">
      <Header />
      <Suspense fallback={null}>
        <EnhanceClient />
      </Suspense>
    </div>
  );
}
