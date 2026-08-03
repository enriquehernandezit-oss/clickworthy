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
