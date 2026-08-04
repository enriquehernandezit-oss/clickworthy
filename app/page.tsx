"use client";

import { useState } from "react";
import Link from "next/link";
import Header from "./components/Header";
import { pricePerPhotoCents, totalPriceCents, formatCents } from "@/lib/pricing";

const CONTACT_EMAIL = "contact@clickworthytool.com";

// Everything price-facing is derived from lib/pricing.ts — the same module the
// checkout route prices against — so the landing can never quote a number the
// customer isn't actually charged.
const STEP_CENTS = pricePerPhotoCents(1) - pricePerPhotoCents(2);
// First quantity where the per-photo price bottoms out (the "N+" tier).
const FLOOR_QTY = (() => {
  const floor = pricePerPhotoCents(Number.MAX_SAFE_INTEGER);
  for (let q = 1; q < 100; q++) if (pricePerPhotoCents(q) === floor) return q;
  return 1;
})();
const TIER_QUANTITIES = [1, 5, 10, FLOOR_QTY];
const CALC_MAX = 30;

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
    heroTitle: "Your menu photos, professionally enhanced.",
    heroSub:
      "Upload the photos you already have — even phone shots. We enhance your real dishes so your own website, Google profile, and Instagram finally look better than your delivery listing.",
    heroCta: "Enhance my photos",
    heroNote: (from: string) => `From ${from} a photo. No subscription, no minimum — you pay once for exactly what you upload.`,
    before: "Before",
    after: "After",
    howTitle: "How it works",
    howSub: "Upload today, get them back ready to post.",
    how: [
      { t: "Upload your dish photos", d: "Any photo you already have — a phone shot works. Add as many dishes as you like." },
      { t: "Pay per photo", d: "The more photos you add, the less each one costs. You see the exact total before you pay a cent." },
      { t: "Get them back, ready to post", d: "Your real dishes, enhanced and ready for your website, Google Business Profile, Instagram, and Yelp." },
    ],
    priceTitle: "Simple per-photo pricing",
    priceSub: (base: string, step: string, floor: string) =>
      `Starts at ${base} a photo and drops ${step} with every photo you add, down to ${floor}. No packages, no contracts.`,
    perPhoto: "per photo",
    onePhoto: "1 photo",
    nPhotos: (n: number) => `${n} photos`,
    nPlusPhotos: (n: number) => `${n}+ photos`,
    bestValue: "Best value",
    calcTitle: "What would yours cost?",
    calcLabel: "Number of photos",
    calcTotal: "Total",
    calcCta: (n: number) => `Enhance ${n} ${n === 1 ? "photo" : "photos"}`,
    guaranteeTitle: "Not happy? You don't pay.",
    guaranteeBody:
      "If the enhanced photos don't beat what you have now, email us and we'll refund you. Your real dishes — same food, same plate, never invented.",
    contactTitle: "Questions? Reach out anytime.",
    footer: "Real restaurant photos, professionally enhanced.",
  },
  es: {
    switchTo: "EN",
    heroBadge: "Para restaurantes independientes",
    heroTitle: "Las fotos de su menú, mejoradas profesionalmente.",
    heroSub:
      "Suba las fotos que ya tiene — aunque sean del celular. Mejoramos sus platos reales para que su propio sitio web, perfil de Google e Instagram por fin se vean mejor que su listado de delivery.",
    heroCta: "Mejorar mis fotos",
    heroNote: (from: string) => `Desde ${from} por foto. Sin suscripción, sin mínimo — paga una sola vez por lo que suba.`,
    before: "Antes",
    after: "Después",
    howTitle: "Cómo funciona",
    howSub: "Suba sus fotos hoy y recíbalas listas para publicar.",
    how: [
      { t: "Suba las fotos de sus platos", d: "Cualquier foto que ya tenga — una del celular sirve. Agregue todos los platos que quiera." },
      { t: "Pague por foto", d: "Mientras más fotos agregue, menos cuesta cada una. Ve el total exacto antes de pagar." },
      { t: "Recíbalas listas para publicar", d: "Sus platos reales, mejorados y listos para su sitio web, Google Business Profile, Instagram y Yelp." },
    ],
    priceTitle: "Precio simple, por foto",
    priceSub: (base: string, step: string, floor: string) =>
      `Empieza en ${base} por foto y baja ${step} con cada foto que agregue, hasta ${floor}. Sin paquetes, sin contratos.`,
    perPhoto: "por foto",
    onePhoto: "1 foto",
    nPhotos: (n: number) => `${n} fotos`,
    nPlusPhotos: (n: number) => `${n}+ fotos`,
    bestValue: "Mejor precio",
    calcTitle: "¿Cuánto le costaría?",
    calcLabel: "Cantidad de fotos",
    calcTotal: "Total",
    calcCta: (n: number) => `Mejorar ${n} ${n === 1 ? "foto" : "fotos"}`,
    guaranteeTitle: "¿No le gusta? No paga.",
    guaranteeBody:
      "Si las fotos mejoradas no superan lo que tiene ahora, escríbanos y le devolvemos su dinero. Sus platos reales — la misma comida, el mismo plato, nada inventado.",
    contactTitle: "¿Preguntas? Escríbanos cuando quiera.",
    footer: "Fotos reales de restaurantes, mejoradas profesionalmente.",
  },
} as const;

