"use client";

import { useState } from "react";
import Header from "./components/Header";
import { PACKAGE_ORDER, PACKAGES, formatCents } from "@/lib/packages";

const CONTACT_EMAIL = "contact@clickworthytool.com";
const BOOKING_URL = process.env.NEXT_PUBLIC_BOOKING_URL;

type Lang = "en" | "es";

function FoodPlate({ enhanced }: { enhanced?: boolean }) {
  const plate = enhanced ? "#FFFBF5" : "#D8D3C9";
  const rim = enhanced ? "#F0E4D3" : "#B8B2A6";
  const sauceShadow = enhanced ? "#B33A1C" : "#71685C";
  const sauce = enhanced ? "#D94A26" : "#8A7A6A";
  const noodle = enhanced ? "#F2B84B" : "#A79C87";
  const basil = enhanced ? "#4C7A3B" : "#847E6E";
  const tomato = enhanced ? "#E4432B" : "#9A8B7A";
  return (
    <svg viewBox="0 0 240 240" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
      <rect width="240" height="240" fill={plate} />
      <circle cx="120" cy="120" r="108" fill={plate} stroke={rim} strokeWidth="3" />
      <ellipse cx="120" cy="130" rx="78" ry="60" fill={sauceShadow} opacity="0.5" />
      <ellipse cx="120" cy="124" rx="76" ry="56" fill={sauce} />
      <path d="M60 110 Q100 90 140 110 T220 105" stroke={noodle} strokeWidth="9" fill="none" strokeLinecap="round" opacity="0.85" />
      <path d="M55 135 Q100 150 145 130 T215 140" stroke={noodle} strokeWidth="9" fill="none" strokeLinecap="round" opacity="0.7" />
      <path d="M65 155 Q105 170 150 152" stroke={noodle} strokeWidth="8" fill="none" strokeLinecap="round" opacity="0.6" />
      <circle cx="95" cy="105" r="7" fill={tomato} />
      <circle cx="155" cy="150" r="6" fill={tomato} />
      <circle cx="145" cy="95" r="5" fill={tomato} />
      <ellipse cx="110" cy="145" rx="6" ry="3" fill={basil} transform="rotate(30 110 145)" />
      <ellipse cx="140" cy="120" rx="6" ry="3" fill={basil} transform="rotate(-20 140 120)" />
      <ellipse cx="90" cy="130" rx="5" ry="2.5" fill={basil} transform="rotate(60 90 130)" />
      {enhanced ? (
        <>
          <circle cx="100" cy="118" r="1.6" fill="#FFF7E6" />
          <circle cx="132" cy="108" r="1.4" fill="#FFF7E6" />
          <circle cx="150" cy="135" r="1.5" fill="#FFF7E6" />
          <circle cx="115" cy="150" r="1.3" fill="#FFF7E6" />
          <ellipse cx="95" cy="95" rx="40" ry="22" fill="white" opacity="0.18" />
        </>
      ) : (
        <rect width="240" height="240" fill="#000000" opacity="0.08" />
      )}
    </svg>
  );
}

