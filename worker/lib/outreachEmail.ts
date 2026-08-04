// Composes the outreach emails (subject + body + CAN-SPAM footer) from the
// APPROVED static templates. Merge fields: signature dish, owner first name
// (graceful fallback), restaurant name. Touch 1 and the bump are deliberately
// link-free and price-free — the only ask is a reply.

function senderName(): string {
  // `||` (not `??`) deliberately — an env var present but set to "" should
  // fall back too, same as if it were unset.
  return process.env.OUTREACH_SENDER_NAME || "Enrique";
}

// CAN-SPAM requires a valid physical postal address in every commercial email.
// Falls back to an obvious placeholder (not a silently blank line) so an
// empty-string env var is caught by reading the email, not missed entirely.
function postalAddress(): string {
  return process.env.OUTREACH_POSTAL_ADDRESS || "Clickworthy — [set OUTREACH_POSTAL_ADDRESS]";
}

function greeting(firstName: string | null, language: string): string {
  if (firstName) return language === "es" ? `Hola ${firstName},` : `Hi ${firstName},`;
  return language === "es" ? "Hola," : "Hi there,";
}

// Link-free opt-out (Touch 1/bump are intentionally link-free): replying STOP
// adds the sender to the suppression list (handled by the reply poller).
function complianceFooter(language: string): string {
  if (language === "es") {
    return (
      `\n\n—\nClickworthy · ${postalAddress()}\n` +
      `Si prefiere no recibir más mensajes, responda con STOP y no volveremos a escribirle.`
    );
  }
  return (
    `\n\n—\nClickworthy · ${postalAddress()}\n` +
    `Prefer not to hear from us? Reply STOP and we won't email you again.`
  );
}

export type OutreachEmail = { subject: string; body: string };

// --- Touch 1 (cold, approved) ----------------------------------------------

export function composeTouch1(params: {
  restaurantName: string;
  firstName: string | null;
  dish: string;
  language: string;
  subjectVariant: number; // rotate deterministically across restaurants
}): OutreachEmail {
  const { restaurantName, firstName, dish, language } = params;
  const v = ((params.subjectVariant % 3) + 3) % 3;

  const subject =
    language === "es"
      ? [`la foto de su ${dish}`, `una pregunta sobre las fotos de ${restaurantName}`, `el ${dish} de ${restaurantName}`][v]
      : [`your ${dish} photo`, `quick question about ${restaurantName}'s photos`, `the ${dish} at ${restaurantName}`][v];

  const body =
    language === "es"
      ? `${greeting(firstName, language)}\n\n` +
        `Estaba viendo ${restaurantName} en línea y el ${dish} me llamó la atención — pero honestamente, la foto no le hace justicia. Y hoy en día las fotos venden más que el menú.\n\n` +
        `Tengo un estudio pequeño que mejora fotos reales de comida para restaurantes independientes (nada de fotos de banco ni comida falsa de IA — sus platos reales, con el aspecto que tienen en persona).\n\n` +
        `¿Quiere verlo con su propia comida? Responda con una foto de cualquier plato — aunque sea del celular — y se la devuelvo mejorada en un día. Gratis, sin compromiso. Si no le encanta, la borra y ya.\n\n` +
        `${senderName()}\nClickworthy`
      : `${greeting(firstName, language)}\n\n` +
        `I was looking at ${restaurantName} online and your ${dish} caught my eye — but honestly, the photo doesn't do it justice. And photos are doing more selling than menus these days.\n\n` +
        `I run a small studio that enhances real food photos for independent restaurants (no stock images, no fake AI food — your actual dishes, made to look the way they do in person).\n\n` +
        `Want to see it on your own food? Reply with one photo of any dish — even a phone shot — and I'll send it back enhanced within a day. Free, no strings. If you don't love it, delete it and that's that.\n\n` +
        `${senderName()}\nClickworthy`;

  return { subject, body: body + complianceFooter(language) };
}

// --- Touch 1.5 bump (approved; sent in-thread, no new subject) --------------

