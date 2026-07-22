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
    morePhotosTitle: (n: number) => `We found ${n} more photos worth enhancing`,
    morePhotosBody:
      "The rest of your listing has the same untapped potential. Pick a package and we'll enhance them all — same look, no fake scenes, just your real photos at their best.",
    pickPackage: "Choose your package",
    perfect: "Most popular",
    choose: "Get started",
    starting: "Starting checkout…",
    expired: "This link has expired. Reply to our email and we'll send you a fresh one.",
    notReady: "Your enhanced sample is still being prepared — check back shortly.",
    error: "Something went wrong. Please try again.",
    // Post-payment upload + delivery
    uploadTitle: "Upload your photos",
    uploadBody: (n: number) => `Your package includes up to ${n} photos. Drag them in below.`,
    uploadZone: "Drag photos here, or click to browse",
    uploadFormats: "JPEG, PNG, or WEBP",
    enhanceBtn: "Enhance my photos",
    enhancing: "Enhancing your photos — this can take a couple of minutes.",
    autoUpdate: "This page updates automatically.",
    deliveryTitle: "Your enhanced photos",
    download: "Download",
    notPaid: "Complete your purchase to upload your photos.",
    backToPackages: "Back to packages",
    photoFailed: "Couldn't enhance this one — contact us and we'll fix it.",
  },
  es: {
    eyebrow: "Tu foto mejorada gratis",
    before: "Antes",
    after: "Después",
    toggleToBefore: "Ver antes",
    toggleToAfter: "Ver después",
    morePhotosTitle: (n: number) => `Encontramos ${n} fotos más que vale la pena mejorar`,
    morePhotosBody:
      "El resto de tu listado tiene el mismo potencial. Elige un paquete y las mejoramos todas — el mismo estilo, sin escenas falsas, solo tus fotos reales en su mejor versión.",
    pickPackage: "Elige tu paquete",
    perfect: "Más popular",
    choose: "Empezar",
    starting: "Abriendo el pago…",
    expired: "Este enlace ha expirado. Responde a nuestro correo y te enviaremos uno nuevo.",
    notReady: "Tu muestra mejorada aún se está preparando — vuelve en un momento.",
    error: "Algo salió mal. Inténtalo de nuevo.",
    // Post-payment upload + delivery
    uploadTitle: "Sube tus fotos",
    uploadBody: (n: number) => `Tu paquete incluye hasta ${n} fotos. Arrástralas abajo.`,
    uploadZone: "Arrastra fotos aquí, o haz clic para buscar",
    uploadFormats: "JPEG, PNG o WEBP",
    enhanceBtn: "Mejorar mis fotos",
    enhancing: "Mejorando tus fotos — esto puede tardar un par de minutos.",
    autoUpdate: "Esta página se actualiza automáticamente.",
    deliveryTitle: "Tus fotos mejoradas",
    download: "Descargar",
    notPaid: "Completa tu compra para subir tus fotos.",
    backToPackages: "Volver a los paquetes",
    photoFailed: "No pudimos mejorar esta — contáctanos y lo resolvemos.",
  },
} as const;

export function getCopy(language: string | null): (typeof funnelCopy)[Lang] {
  return language === "es" ? funnelCopy.es : funnelCopy.en;
}