const COPY = {
  en: {
    switchTo: "ES",
    heroBadge: "For independent restaurants",
    heroTitle: "You pay DoorDash 30% to make your food look good on their app.",
    heroSub:
      "Your own website, Google profile, and Instagram are the only places you keep 100% of the order. We make your real dishes look better than your delivery listing — so more customers order direct.",
    heroCta: "Send us one dish photo — free",
    heroNote: "We enhance it and send it back within a day. No cost, no catch.",
    before: "Before",
    after: "After",
    howTitle: "How it works",
    howSub: "Start with one photo. No commitment.",
    how: [
      { t: "Reply with one dish photo", d: "Even a phone shot — any dish on your menu." },
      { t: "We enhance it, free", d: "Your real dish, professionally enhanced — same food, same plate, the way it looks in person. Back within a day." },
      { t: "Love it? We do your whole menu", d: "We enhance your top dishes and deliver them sized for your website, Google, Instagram, and Yelp." },
    ],
    offerTitle: "Then, the whole menu",
    offerSub: "A photographer charges $1,200–$3,500 for a shoot like this. We work from photos you already have.",
    anchor: "vs. $1,200–$3,500 for a photographer",
    popular: "Most popular",
    bookCall: "Book a 15-min call",
    startFree: "Every project starts with a free sample.",
    guaranteeTitle: "Love it, or your money back.",
    guaranteeBody: "If the enhanced photos don't beat what you have now, you don't pay. Delivered within 5 business days.",
    contactTitle: "Questions? Reach out anytime.",
    footer: "Real restaurant photos, professionally enhanced.",
  },
  es: {
    switchTo: "EN",
    heroBadge: "Para restaurantes independientes",
    heroTitle: "Le paga 30% a DoorDash para que su comida se vea bien en la app de ellos.",
    heroSub:
      "Su propio sitio web, perfil de Google e Instagram son los únicos lugares donde se queda con el 100% de la orden. Hacemos que sus platos reales se vean mejor que en su listado de delivery — para que más clientes ordenen directo.",
    heroCta: "Envíenos una foto de un plato — gratis",
    heroNote: "La mejoramos y se la devolvemos en un día. Sin costo, sin compromiso.",
    before: "Antes",
    after: "Después",
    howTitle: "Cómo funciona",
    howSub: "Empiece con una foto. Sin compromiso.",
    how: [
      { t: "Responda con la foto de un plato", d: "Aunque sea del celular — cualquier plato de su menú." },
      { t: "La mejoramos, gratis", d: "Su plato real, mejorado profesionalmente — la misma comida, el mismo plato, como se ve en persona. En un día." },
      { t: "¿Le encanta? Hacemos todo el menú", d: "Mejoramos sus mejores platos y se los entregamos listos para su sitio, Google, Instagram y Yelp." },
    ],
    offerTitle: "Después, todo el menú",
    offerSub: "Un fotógrafo cobra $1,200–$3,500 por una sesión así. Nosotros trabajamos con fotos que ya tiene.",
    anchor: "vs. $1,200–$3,500 de un fotógrafo",
    popular: "Más popular",
    bookCall: "Agende una llamada de 15 min",
    startFree: "Cada proyecto empieza con una muestra gratis.",
    guaranteeTitle: "Le encanta, o le devolvemos su dinero.",
    guaranteeBody: "Si las fotos mejoradas no superan lo que tiene ahora, no paga. Entregado en 5 días hábiles.",
    contactTitle: "¿Preguntas? Escríbanos cuando quiera.",
    footer: "Fotos reales de restaurantes, mejoradas profesionalmente.",
  },
} as const;