export function composeBump(params: { firstName: string | null; language: string }): string {
  const { firstName, language } = params;
  if (language === "es") {
    return (
      `${greeting(firstName, language)}\n\n` +
      `Un recordatorio rápido por si esto quedó enterrado.\n\n` +
      `La oferta sigue en pie: mándeme una foto de un plato y se la devuelvo mejorada profesionalmente, gratis. Le toma 30 segundos, no cuesta nada, y la foto es suya de todos modos.\n\n` +
      `Si no le interesa, sin problema — dígamelo y no vuelvo a escribir.\n\n` +
      `${senderName()}` +
      complianceFooter(language)
    );
  }
  return (
    `${greeting(firstName, language)}\n\n` +
    `Quick bump in case this got buried.\n\n` +
    `The offer stands: send me one photo of a dish and I'll send it back professionally enhanced, free. Takes you 30 seconds, costs you nothing, and you keep the photo either way.\n\n` +
    `If it's a no, no worries — just say so and I won't follow up again.\n\n` +
    `${senderName()}` +
    complianceFooter(language)
  );
}

// --- Free-sample delivery / Touch 2 (approved) ------------------------------

export function composeTouch2(params: {
  restaurantName: string;
  firstName: string | null;
  dish: string;
  funnelUrl: string;
  bookingUrl: string | null;
  language: string;
}): OutreachEmail {
  const { firstName, dish, funnelUrl, bookingUrl, language } = params;

  const subject = language === "es" ? `su ${dish}, mejorado` : `your ${dish}, enhanced`;

  const talkLine = bookingUrl
    ? language === "es"
      ? `\n\nO si prefiere hablar primero: ${bookingUrl} — 15 minutos, sin discurso de ventas.`
      : `\n\nOr if you'd rather talk first: ${bookingUrl} — 15 minutes, no pitch marathon.`
    : "";

  const body =
    language === "es"
      ? `${greeting(firstName, language)}\n\n` +
        `Aquí está — su ${dish}, mejorado. La misma foto que envió, nada inventado.\n\n` +
        `Esa foto es suya. Úsela donde quiera, sin costo, sin trampa.\n\n` +
        `Ahora, la parte que pocos dueños han calculado: las apps de delivery se quedan con 15–30% de cada orden — más bien 30–40% cuando suman promociones y cargos — mientras que su propio sitio web, perfil de Google e Instagram le pagan el 100%. Pero en la mayoría de los restaurantes, las apps se ven mejor que los canales propios. Y por eso la gente ordena por ahí.\n\n` +
        `Eso es lo que arreglamos. Tomamos sus 20–30 platos principales, los mejoramos como el de arriba, y se los entregamos listos para su sitio web, Google Business Profile, Instagram y Yelp — para que sus propios canales vendan más que su página de DoorDash. Un fotógrafo cobra $1,200–$3,500 por una sesión así. Nosotros lo hacemos por una fracción, con fotos que ya tiene o que toma con su celular.\n\n` +
        `Todo está aquí, incluyendo su antes y después: ${funnelUrl}${talkLine}\n\n` +
        `De cualquier forma, disfrute la foto.\n\n` +
        `${senderName()}\nClickworthy`
      : `${greeting(firstName, language)}\n\n` +
        `Here it is — your ${dish}, enhanced. Same photo you sent, nothing invented.\n\n` +
        `That photo is yours. Use it anywhere, no charge, no catch.\n\n` +
        `Here's the part most owners haven't done the math on: the delivery apps take 15–30% of every order — closer to 30–40% once promos and fees pile on — while your own website, Google profile, and Instagram pay you 100%. But for most restaurants, the apps' listings look better than their own channels. So that's where people order.\n\n` +
        `We fix that. We take your top 20–30 dishes, enhance them like the one above, and deliver them sized and ready for your website, Google Business Profile, Instagram, and Yelp — so your own channels finally outsell your DoorDash page. A photographer charges $1,200–$3,500 for a session like that. We do it for a fraction, using photos you already have or shoot on your phone.\n\n` +
        `Everything's here, including your before/after: ${funnelUrl}${talkLine}\n\n` +
        `Either way, enjoy the photo.\n\n` +
        `${senderName()}\nClickworthy`;

  return { subject, body: body + complianceFooter(language) };
}

// Detects a "STOP"/opt-out reply (plain, case-insensitive, tolerant of
// surrounding whitespace/punctuation). Kept conservative so a genuine reply
// that merely contains the word "stop" mid-sentence isn't misread.
export function isOptOut(replyText: string): boolean {
  const firstLine = replyText.trim().split(/\r?\n/)[0]?.trim().toLowerCase() ?? "";
  const normalized = firstLine.replace(/[.!,]/g, "");
  return ["stop", "unsubscribe", "baja", "no", "remove"].includes(normalized);
}
