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

async function uploadToR2(
  sessionId: string,
  index: number,
  file: File
): Promise<StoredPhoto> {
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

  const key = `enhance/${sessionId}/${index}-${file.name}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: bytes,
      ContentType: file.type || "application/octet-stream",
    })
  );

  return {
    originalName: file.name,
    contentType: file.type || "application/octet-stream",
    url: `${config.publicUrlBase.replace(/\/$/, "")}/${key}`,
  };
}

// Fallback: stash the raw bytes as base64 in Postgres and serve them back
// through /api/enhance/photo/[id] so Claid still has a public URL to fetch
// from. This only works once DATABASE_URL points at a real Postgres instance.
// TODO: remove this path once R2 is fully wired in (see getR2Config above).
async function uploadToPostgresBlob(
  sessionId: string,
  file: File,
  appOrigin: string
): Promise<StoredPhoto> {
  const contentType = file.type || "application/octet-stream";
  const bytes = Buffer.from(await file.arrayBuffer());
  const data = bytes.toString("base64");

  const [row] = await db
    .insert(enhancementPhotoBlobs)
    .values({
      orderStripeSessionId: sessionId,
      contentType,
      data,
    })
    .returning({ id: enhancementPhotoBlobs.id });

  return {
    originalName: file.name,
    contentType,
    url: `${appOrigin.replace(/\/$/, "")}/api/enhance/photo/${row.id}`,
  };
}

// Uploads every photo in the batch, using R2 if configured and falling back
// to the Postgres blob table otherwise. `appOrigin` (e.g. derived from the
// incoming request's Host header) is only used for the Postgres fallback,
// to build an absolute URL Claid can fetch.
export async function storePhotos(
  sessionId: string,
  files: File[],
  appOrigin: string
): Promise<{ storageType: StorageType; photos: StoredPhoto[] }> {
  const storageType = resolveStorageType();

  const photos =
    storageType === "r2"
      ? await Promise.all(files.map((file, i) => uploadToR2(sessionId, i, file)))
      : await Promise.all(files.map((file) => uploadToPostgresBlob(sessionId, file, appOrigin)));

  return { storageType, photos };
}
