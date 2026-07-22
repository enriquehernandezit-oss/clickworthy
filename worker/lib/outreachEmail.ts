// Composes the actual outreach emails (subject + body + compliance footer)
// from the Claude-generated content. Keeps CAN-SPAM compliance in one place:
// every email gets a physical postal address and a plain-text opt-out.

// CAN-SPAM requires a valid physical postal address in every commercial email.
// Set OUTREACH_POSTAL_ADDRESS to the business's real mailing address.
function postalAddress(): string {
  return process.env.OUTREACH_POSTAL_ADDRESS ?? "Clickworthy — [set OUTREACH_POSTAL_ADDRESS]";
}

// Link-free opt-out (Touch 1 is intentionally link-free): replying STOP adds the
// sender to the suppression list (handled by the reply poller).
function complianceFooter(language: string): string {
  if (language === "es") {
    return (
      `\n\n—\nClickworthy · ${postalAddress()}\n` +
      `Si prefieres no recibir más mensajes, responde con STOP y no volveremos a escribirte.`
    );
  }
  return (
    `\n\n—\nClickworthy · ${postalAddress()}\n` +
    `Prefer not to hear from us? Reply STOP and we won't email you again.`
  );
}

export type OutreachEmail = { subject: string; body: string };

export function composeTouch1(params: {
  restaurantName: string;
  generatedBody: string;
  language: string;
}): OutreachEmail {
  const subject =
    params.language === "es"
      ? `Las fotos de ${params.restaurantName} en Google`
      : `A quick note about ${params.restaurantName}'s photos`;

  return {
    subject,
    body: params.generatedBody.trim() + complianceFooter(params.language),
  };
}

export function composeTouch2(params: {
  restaurantName: string;
  magicLinkUrl: string;
  language: string;
}): OutreachEmail {
  const subject =
    params.language === "es"
      ? `Aquí está tu foto mejorada, ${params.restaurantName}`
      : `Here's your enhanced photo, ${params.restaurantName}`;

  const body =
    params.language === "es"
      ? `Aquí tienes la versión mejorada de tu foto — y el resto de tu listado, listo para transformar:\n\n` +
        `${params.magicLinkUrl}\n\n` +
        `Échale un vistazo y dime qué te parece.` +
        complianceFooter(params.language)
      : `Here's the enhanced version of your photo — plus the rest of your listing, ready to transform:\n\n` +
        `${params.magicLinkUrl}\n\n` +
        `Take a look and let me know what you think.` +
        complianceFooter(params.language);

  return { subject, body };
}

// Detects a "STOP"/opt-out reply (plain, case-insensitive, tolerant of
// surrounding whitespace/punctuation). Kept conservative so a genuine reply
// that merely contains the word "stop" mid-sentence isn't misread.
export function isOptOut(replyText: string): boolean {
  const firstLine = replyText.trim().split(/\r?\n/)[0]?.trim().toLowerCase() ?? "";
  const normalized = firstLine.replace(/[.!,]/g, "");
  return ["stop", "unsubscribe", "baja", "no", "remove"].includes(normalized);
}
