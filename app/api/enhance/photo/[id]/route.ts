import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { enhancementPhotoBlobs } from "@/db/schema";

// Serves photos stored via the Postgres-blob fallback path (see
// lib/storage.ts) so external services like Claid have a public URL to
// fetch the image from. Not used when R2 is configured.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const photoId = Number(id);
  if (!Number.isInteger(photoId)) {
    return NextResponse.json({ error: "Invalid photo id" }, { status: 400 });
  }

  const [row] = await db
    .select()
    .from(enhancementPhotoBlobs)
    .where(eq(enhancementPhotoBlobs.id, photoId))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const bytes = Buffer.from(row.data, "base64");
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": row.contentType,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
