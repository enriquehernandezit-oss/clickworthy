import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks } from "@/db/schema";
import { storeImageBytes } from "@/lib/storage";
import { isPackageId } from "@/lib/packages";
import { getPackages } from "@/lib/settings";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

function appOriginFrom(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const host = request.headers.get("host") ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

// Post-payment upload. Validates the package is paid and the count is within
// the tier limit, stores the originals, and hands off to the worker's
// process-package job (which polls for packageStatus = 'processing'). We do NOT
// enhance inline — that would block the request and risk timeouts on big
// packages.
export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const token = String(formData.get("token") ?? "");
  const photos = formData.getAll("photos").filter((e): e is File => e instanceof File);

  const [link] = await db.select().from(magicLinks).where(eq(magicLinks.token, token)).limit(1);
  if (!link) return NextResponse.json({ error: "Link not found." }, { status: 404 });
  if (!link.paidAt) return NextResponse.json({ error: "Payment not completed." }, { status: 402 });
  if (link.packageStatus === "processing" || link.packageStatus === "completed") {
    return NextResponse.json({ error: "This order is already being processed." }, { status: 409 });
  }

  if (!isPackageId(link.packageSelected)) {
    return NextResponse.json({ error: "No package on file." }, { status: 400 });
  }
  const limit = (await getPackages())[link.packageSelected].photoLimit;

  if (photos.length === 0) return NextResponse.json({ error: "Please upload at least one photo." }, { status: 400 });
  if (photos.length > limit) {
    return NextResponse.json({ error: `Your package includes up to ${limit} photos.` }, { status: 400 });
  }
  for (const p of photos) {
    if (!ALLOWED.has(p.type)) {
      return NextResponse.json({ error: "Please upload JPEG, PNG, or WEBP images." }, { status: 400 });
    }
  }

  const appOrigin = appOriginFrom(request);
  try {
    const originals = await Promise.all(
      photos.map(async (file, i) => {
        const bytes = Buffer.from(await file.arrayBuffer());
        const url = await storeImageBytes({
          groupKey: `${link.token}-pkg`,
          name: `${i}-${file.name}`,
          bytes,
          contentType: file.type,
          appOrigin,
        });
        return { name: file.name, url };
      })
    );

    await db
      .update(magicLinks)
      .set({ packageOriginals: originals, packageStatus: "processing", packageResults: null })
      .where(eq(magicLinks.id, link.id));
  } catch (err) {
    console.error("[outreach-enhance] failed to store uploads:", err);
    return NextResponse.json({ error: "We couldn't save your photos. Please try again." }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
