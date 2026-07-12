import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { enhancementOrders } from "@/db/schema";

// Polled by /enhance after the Stripe success redirect to find out whether
// the webhook has finished running the order through Claid yet.
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing session_id" }, { status: 400 });
  }

  const [order] = await db
    .select()
    .from(enhancementOrders)
    .where(eq(enhancementOrders.stripeSessionId, sessionId))
    .limit(1);

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  return NextResponse.json({
    status: order.status,
    prompt: order.prompt,
    photoCount: order.photoCount,
    totalCents: order.totalCents,
    photos: order.photos,
    results: order.results,
  });
}
