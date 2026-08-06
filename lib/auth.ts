// Admin auth: password hashing + signed session tokens. Runs on the Node.js
// runtime (Next 16 proxy defaults to Node, so this is importable from proxy.ts,
// the /api/admin/auth route, and the create-admin-user script alike).
//
// Passwords: scrypt with a random per-user salt; constant-time comparison.
// Sessions: a stateless HMAC-signed token `<payloadB64>.<sigB64>` where payload
// is `<userId>.<expiryMs>`. No server-side session store — the signature is the
// proof we issued it. SESSION_SECRET must be set or the admin fails closed.

import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";

export const SESSION_COOKIE = "cw_admin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- password hashing ------------------------------------------------------

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

// --- session tokens --------------------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

// Returns null if SESSION_SECRET is unset — callers treat that as "not signed in"
// so the admin fails closed rather than minting unverifiable tokens.
export function createSessionToken(userId: number): string | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const payload = `${userId}.${Date.now() + SESSION_TTL_MS}`;
  return `${b64url(Buffer.from(payload))}.${sign(payload, secret)}`;
}

// Verifies signature + expiry in constant time; returns the userId or null.
export function verifySessionToken(token: string | undefined): number | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token) return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }

  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const [idStr, expStr] = payload.split(".");
  const userId = Number(idStr);
  const expiry = Number(expStr);
  if (!Number.isInteger(userId) || !Number.isFinite(expiry) || Date.now() > expiry) return null;
  return userId;
}

export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
