import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { enhancementOrders } from "@/db/schema";

// Self-serve /enhance order actions (behind the admin proxy).
//   retry — re-queue a failed (or stuck) order for the worker. The pickup query
//           in worker/jobs/processEnhancementOrders.ts is
//           `status='processing' AND results IS NULL`, and a failed order has
//           BOTH a 'failed' status and a non-null results array — so without
//           clearing both it can never be picked up again. This is the only way
//           a paid-but-failed order is recoverable short of a SQL client.

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const id = Number(form.get("orderId"));
  const action = String(form.get("action") ?? "");
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Bad orderId" }, { status: 400 });

  const [order] = await db.select().from(enhancementOrders).where(eq(enhancementOrders.id, id)).limit(1);
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (action === "retry") {
    if (order.status !== "failed") {
      return NextResponse.json({ error: `Can only retry a failed order (this is ${order.status}).` }, { status: 409 });
    }
    await db
      .update(enhancementOrders)
      .set({ status: "processing", results: null, completedAt: null })
      .where(eq(enhancementOrders.id, id));
    return NextResponse.json({ ok: true, status: "processing" });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
