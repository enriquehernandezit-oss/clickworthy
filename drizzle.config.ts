import { readFileSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit is a standalone binary and does NOT auto-load .env.local the way
// the Bun runtime does for the app/worker — so `bun run db:push` otherwise
// fails with "connection url required" even though DATABASE_URL is set there.
// Load it by hand (only for keys not already in the environment, so a real
// shell export still wins). Strips surrounding quotes; ignores comments/blanks.
try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  // no .env.local (e.g. CI with real env vars) — fall through to process.env
}

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