export default function Home() {
  const [lang, setLang] = useState<Lang>("en");
  const [qty, setQty] = useState(10);
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
                <Link
                  href="/enhance"
                  className="btn-press inline-flex items-center justify-center rounded-lg bg-orange-600 px-6 py-3.5 text-base font-semibold text-white shadow-sm hover:bg-orange-700 sm:self-start"
                >
                  {c.heroCta}
                </Link>
                <p className="text-sm text-stone-500">
                  {c.heroNote(formatCents(pricePerPhotoCents(FLOOR_QTY)))}
                </p>
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

        {/* Pricing */}
        <section id="pricing" className="border-t border-stone-200 bg-stone-50">
          <div className="mx-auto max-w-7xl px-6 py-24 lg:px-8 lg:py-28">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-bold [text-wrap:balance] tracking-tight sm:text-4xl">{c.priceTitle}</h2>
              <p className="mt-4 text-lg [text-wrap:pretty] text-stone-600">
                {c.priceSub(
                  formatCents(pricePerPhotoCents(1)),
                  formatCents(STEP_CENTS),
                  formatCents(pricePerPhotoCents(FLOOR_QTY))
                )}
              </p>
            </div>

            {/* Sliding-scale tiers */}
            <div className="mt-14 grid grid-cols-2 gap-4 md:grid-cols-4 md:gap-6">
              {TIER_QUANTITIES.map((q, i) => {
                const best = i === TIER_QUANTITIES.length - 1;
                return (
                  <div
                    key={q}
                    className={`flex flex-col rounded-2xl border bg-white p-6 shadow-sm ${
                      best ? "border-orange-300 ring-1 ring-orange-200" : "border-stone-200"
                    }`}
                  >
                    {best && (
                      <span className="mb-2 inline-block self-start rounded-full bg-orange-100 px-2.5 py-0.5 text-xs font-semibold text-orange-700">
                        {c.bestValue}
                      </span>
                    )}
                    <div className="text-sm font-semibold text-stone-600">
                      {q === 1 ? c.onePhoto : best ? c.nPlusPhotos(q) : c.nPhotos(q)}
                    </div>
                    <div className="mt-2 text-3xl font-bold tracking-tight tabular-nums">
                      {formatCents(pricePerPhotoCents(q))}
                    </div>
                    <div className="mt-1 text-sm text-stone-500">{c.perPhoto}</div>
                  </div>
                );
              })}
            </div>

            {/* Live calculator */}
            <div className="mx-auto mt-12 max-w-2xl rounded-2xl border border-stone-200 bg-white p-7 shadow-sm">
              <h3 className="text-center text-lg font-semibold">{c.calcTitle}</h3>

              <label htmlFor="qty" className="mt-6 block text-sm font-medium text-stone-600">
                {c.calcLabel}: <span className="font-semibold tabular-nums text-stone-900">{qty}</span>
              </label>
              <input
                id="qty"
                type="range"
                min={1}
                max={CALC_MAX}
                value={qty}
                onChange={(e) => setQty(Number(e.target.value))}
                className="mt-3 w-full accent-orange-600"
              />

              <div className="mt-6 flex items-end justify-between gap-4 border-t border-stone-200 pt-6">
                <div>
                  <div className="text-2xl font-bold tabular-nums">{formatCents(pricePerPhotoCents(qty))}</div>
                  <div className="text-sm text-stone-500">{c.perPhoto}</div>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-bold tracking-tight tabular-nums text-orange-600">
                    {formatCents(totalPriceCents(qty))}
                  </div>
                  <div className="text-sm text-stone-500">{c.calcTotal}</div>
                </div>
              </div>

              <Link
                href="/enhance"
                className="btn-press mt-6 block rounded-lg bg-orange-600 px-6 py-3 text-center text-base font-semibold text-white shadow-sm hover:bg-orange-700"
              >
                {c.calcCta(qty)}
              </Link>
            </div>

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
