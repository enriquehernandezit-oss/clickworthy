import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks } from "@/db/schema";

// Polled by the upload page after submitting photos, to know when the worker
// has finished enhancing the package.
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Missing token" }, { status: 400 });

  const [link] = await db
    .select({
      packageStatus: magicLinks.packageStatus,
      packageResults: magicLinks.packageResults,
    })
    .from(magicLinks)
    .where(eq(magicLinks.token, token))
    .limit(1);

  if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    status: link.packageStatus,
    results: link.packageResults,
  });
}
