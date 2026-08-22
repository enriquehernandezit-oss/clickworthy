// Transactional email TO customers (as opposed to lib/alerts.ts, which is
// operator-only). Sent via Resend — never Gmail, which is reserved for cold
// outreach + replies. Fails soft: a failed notification never blocks the
// action that triggered it (e.g. delivering an order) — callers that need to
// know whether it actually sent read the boolean return value (e.g. to log an
// audit row with the true outcome, or to know whether a resend is needed).
export async function sendCustomerEmail(params: { to: string; subject: string; body: string }): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  // Deliberately its own env var, not ALERT_EMAIL_FROM (lib/alerts.ts's) — that
  // one is for internal operator notifications only. This is customer-facing
  // mail, so it belongs under the customer-service identity, not the alerting one.
  const from = process.env.CUSTOMER_EMAIL_FROM ?? "contact@clickworthytool.com";
  if (!apiKey) {
    console.warn(`[customer-email] RESEND_API_KEY not set — would have sent "${params.subject}" to ${params.to}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: params.to, subject: params.subject, text: params.body }),
    });
    if (!res.ok) {
      console.error(`[customer-email] Resend send failed (${res.status}): ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[customer-email] send threw:", err instanceof Error ? err.message : err);
    return false;
  }
}

const COPY = {
  en: {
    subject: (name: string) => `Your photos are ready, ${name}`,
    body: (name: string, url: string) =>
      `Hi,\n\nYour enhanced photos for ${name} are ready to download:\n\n${url}\n\n` +
      "Thanks for trusting us with your menu — reply to this email anytime if you need anything.\n\nClickworthy",
  },
  es: {
    subject: (name: string) => `Sus fotos están listas, ${name}`,
    body: (name: string, url: string) =>
      `Hola,\n\nSus fotos mejoradas para ${name} ya están listas para descargar:\n\n${url}\n\n` +
      "Gracias por confiarnos su menú — responda este correo cuando necesite algo.\n\nClickworthy",
  },
} as const;

const PAYMENT_CONFIRMATION_COPY = {
  en: {
    subject: (name: string) => `Thanks for your order, ${name} — upload your photos`,
    body: (name: string, url: string) =>
      `Hi,\n\nThanks for choosing Clickworthy for ${name}! Your payment went through.\n\n` +
      `Upload your photos here whenever you're ready — no rush, this link doesn't expire soon:\n\n${url}\n\n` +
      "Once we have them, we'll get your enhanced photos back to you. Reply to this email anytime if you need anything.",
  },
  es: {
    subject: (name: string) => `Gracias por su pedido, ${name} — suba sus fotos`,
    body: (name: string, url: string) =>
      `Hola,\n\n¡Gracias por elegir Clickworthy para ${name}! Su pago fue procesado.\n\n` +
      `Suba sus fotos aquí cuando esté listo — sin apuro, este enlace no vence pronto:\n\n${url}\n\n` +
      "Una vez las tengamos, le enviaremos sus fotos mejoradas. Responda este correo cuando necesite algo.",
  },
} as const;

// Pure — seeds the editable delivery-email box on the Orders page
// (app/admin/photo/PackageActions.tsx). What actually sends can differ from
// this: a human reviews and can rewrite it before clicking Send.
export function composeOrderDeliveredEmail(params: {
  restaurantName: string;
  language: string;
  deliveryUrl: string;
}): { subject: string; body: string } {
  const copy = COPY[params.language === "es" ? "es" : "en"];
  return { subject: copy.subject(params.restaurantName), body: copy.body(params.restaurantName, params.deliveryUrl) };
}

// Pure — seeds the editable draft the Stripe webhook queues (see
// app/api/webhooks/stripe/route.ts and app/api/admin/approvals/route.ts).
// Drafted once, right after a package payment is confirmed — without SOME
// form of this, closing the tab after paying (easy on a slow connection, or
// if the owner gets pulled away) meant the ONLY way back to /l/[token]/upload
// was asking us for the link again. A human still approves + can edit before
// it actually sends.
export function composePackagePaymentConfirmationEmail(params: {
  restaurantName: string;
  language: string;
  uploadUrl: string;
}): { subject: string; body: string } {
  const copy = PAYMENT_CONFIRMATION_COPY[params.language === "es" ? "es" : "en"];
  return { subject: copy.subject(params.restaurantName), body: copy.body(params.restaurantName, params.uploadUrl) };
}
