import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks } from "@/db/schema";

// Approve/reject a pending free-sample. Gated by the same Basic Auth proxy as
// the /admin page (see proxy.ts). Approve -> the worker's Touch 2 job emails the
// enhanced sample + magic link; reject -> it never sends.
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { magicLinkId?: number; action?: string }
    | null;

  if (!body || typeof body.magicLinkId !== "number" || (body.action !== "approve" && body.action !== "reject")) {
    return NextResponse.json({ error: "Expected { magicLinkId, action: 'approve'|'reject' }" }, { status: 400 });
  }

  const reviewStatus = body.action === "approve" ? "approved" : "rejected";

  const updated = await db
    .update(magicLinks)
    .set({ reviewStatus })
    .where(eq(magicLinks.id, body.magicLinkId))
    .returning({ id: magicLinks.id });

  if (updated.length === 0) {
    return NextResponse.json({ error: "Magic link not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, reviewStatus });
}
