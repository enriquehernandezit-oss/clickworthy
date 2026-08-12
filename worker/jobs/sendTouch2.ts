// Touch 2 no longer has a worker-driven send phase — approving a finished
// sample composes AND sends it in the same request (see
// app/api/admin/sample/route.ts's `approve` action), since a human is already
// there in the moment. threadToReplyInto() is what's left here: the shared
// "find the conversation to reply into" lookup, reused by that route and by
// the bump's own send phase (worker/jobs/sendBumps.ts).

import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { outreachJobs } from "@/db/schema";
import { getThreadTail } from "../lib/gmail";

// The conversation this restaurant is already in — shared by every kind that
// replies in-thread (touch2, bump, and reply-sends). The most recent SENT job
// with a thread id points at the right one. Returns nulls on any failure — a
// missing thread must never block delivery; callers send standalone instead.
//
// isNotNull(sentAt) matters, not just isNotNull(gmailThreadId): Postgres sorts
// NULL FIRST in `desc` order by default, so an unsent draft that already has a
// gmailThreadId set (e.g. a queued reply, still awaiting a human) would
// otherwise outrank the actual last-sent message below.
export async function threadToReplyInto(
  restaurantId: number
): Promise<{ threadId: string | null; inReplyTo: string | null; subject: string | null }> {
  const [prior] = await db
    .select({ threadId: outreachJobs.gmailThreadId })
    .from(outreachJobs)
    .where(
      and(
        eq(outreachJobs.restaurantId, restaurantId),
        isNotNull(outreachJobs.gmailThreadId),
        isNotNull(outreachJobs.sentAt)
      )
    )
    .orderBy(desc(outreachJobs.sentAt))
    .limit(1);

  if (!prior?.threadId) return { threadId: null, inReplyTo: null, subject: null };

  try {
    const { messageId, subject } = await getThreadTail(prior.threadId);
    return { threadId: prior.threadId, inReplyTo: messageId, subject };
  } catch (err) {
    console.warn(`[thread] lookup failed for ${prior.threadId}:`, err instanceof Error ? err.message : err);
    return { threadId: prior.threadId, inReplyTo: null, subject: null };
  }
}
