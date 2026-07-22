// Do-not-contact list. Checked before every outreach send; written on "reply
// STOP" opt-outs and hard bounces. Keeps us CAN-SPAM compliant and off
// spam-trap radar.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { suppressions } from "@/db/schema";

export async function isSuppressed(email: string): Promise<boolean> {
  const rows = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(eq(suppressions.email, email.toLowerCase()))
    .limit(1);
  return rows.length > 0;
}

export async function addSuppression(email: string, reason: string): Promise<void> {
  await db
    .insert(suppressions)
    .values({ email: email.toLowerCase(), reason })
    .onConflictDoNothing({ target: suppressions.email });
}
