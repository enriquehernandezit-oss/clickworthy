// Backfill outreach_jobs.kind for rows written before the column existed.
//   bun run scripts/backfill-kind.ts             # DRY RUN — prints the plan, writes nothing
//   bun run scripts/backfill-kind.ts --commit     # writes kind for every row where it's still NULL
//
// Idempotent: only touches rows WHERE kind IS NULL, so re-running after new
// touch1/bump/touch2/manual rows land (before their insert sites are updated)
// is safe and won't clobber anything already set. Order matters in the CASE:
// status='bumped' must be checked before the touch_number=1 catch-all, since
// bump rows carry touch_number=1 too (same reputation track as touch1).

import { sql } from "drizzle-orm";
import { db } from "@/db";

const commit = process.argv.includes("--commit");

const before = await db.execute(sql`
  SELECT touch_number, status, count(*)::int AS n
  FROM outreach_jobs WHERE kind IS NULL
  GROUP BY touch_number, status ORDER BY touch_number, status
`);
console.log("Rows with kind IS NULL, grouped by (touch_number, status):");
console.table(before);

if (!commit) {
  console.log("\nDry run only — pass --commit to write kind for the rows above.");
  process.exit(0);
}

const result = await db.execute(sql`
  UPDATE outreach_jobs SET kind = CASE
    WHEN touch_number = 0  THEN 'manual'
    WHEN touch_number = 2  THEN 'touch2'
    WHEN status = 'bumped' THEN 'bump'
    ELSE 'touch1'
  END
  WHERE kind IS NULL
`);
console.log(`\nUpdated ${result.count ?? "?"} row(s).`);

const after = await db.execute(sql`SELECT kind, count(*)::int AS n FROM outreach_jobs GROUP BY kind ORDER BY kind`);
console.log("\nAll rows now grouped by kind:");
console.table(after);

const stillNull = await db.execute(sql`SELECT count(*)::int AS n FROM outreach_jobs WHERE kind IS NULL`);
console.log("\nRows still NULL (should be 0):", (stillNull as unknown as Array<{ n: number }>)[0]?.n);

process.exit(0);
