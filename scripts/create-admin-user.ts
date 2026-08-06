// Create (or update the password of) an admin console user.
//   bun run scripts/create-admin-user.ts <email> "<Full Name>"
// Prompts for a password (hidden), hashes it, upserts the row. This is the ONLY
// way admin users are created — there is no public signup.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { adminUsers } from "@/db/schema";
import { hashPassword } from "@/lib/auth";

function prompt(question: string, hidden = false): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding("utf8");
    let input = "";
    // Best-effort hidden input: mute echo while typing the password.
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (hidden && stdin.isTTY) stdin.setRawMode(true);
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r") {
          if (hidden && stdin.isTTY) stdin.setRawMode(wasRaw);
          stdin.removeListener("data", onData);
          stdin.pause();
          process.stdout.write("\n");
          return resolve(input);
        } else if (ch === "") {
          process.exit(1); // ctrl-c
        } else if (ch === "") {
          input = input.slice(0, -1); // backspace
        } else {
          input += ch;
          if (!hidden) process.stdout.write(ch);
        }
      }
    };
    stdin.on("data", onData);
  });
}

const email = (process.argv[2] ?? "").trim().toLowerCase();
const name = (process.argv[3] ?? "").trim();

if (!email || !name) {
  console.error('Usage: bun run scripts/create-admin-user.ts <email> "<Full Name>"');
  process.exit(1);
}

const password = await prompt("Password: ", true);
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}
const confirm = await prompt("Confirm password: ", true);
if (password !== confirm) {
  console.error("Passwords do not match.");
  process.exit(1);
}

const { hash, salt } = hashPassword(password);
const [existing] = await db.select().from(adminUsers).where(eq(adminUsers.email, email)).limit(1);

if (existing) {
  await db.update(adminUsers).set({ passwordHash: hash, passwordSalt: salt, name }).where(eq(adminUsers.id, existing.id));
  console.log(`Updated password for ${email}.`);
} else {
  await db.insert(adminUsers).values({ email, name, passwordHash: hash, passwordSalt: salt });
  console.log(`Created admin user ${email} (${name}).`);
}
process.exit(0);
