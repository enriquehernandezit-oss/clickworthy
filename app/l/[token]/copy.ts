// Bilingual copy for the magic-link funnel. US-based but Miami/NYC skew
// bilingual, so the page renders in the restaurant's stored language.

export type Lang = "en" | "es";

export const funnelCopy = {
  en: {
    eyebrow: "Your free enhanced photo",
    before: "Before",
    after: "After",
    toggleToBefore: "Show before",
    toggleToAfter: "Show after",
    morePhotosTitle: (n: number) => `${n} more photos are costing you direct orders`,
    morePhotosBody:
      "Every dish on your own website, Google, and Instagram is a chance to win an order you keep 100% of. Right now they don't look the part. We fix your whole menu — your real dishes, professionally enhanced.",
    pickPackage: "Choose your package",
    recommended: "Recommended",
    forNewOpenings: "For new openings",
    choose: "Get started",
    bookACall: "Book a 15-min call",
    askUs: "Ask us about this plan",
    starting: "Starting checkout…",
    photographerAnchor: "A photographer charges $1,200–$3,500 for a shoot like this.",
    guarantee: "Don't love them? Full refund — and you keep the photos. Delivered within 5 business days.",
    questionsCta: "Questions? Grab 15 minutes with us.",
    expired: "This link has expired. Reply to our email and we'll send you a fresh one.",
    notReady: "Your enhanced sample is still being prepared — check back shortly.",
    error: "Something went wrong. Please try again.",
    // Post-payment upload + delivery
    uploadTitle: "Upload your photos",
    uploadBody: (n: number) => `Your package includes up to ${n} photos. Drag them in below.`,
    uploadZone: "Drag photos here, or click to browse",
    uploadFormats: "JPEG, PNG, or WEBP",
    enhanceBtn: "Send my photos",
    enhancing: "We've got your photos — our team is finishing them by hand. You'll have them within 5 business days.",
    autoUpdate: "This page updates automatically when they're ready.",
    deliveryTitle: "Your enhanced photos",
    download: "Download",
    notPaid: "Complete your purchase to upload your photos.",
    backToPackages: "Back to packages",
    photoFailed: "Couldn't finish this one — contact us and we'll fix it.",
  },
  es: {
    eyebrow: "Tu foto mejorada gratis",
    before: "Antes",
    after: "Después",
    toggleToBefore: "Ver antes",
    toggleToAfter: "Ver después",
    morePhotosTitle: (n: number) => `${n} fotos más te están costando órdenes directas`,
    morePhotosBody:
      "Cada plato en tu propio sitio web, Google e Instagram es una orden que te quedas al 100%. Ahora mismo no lucen como deberían. Arreglamos todo tu menú — tus platos reales, mejorados profesionalmente.",
    pickPackage: "Elige tu paquete",
    recommended: "Recomendado",
    forNewOpenings: "Para aperturas",
    choose: "Empezar",
    bookACall: "Agenda 15 minutos",
    askUs: "Pregúntanos por este plan",
    starting: "Abriendo el pago…",
    photographerAnchor: "Un fotógrafo cobra $1,200–$3,500 por una sesión así.",
    guarantee: "¿No te encantan? Reembolso completo — y te quedas las fotos. Entrega en 5 días hábiles.",
    questionsCta: "¿Preguntas? Agenda 15 minutos con nosotros.",
    expired: "Este enlace ha expirado. Responde a nuestro correo y te enviaremos uno nuevo.",
    notReady: "Tu muestra mejorada aún se está preparando — vuelve en un momento.",
    error: "Algo salió mal. Inténtalo de nuevo.",
    // Post-payment upload + delivery
    uploadTitle: "Sube tus fotos",
    uploadBody: (n: number) => `Tu paquete incluye hasta ${n} fotos. Arrástralas abajo.`,
    uploadZone: "Arrastra fotos aquí, o haz clic para buscar",
    uploadFormats: "JPEG, PNG o WEBP",
    enhanceBtn: "Enviar mis fotos",
    enhancing: "Ya tenemos tus fotos — nuestro equipo las está finalizando a mano. Las tendrás en 5 días hábiles.",
    autoUpdate: "Esta página se actualiza automáticamente cuando estén listas.",
    deliveryTitle: "Tus fotos mejoradas",
    download: "Descargar",
    notPaid: "Completa tu compra para subir tus fotos.",
    backToPackages: "Volver a los paquetes",
    photoFailed: "No pudimos finalizar esta — contáctanos y lo resolvemos.",
  },
} as const;

export function getCopy(language: string | null): (typeof funnelCopy)[Lang] {
  return language === "es" ? funnelCopy.es : funnelCopy.en;
}
