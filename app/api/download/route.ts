import { NextRequest, NextResponse } from "next/server";

// Forces a real file download for images we've stored.
//
// Why this exists: the HTML `download` attribute is IGNORED on cross-origin
// links, so pointing it straight at the R2 public bucket just navigates to the
// image instead of saving it. Proxying through our own origin makes `download`
// apply again, gives the file a sensible name, and avoids needing CORS on the
// bucket.
//
// Only URLs on our own storage hosts are allowed — without that check this
// would be an open proxy anyone could point at internal addresses.

function allowedOrigins(request: NextRequest): string[] {
  const origins: string[] = [];

  const r2 = process.env.R2_PUBLIC_URL_BASE;
  if (r2) {
    try {
      origins.push(new URL(r2).origin);
    } catch {
      /* malformed env — just don't allow it */
    }
  }

  // The Postgres-blob fallback serves from our own origin.
  const appOrigin = process.env.APP_ORIGIN;
  if (appOrigin) {
    try {
      origins.push(new URL(appOrigin).origin);
    } catch {
      /* ignore */
    }
  }
  origins.push(request.nextUrl.origin);

  return origins;
}

// Strip anything that could break out of the Content-Disposition header or
// escape the filename (quotes, CR/LF, path separators).
function safeFilename(name: string): string {
  const cleaned = name.replace(/[\r\n"\\/]/g, "").trim();
  return cleaned.slice(0, 120) || "photo.jpg";
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("url");
  const name = request.nextUrl.searchParams.get("name") ?? "photo.jpg";
  if (!raw) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: "Bad url" }, { status: 400 });
  }

  if (!allowedOrigins(request).includes(target.origin)) {
    return NextResponse.json({ error: "That file isn't ours to serve." }, { status: 403 });
  }

  const upstream = await fetch(target.toString()).catch(() => null);
  if (!upstream?.ok || !upstream.body) {
    return NextResponse.json({ error: "Could not fetch that file" }, { status: 502 });
  }

  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeFilename(name)}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
