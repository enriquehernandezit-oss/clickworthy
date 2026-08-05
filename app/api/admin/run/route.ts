import { NextRequest, NextResponse } from "next/server";
import { getBoss } from "@/lib/queue";
import { SOURCE_QUEUE, SEND_QUEUE, REPLY_QUEUE, STATS_QUEUE, PACKAGE_QUEUE } from "@/lib/queues";

// "Run now" — enqueue a job the worker will execute on its next poll. This only
// ENQUEUES; if the worker is down the job simply waits. Throttled to one enqueue
// per queue per 60s so a double-click doesn't stack runs.
// Only batch (re-scan) jobs are runnable here. `enrich-restaurant` is excluded
// because it needs a per-restaurant payload — that's a per-row trigger (G5),
// not a blank batch. `process-package` handles BOTH paid-package first passes
// and self-serve retries, so it's the button that re-processes paid work.
const RUNNABLE = new Set<string>([SOURCE_QUEUE, SEND_QUEUE, REPLY_QUEUE, STATS_QUEUE, PACKAGE_QUEUE]);

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const queue = String(form.get("queue") ?? "");
  if (!RUNNABLE.has(queue)) {
    return NextResponse.json({ error: "Unknown or non-runnable queue" }, { status: 400 });
  }

  try {
    const boss = await getBoss();
    // v12 signature: sendThrottled(name, data, options, seconds, key?)
    const jobId = await boss.sendThrottled(queue, {}, null, 60);
    if (jobId === null) {
      // Throttled — an enqueue for this queue happened within the last 60s.
      return NextResponse.json({ ok: true, throttled: true });
    }
    return NextResponse.json({ ok: true, jobId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/does not exist/i.test(msg)) {
      return NextResponse.json({ error: "Queue missing — the worker has never run." }, { status: 409 });
    }
    if (/schema|version|migrat/i.test(msg)) {
      return NextResponse.json({ error: "pg-boss schema not initialized — boot the worker once." }, { status: 409 });
    }
    console.error("[run] enqueue failed:", msg);
    return NextResponse.json({ error: `Couldn't enqueue: ${msg}` }, { status: 502 });
  }
}
