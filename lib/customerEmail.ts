// Transactional email TO customers (as opposed to lib/alerts.ts, which is
// operator-only). Sent via Resend — never Gmail, which is reserved for cold
// outreach + replies. Fails soft: a failed notification never blocks the
// action that triggered it (e.g. delivering an order).

async function sendResendEmail(params: { to: string; subject: string; body: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_EMAIL_FROM ?? "alerts@clickworthytool.com";
  if (!apiKey) {
    console.warn(`[customer-email] RESEND_API_KEY not set — would have sent "${params.subject}" to ${params.to}`);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: params.to, subject: params.subject, text: params.body }),
    });
    if (!res.ok) {
      console.error(`[customer-email] Resend send failed (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.error("[customer-email] send threw:", err instanceof Error ? err.message : err);
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
      "Once we have them, we'll get your enhanced photos back to you. Reply to this email anytime if you need anything.\n\nClickworthy",
  },
  es: {
    subject: (name: string) => `Gracias por su pedido, ${name} — suba sus fotos`,
    body: (name: string, url: string) =>
      `Hola,\n\n¡Gracias por elegir Clickworthy para ${name}! Su pago fue procesado.\n\n` +
      `Suba sus fotos aquí cuando esté listo — sin apuro, este enlace no vence pronto:\n\n${url}\n\n` +
      "Una vez las tengamos, le enviaremos sus fotos mejoradas. Responda este correo cuando necesite algo.\n\nClickworthy",
  },
} as const;

// Sent once an admin marks a paid order `completed` — the customer's page was
// gated on this status, so this email is what actually tells them to go look.
export async function sendOrderDeliveredEmail(params: {
  to: string;
  restaurantName: string;
  language: string;
  deliveryUrl: string;
}): Promise<void> {
  const copy = COPY[params.language === "es" ? "es" : "en"];
  await sendResendEmail({
    to: params.to,
    subject: copy.subject(params.restaurantName),
    body: copy.body(params.restaurantName, params.deliveryUrl),
  });
}

// Sent once, right after a package payment is confirmed (the Stripe webhook's
// outreach branch) — without it, closing the tab after paying (easy on a slow
// connection, or if the owner gets pulled away) meant the ONLY way back to
// /l/[token]/upload was asking us for the link again.
export async function sendPackagePaymentConfirmationEmail(params: {
  to: string;
  restaurantName: string;
  language: string;
  uploadUrl: string;
}): Promise<void> {
  const copy = PAYMENT_CONFIRMATION_COPY[params.language === "es" ? "es" : "en"];
  await sendResendEmail({
    to: params.to,
    subject: copy.subject(params.restaurantName),
    body: copy.body(params.restaurantName, params.uploadUrl),
  });
}
