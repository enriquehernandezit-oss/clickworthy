// Push the code DEFAULTS for the outreach templates back into app_settings.
//
//   bun run scripts/reset-templates-to-default.ts            # DRY RUN — shows the diff, writes nothing
//   bun run scripts/reset-templates-to-default.ts --commit   # write them
//   bun run scripts/reset-templates-to-default.ts --commit --only outreach_bump_template
//
// WHY THIS EXISTS (2026-09-03). getSetting() returns the app_settings row when
// one exists and only falls back to DEFAULTS when it doesn't — so editing the
// defaults in lib/settings.ts has NO effect on a key that's ever been saved
// from /admin/photo/templates. All three Touch 1 / bump templates were
// hand-edited on 2026-08-26, and that edit dropped every merge field:
// `{{greeting}}` became a hardcoded "Hi there," (throwing away the owner
// first name on 40 of 92 emailable leads), `{{dish}}` disappeared entirely
// (62 of 92 have a signature dish we pay Claude to extract), and all three
// Touch 1 subject variants became the same string, which makes the
// `subjectVariant % 3` rotation a no-op.
//
// This script is how you get back to the templates the code intends, without
// retyping them into the editor. It prints a full before/after and writes only
// with --commit.
//
// SAFETY: writes go through the same setSetting() the admin route uses. It
// touches ONLY the three cold-open templates — never outreach_touch2_template
// (the sample-delivery copy, which was rewritten separately and deliberately),
// and never identity/pricing/cost settings. Everything it overwrites stays
// editable at /admin/photo/templates, so nothing here is one-way.

import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSetting, setSetting, type Touch1Template, type BumpTemplate } from "@/lib/settings";

const commit = process.argv.includes("--commit");
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? process.argv[onlyArg + 1] : null;

// Deliberately NOT including outreach_touch2_template — see the header.
const KEYS = ["outreach_touch1_template", "outreach_touch1_nodish_template", "outreach_bump_template"] as const;
type Key = (typeof KEYS)[number];

// DEFAULTS isn't exported from lib/settings.ts, so the way to obtain a code
// default is to clear the row and let getSetting() fall through to it (see the
// --commit path below). To show a real before/after in a DRY RUN without
// writing anything, read the stored row directly here instead.
async function storedRow(key: Key): Promise<unknown | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return row?.value ?? null;
}

function bodyOf(v: unknown, lang: "en" | "es"): string {
  const branch = (v as Touch1Template | BumpTemplate | null)?.[lang] as { body?: string } | undefined;
  return branch?.body ?? "(none)";
}
function subjectsOf(v: unknown, lang: "en" | "es"): string[] {
  const branch = (v as Touch1Template | null)?.[lang] as { subjects?: string[] } | undefined;
  return branch?.subjects ?? [];
}

const usesMergeFields = (s: string) => ({
  greeting: s.includes("{{greeting}}"),
  dish: s.includes("{{dish}}"),
});

const targets = (only ? KEYS.filter((k) => k === only) : [...KEYS]) as Key[];
if (only && targets.length === 0) {
  console.error(`--only ${only} is not one of: ${KEYS.join(", ")}`);
  process.exit(1);
}

console.log(`\n=== reset-templates-to-default ${commit ? "(COMMIT)" : "(DRY RUN)"} ===\n`);

for (const key of targets) {
  const stored = await storedRow(key);
  console.log(`########## ${key} ##########`);
  if (stored == null) {
    console.log("  no saved row — already using the code default. Nothing to do.\n");
    continue;
  }

  const before = bodyOf(stored, "en");
  const bf = usesMergeFields(before);
  const bs = subjectsOf(stored, "en");
  console.log(`  BEFORE (stored, EN)  greeting:${bf.greeting ? "yes" : "NO"}  dish:${bf.dish ? "yes" : "NO"}` +
    (bs.length ? `  distinct subjects: ${new Set(bs).size}/${bs.length}` : ""));
  console.log("  " + before.split("\n").join("\n  ").slice(0, 700));

  if (!commit) {
    console.log("\n  (dry run — pass --commit to overwrite this with the code default)\n");
    continue;
  }

  // Clear the row, then read: with no row present getSetting() returns the
  // code DEFAULT, which is exactly the value we want to write back.
  await db.delete(appSettings).where(eq(appSettings.key, key));
  const fresh = await getSetting(key);
  await setSetting(key, fresh as never);

  const after = bodyOf(fresh, "en");
  const af = usesMergeFields(after);
  const as_ = subjectsOf(fresh, "en");
  console.log(`\n  AFTER (default, EN)  greeting:${af.greeting ? "yes" : "NO"}  dish:${af.dish ? "yes" : "NO"}` +
    (as_.length ? `  distinct subjects: ${new Set(as_).size}/${as_.length}` : ""));
  console.log("  " + after.split("\n").join("\n  "));
  console.log("");
}

console.log(
  commit
    ? "Written. Review at /admin/photo/templates — every value here is still editable there.\n"
    : "Dry run complete — nothing written.\n"
);
process.exit(0);
