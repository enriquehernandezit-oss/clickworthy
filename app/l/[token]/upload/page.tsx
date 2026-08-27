import { eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { magicLinks, restaurants } from "@/db/schema";
import { isPackageId } from "@/lib/packages";
import { getPackages } from "@/lib/settings";
import Header from "../../../components/Header";
import { getCopy } from "../copy";
import UploadClient from "./UploadClient";

export const dynamic = "force-dynamic";

type PackageResult = { name: string; originalUrl: string; enhancedUrl: string | null; error: string | null };

export default async function UploadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const [link] = await db.select().from(magicLinks).where(eq(magicLinks.token, token)).limit(1);
  if (!link) return <Shell>This link isn&apos;t available.</Shell>;

  const [restaurant] = link.restaurantId
    ? await db.select().from(restaurants).where(eq(restaurants.id, link.restaurantId)).limit(1)
    : [];
  const language = restaurant?.language ?? "en";
  const copy = getCopy(language);

  if (!link.paidAt) {
    return (
      <Shell>
        <p className="text-stone-600">{copy.notPaid}</p>
        <Link href={`/l/${token}`} className="mt-4 inline-block text-sm font-semibold text-orange-600 hover:underline">
          {copy.backToPackages}
        </Link>
      </Shell>
    );
  }

  const photoLimit = isPackageId(link.packageSelected) ? (await getPackages())[link.packageSelected].photoLimit : 5;

  return (
    <div className="flex min-h-full flex-col bg-stone-50 text-stone-900">
      <Header />
      <main className="flex-1">
        <section className="mx-auto max-w-4xl px-6 py-16 lg:px-8 lg:py-20">
          <UploadClient
            token={token}
            language={language}
            photoLimit={photoLimit}
            initialStatus={(link.packageStatus as "processing" | "completed" | "failed" | null) ?? null}
            initialResults={(link.packageResults as PackageResult[] | null) ?? null}
          />
        </section>
      </main>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col bg-stone-50 text-stone-900">
      <Header />
      <main className="flex flex-1 items-center justify-center px-6 py-24 text-center">
        <div>{children}</div>
      </main>
    </div>
  );
}
