// Operator alerting via Resend. Used to surface failures that need a human —
// a paid order that couldn't be enhanced, a webhook with no matching order,
// etc. — instead of letting them die in a log nobody reads.
//
// Fails safe: if Resend isn't configured, it logs and returns rather than
// throwing, so an alert failure never breaks the flow it's reporting on.
// Shared by the Next.js app (Stripe webhook) and the worker.

export async function sendAlert(subject: string, body: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM ?? "alerts@clickworthytool.com";

  if (!apiKey || !to) {
    console.error(`[alert] (unsent — RESEND_API_KEY/ALERT_EMAIL_TO not set) ${subject} :: ${body}`);
    return;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject: `[Clickworthy] ${subject}`, text: body }),
    });
    if (!res.ok) {
      console.error(`[alert] Resend send failed (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.error("[alert] send threw:", err instanceof Error ? err.message : err);
  }
}