export default function Home() {
  const [lang, setLang] = useState<Lang>("en");
  const c = COPY[lang];

  return (
    <div className="flex min-h-full flex-col bg-stone-50 text-stone-900">
      <Header />

      <main className="flex-1">
        {/* Language toggle */}
        <div className="mx-auto flex max-w-7xl justify-end px-6 pt-4 lg:px-8">
          <button
            type="button"
            onClick={() => setLang(lang === "en" ? "es" : "en")}
            className="btn-press rounded-md border border-stone-300 px-2.5 py-1 text-xs font-semibold text-stone-600 hover:bg-stone-100"
          >
            {c.switchTo}
          </button>
        </div>

        {/* Hero */}
        <section className="relative overflow-hidden">
          <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-16 px-6 pb-24 pt-10 sm:pb-28 lg:grid-cols-2 lg:gap-12 lg:px-8 lg:pb-32 lg:pt-16">
            <div>
              <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange-700">
                {c.heroBadge}
              </p>
              <h1 className="text-4xl font-bold [text-wrap:balance] [letter-spacing:-0.02em] sm:text-5xl lg:text-[3.4rem] lg:leading-[1.05] lg:[letter-spacing:-0.03em]">
                {c.heroTitle}
              </h1>
              <p className="mt-6 max-w-xl text-lg [text-wrap:pretty] leading-relaxed text-stone-600">{c.heroSub}</p>
              <div className="mt-10 flex flex-col gap-3">
                <a
                  href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Free sample photo")}`}
                  className="btn-press inline-flex items-center justify-center rounded-lg bg-orange-600 px-6 py-3.5 text-base font-semibold text-white shadow-sm hover:bg-orange-700 sm:self-start"
                >
                  {c.heroCta}
                </a>
                <p className="text-sm text-stone-500">{c.heroNote}</p>
              </div>
            </div>

            {/* Before/after graphic — the real mechanism */}
            <div className="relative mx-auto aspect-square w-full max-w-md lg:mx-0">
              <div className="absolute -top-8 right-0 h-64 w-64 rounded-full bg-orange-300/40 blur-3xl" />
              <div className="absolute -bottom-8 left-0 h-56 w-56 rounded-full bg-red-300/30 blur-3xl" />
              <div className="absolute left-2 top-12 h-64 w-48 -rotate-6 overflow-hidden rounded-2xl shadow-xl ring-1 ring-black/5 sm:h-72 sm:w-56">
                <FoodPlate />
                <div className="absolute bottom-4 left-4 rounded-full bg-white/80 px-3 py-1 text-xs font-semibold text-stone-600 shadow-sm">
                  {c.before}
                </div>
              </div>
              <div className="absolute right-2 top-2 h-64 w-48 rotate-3 overflow-hidden rounded-2xl shadow-2xl ring-1 ring-black/5 sm:h-72 sm:w-56">
                <FoodPlate enhanced />
                <div className="absolute bottom-4 left-4 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-stone-800 shadow-sm">
                  {c.after}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="border-t border-stone-200 bg-white">
          <div className="mx-auto max-w-7xl px-6 py-24 lg:px-8 lg:py-28">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-bold [text-wrap:balance] tracking-tight sm:text-4xl">{c.howTitle}</h2>
              <p className="mt-4 text-lg text-stone-600">{c.howSub}</p>
            </div>
            <div className="mt-16 grid grid-cols-1 gap-8 md:grid-cols-3">
              {c.how.map((step, i) => (
                <div key={i} className="rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-orange-50 text-sm font-bold text-orange-600">
                    {i + 1}
                  </div>
                  <h3 className="mt-6 text-lg font-semibold">{step.t}</h3>
                  <p className="mt-3 text-sm [text-wrap:pretty] leading-relaxed text-stone-600">{step.d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Offer */}
        <section id="pricing" className="border-t border-stone-200 bg-stone-50">
          <div className="mx-auto max-w-7xl px-6 py-24 lg:px-8 lg:py-28">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-bold [text-wrap:balance] tracking-tight sm:text-4xl">{c.offerTitle}</h2>
              <p className="mt-4 text-lg [text-wrap:pretty] text-stone-600">{c.offerSub}</p>
            </div>

            <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-3">
              {PACKAGE_ORDER.map((id) => {
                const pkg = PACKAGES[id];
                const featured = id === "glow_up";
                return (
                  <div
                    key={id}
                    className={`flex flex-col rounded-2xl border bg-white p-7 shadow-sm ${
                      featured ? "border-orange-300 ring-1 ring-orange-200" : "border-stone-200"
                    }`}
                  >
                    {featured && (
                      <span className="mb-2 inline-block self-start rounded-full bg-orange-100 px-2.5 py-0.5 text-xs font-semibold text-orange-700">
                        {c.popular}
                      </span>
                    )}
                    <div className="text-sm font-semibold">{pkg.name[lang]}</div>
                    <div className="mt-2 flex items-baseline gap-1.5">
                      <span className="text-3xl font-bold tracking-tight tabular-nums">{formatCents(pkg.priceCents)}</span>
                      <span className="text-sm text-stone-500">{pkg.billingNote[lang]}</span>
                    </div>
                    <p className="mt-3 text-sm [text-wrap:pretty] leading-relaxed text-stone-600">{pkg.blurb[lang]}</p>
                    {featured && <p className="mt-3 text-xs font-medium text-stone-400">{c.anchor}</p>}
                    {!pkg.checkoutEnabled && BOOKING_URL && (
                      <a
                        href={BOOKING_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-press mt-6 rounded-lg border border-stone-300 px-4 py-2.5 text-center text-sm font-semibold text-stone-800 hover:bg-stone-100"
                      >
                        {c.bookCall}
                      </a>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="mt-8 text-center text-sm text-stone-500">
              {c.startFree}{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Free sample photo")}`}
                className="font-semibold text-orange-600 underline-offset-2 hover:underline"
              >
                {c.heroCta}
              </a>
            </p>

            {/* Guarantee */}
            <div className="mx-auto mt-12 max-w-2xl rounded-2xl border border-orange-200 bg-orange-50 p-6 text-center text-orange-950">
              <p className="text-base font-semibold">{c.guaranteeTitle}</p>
              <p className="mt-2 text-sm [text-wrap:pretty] leading-relaxed">{c.guaranteeBody}</p>
            </div>
          </div>
        </section>

        {/* Contact */}
        <section id="contact" className="border-t border-stone-800 bg-stone-900">
          <div className="mx-auto max-w-3xl px-6 py-24 text-center lg:px-8 lg:py-28">
            <h2 className="text-3xl font-bold [text-wrap:balance] tracking-tight text-white sm:text-4xl">{c.contactTitle}</h2>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="mt-8 inline-block text-xl font-semibold text-orange-300 underline-offset-4 transition-colors hover:text-orange-200 hover:underline sm:text-2xl"
            >
              {CONTACT_EMAIL}
            </a>
            {BOOKING_URL && (
              <div className="mt-6">
                <a href={BOOKING_URL} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-stone-300 underline-offset-4 hover:text-white hover:underline">
                  {c.bookCall} →
                </a>
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="border-t border-stone-800 bg-stone-950">
        <div className="mx-auto max-w-7xl px-6 py-10 text-center lg:px-8">
          <p className="text-sm font-medium text-stone-400">© 2026 Clickworthy</p>
          <p className="mt-1 text-xs text-stone-600">{c.footer}</p>
        </div>
      </footer>
    </div>
  );
}
