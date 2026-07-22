import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { db } from "@/db";
import { enhancementPhotoBlobs } from "@/db/schema";

export type StoredPhoto = {
  originalName: string;
  contentType: string;
  url: string;
};

export type StorageType = "r2" | "postgres_blob";

// R2 needs more than just the access key/secret/bucket that are already in
// .env.local: the S3-compatible endpoint requires the Cloudflare account ID,
// and serving the uploaded photos back to Claid (which needs a public URL to
// fetch from) requires either an r2.dev public bucket URL or a custom domain.
// TODO: once these are available, set them in the environment:
//   R2_ACCOUNT_ID       — Cloudflare account ID (builds the S3 endpoint)
//   R2_PUBLIC_URL_BASE  — public base URL for the bucket (r2.dev subdomain or custom domain)
function getR2Config() {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;
  const accountId = process.env.R2_ACCOUNT_ID;
  const publicUrlBase = process.env.R2_PUBLIC_URL_BASE;

  if (!accessKeyId || !secretAccessKey || !bucket || !accountId || !publicUrlBase) {
    return null;
  }

  return { accessKeyId, secretAccessKey, bucket, accountId, publicUrlBase };
}

export function resolveStorageType(): StorageType {
  return getR2Config() ? "r2" : "postgres_blob";
}

// --- Low-level put helpers (bytes in, public URL out) -----------------------

async function putToR2(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
  const config = getR2Config();
  if (!config) throw new Error("R2 is not configured");

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
    })
  );

  return `${config.publicUrlBase.replace(/\/$/, "")}/${key}`;
}

// Fallback: stash the raw bytes as base64 in Postgres and serve them back
// through /api/enhance/photo/[id] so external services (and the customer's
// browser) still have a public URL. Only works once DATABASE_URL points at a
// real Postgres instance.
// TODO: remove this path once R2 is fully wired in (see getR2Config above).
async function putToPostgresBlob(
  sessionId: string,
  bytes: Buffer,
  contentType: string,
  appOrigin: string
): Promise<string> {
  const [row] = await db
    .insert(enhancementPhotoBlobs)
    .values({
      orderStripeSessionId: sessionId,
      contentType,
      data: bytes.toString("base64"),
    })
    .returning({ id: enhancementPhotoBlobs.id });

  return `${appOrigin.replace(/\/$/, "")}/api/enhance/photo/${row.id}`;
}

// --- Public API -------------------------------------------------------------

async function uploadFile(
  sessionId: string,
  index: number,
  file: File,
  storageType: StorageType,
  appOrigin: string
): Promise<StoredPhoto> {
  const contentType = file.type || "application/octet-stream";
  const buffer = Buffer.from(await file.arrayBuffer());

  const url =
    storageType === "r2"
      ? await putToR2(`enhance/${sessionId}/${index}-${file.name}`, new Uint8Array(buffer), contentType)
      : await putToPostgresBlob(sessionId, buffer, contentType, appOrigin);

  return { originalName: file.name, contentType, url };
}

// Uploads every photo in the batch, using R2 if configured and falling back
// to the Postgres blob table otherwise. `appOrigin` (e.g. derived from the
// incoming request's Host header) is only used for the Postgres fallback,
// to build an absolute URL external services can fetch.
export async function storePhotos(
  sessionId: string,
  files: File[],
  appOrigin: string
): Promise<{ storageType: StorageType; photos: StoredPhoto[] }> {
  const storageType = resolveStorageType();
  const photos = await Promise.all(
    files.map((file, i) => uploadFile(sessionId, i, file, storageType, appOrigin))
  );
  return { storageType, photos };
}

// Downloads a remote image (e.g. Claid's ~24h-expiring tmp_url) and persists
// the bytes to our own durable storage, returning a URL that won't expire.
// Used by the Stripe webhook so a customer returning the next day still sees
// their enhanced photos.
export async function persistEnhancedFromUrl(
  sessionId: string,
  index: number,
  sourceUrl: string,
  appOrigin: string
): Promise<string> {
  const res = await fetch(sourceUrl);
  if (!res.ok) {
    throw new Error(`Failed to download enhanced image (${res.status}) from ${sourceUrl}`);
  }
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());

  // Derive an extension from the content type so the stored key/URL is sane.
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";

  if (resolveStorageType() === "r2") {
    return putToR2(`enhance/${sessionId}/enhanced-${index}.${ext}`, new Uint8Array(buffer), contentType);
  }
  return putToPostgresBlob(sessionId, buffer, contentType, appOrigin);
}
