import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { enhancementOrders } from "@/db/schema";
import { moderatePrompt } from "@/lib/moderation";
import { pricePerPhotoCents, totalPriceCents } from "@/lib/pricing";
import { storePhotos } from "@/lib/storage";
import { getStripe } from "@/lib/stripe";

const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIN_PROMPT_LENGTH = 3;
const MAX_PROMPT_LENGTH = 5000; // matches Claid's Image AI Edit prompt limit

function appOriginFrom(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const host = request.headers.get("host") ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();

  const prompt = String(formData.get("prompt") ?? "").trim();
  const photos = formData.getAll("photos").filter((entry): entry is File => entry instanceof File);

  if (photos.length === 0) {
    return NextResponse.json({ error: "Please upload at least one photo." }, { status: 400 });
  }
  if (prompt.length < MIN_PROMPT_LENGTH) {
    return NextResponse.json(
      { error: "Please describe how you'd like your photos enhanced." },
      { status: 400 }
    );
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json(
      { error: "That description is a bit too long — please shorten it." },
      { status: 400 }
    );
  }
  for (const photo of photos) {
    if (!ALLOWED_CONTENT_TYPES.has(photo.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${photo.type || photo.name}. Please upload JPEG, PNG, or WEBP images.` },
        { status: 400 }
      );
    }
  }

  // Step 1 — moderation guardrail on the free-text prompt before anything else.
  const moderation = await moderatePrompt(prompt);
  if (moderation.flagged) {
    return NextResponse.json(
      {
        error:
          "We couldn't accept that request as written — please rephrase your enhancement instructions.",
      },
      { status: 400 }
    );
  }

  // Step 2 — authoritative, server-side price. Never trust a client total.
  const quantity = photos.length;
  const perPhotoCents = pricePerPhotoCents(quantity);
  const totalCents = totalPriceCents(quantity);

  const appOrigin = appOriginFrom(request);

  let session;
  try {
    const stripe = getStripe();
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      allow_promotion_codes: true,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: totalCents,
            product_data: {
              name: `${quantity} enhanced photo${quantity === 1 ? "" : "s"}`,
              description: `${quantity} photo${quantity === 1 ? "" : "s"} × $${(perPhotoCents / 100).toFixed(2)} each`,
            },
          },
        },
      ],
      success_url: `${appOrigin}/enhance?outcome=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appOrigin}/enhance?outcome=cancelled`,
    });
  } catch (err) {
    console.error("[create-checkout-session] Stripe session creation failed:", err);
    return NextResponse.json(
      { error: "We couldn't start checkout. Please try again in a moment." },
      { status: 502 }
    );
  }

  if (!session.url) {
    console.error("[create-checkout-session] Stripe session has no url:", session.id);
    return NextResponse.json(
      { error: "We couldn't start checkout. Please try again in a moment." },
      { status: 502 }
    );
  }

  // Step 3 — persist photos + prompt keyed by the Checkout Session ID, before
  // redirecting the user to Stripe, so the webhook has something to process
  // once payment is confirmed.
  try {
    const { storageType, photos: storedPhotos } = await storePhotos(session.id, photos, appOrigin);

    await db.insert(enhancementOrders).values({
      stripeSessionId: session.id,
      prompt,
      photoCount: quantity,
      totalCents,
      storageType,
      photos: storedPhotos,
      status: "pending",
    });
  } catch (err) {
    console.error("[create-checkout-session] Failed to store photos/order:", err);
    return NextResponse.json(
      { error: "We couldn't save your photos. Please try again in a moment." },
      { status: 502 }
    );
  }

  return NextResponse.json({ url: session.url });
}
