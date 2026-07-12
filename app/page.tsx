import Header from "./components/Header";

const CONTACT_EMAIL = "contact@clickworthytool.com";

function CameraIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function FoodPlate({ enhanced }: { enhanced?: boolean }) {
  const plate = enhanced ? "#FFFBF5" : "#D8D3C9";
  const rim = enhanced ? "#F0E4D3" : "#B8B2A6";
  const sauceShadow = enhanced ? "#B33A1C" : "#71685C";
  const sauce = enhanced ? "#D94A26" : "#8A7A6A";
  const noodle = enhanced ? "#F2B84B" : "#A79C87";
  const basil = enhanced ? "#4C7A3B" : "#847E6E";
  const tomato = enhanced ? "#E4432B" : "#9A8B7A";

  return (
    <svg
      viewBox="0 0 240 240"
      preserveAspectRatio="xMidYMid slice"
      className="h-full w-full"
    >
      <rect width="240" height="240" fill={plate} />
      <circle cx="120" cy="120" r="108" fill={plate} stroke={rim} strokeWidth="3" />
      <ellipse cx="120" cy="130" rx="78" ry="60" fill={sauceShadow} opacity="0.5" />
      <ellipse cx="120" cy="124" rx="76" ry="56" fill={sauce} />
      <path
        d="M60 110 Q100 90 140 110 T220 105"
        stroke={noodle}
        strokeWidth="9"
        fill="none"
        strokeLinecap="round"
        opacity="0.85"
      />
      <path
        d="M55 135 Q100 150 145 130 T215 140"
        stroke={noodle}
        strokeWidth="9"
        fill="none"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M65 155 Q105 170 150 152"
        stroke={noodle}
        strokeWidth="8"
        fill="none"
        strokeLinecap="round"
        opacity="0.6"
      />
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

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2.5 13.9 8.3a2.4 2.4 0 0 0 1.545 1.545L21.5 11.75l-6.055 1.905A2.4 2.4 0 0 0 13.9 15.2L12 21l-1.9-5.8a2.4 2.4 0 0 0-1.545-1.545L2.5 11.75l6.055-1.905A2.4 2.4 0 0 0 10.1 8.3Z" />
    </svg>
  );
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 17" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

const steps = [
  {
    number: "01",
    icon: CameraIcon,
    title: "We find your listing photos",
    description:
      "We locate the photos your restaurant already has live on Google Maps and other listing platforms.",
  },
  {
    number: "02",
    icon: SparkleIcon,
    title: "We enhance them with AI",
    description:
      "Our AI improves lighting, sharpness, color, and composition on your existing food, menu, and interior photos.",
  },
  {
    number: "03",
    icon: CheckCircleIcon,
    title: "You approve and download",
    description:
      "Review every enhanced photo, approve the ones you love, and download your upgraded set.",
  },
];

const pricingFeatures = [
  "Full photo package enhancement",
  "One-time payment",
];

export default function Home() {
  return (
    <div className="flex min-h-full flex-col bg-stone-50 text-stone-900">
      <Header />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-16 px-6 py-24 sm:py-28 lg:grid-cols-2 lg:gap-12 lg:px-8 lg:py-36">
            <div>
              <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange-700">
                <SparkleIcon className="h-3.5 w-3.5" />
                AI photo enhancement
              </p>
              <h1 className="text-4xl font-bold [text-wrap:balance] text-stone-900 [letter-spacing:-0.02em] sm:text-5xl lg:text-6xl lg:[letter-spacing:-0.03em]">
                AI-Powered Photo Enhancement for Restaurants
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-stone-600">
                We identify restaurants with underperforming photos on Google
                Maps and other listing platforms, and enhance them using AI to
                help attract more customers online — improving lighting,
                sharpness, color, and composition on existing food, menu, and
                interior photos.
              </p>
              <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center">
                <a
                  href="#pricing"
                  className="btn-press group inline-flex items-center justify-center gap-2 rounded-lg bg-orange-600 px-6 py-3.5 text-base font-semibold text-white shadow-sm hover:bg-orange-700"
                >
                  Get Started
                  <ArrowRightIcon className="h-4 w-4 transition-transform duration-200 ease-[var(--ease-snappy)] group-hover:translate-x-0.5" />
                </a>
                <a
                  href="#how-it-works"
                  className="btn-press inline-flex items-center justify-center gap-2 rounded-lg border border-stone-300 bg-white px-6 py-3.5 text-base font-semibold text-stone-800 hover:border-stone-400 hover:bg-stone-100"
                >
                  See how it works
                </a>
              </div>
            </div>

            {/* Abstract before/after graphic */}
            <div className="relative mx-auto aspect-square w-full max-w-md lg:mx-0">
              <div className="absolute -top-8 right-0 h-64 w-64 rounded-full bg-orange-300/40 blur-3xl" />
              <div className="absolute -bottom-8 left-0 h-56 w-56 rounded-full bg-red-300/30 blur-3xl" />

              <div className="absolute left-2 top-12 h-64 w-48 -rotate-6 overflow-hidden rounded-2xl shadow-xl ring-1 ring-black/5 sm:h-72 sm:w-56">
                <FoodPlate />
                <div className="absolute bottom-4 left-4 rounded-full bg-white/80 px-3 py-1 text-xs font-semibold text-stone-600 shadow-sm">
                  Before
                </div>
              </div>

              <div className="absolute right-2 top-2 h-64 w-48 rotate-3 overflow-hidden rounded-2xl shadow-2xl ring-1 ring-black/5 sm:h-72 sm:w-56">
                <FoodPlate enhanced />
                <div className="absolute -right-3 -top-3 flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-lg">
                  <SparkleIcon className="h-5 w-5 text-orange-600" />
                </div>
                <div className="absolute bottom-4 left-4 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-stone-800 shadow-sm">
                  AI Enhanced
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="border-t border-stone-200 bg-white">
          <div className="mx-auto max-w-7xl px-6 py-24 lg:px-8 lg:py-32">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-bold tracking-tight text-stone-900 sm:text-4xl">
                How it works
              </h2>
              <p className="mt-4 text-lg text-stone-600">
                Three simple steps from underperforming listing photos to a
                gallery that actually gets clicks.
              </p>
            </div>
            <div className="mt-16 grid grid-cols-1 gap-8 md:grid-cols-3">
              {steps.map((step) => (
                <div
                  key={step.number}
                  className="rounded-xl border border-stone-200 bg-white p-8 shadow-sm transition-shadow hover:shadow-md"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-50 text-orange-600">
                      <step.icon className="h-6 w-6" />
                    </div>
                    <span className="text-sm font-semibold text-stone-300">
                      {step.number}
                    </span>
                  </div>
                  <h3 className="mt-6 text-lg font-semibold text-stone-900">
                    {step.title}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-stone-600">
                    {step.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="border-t border-stone-200 bg-stone-50">
          <div className="mx-auto max-w-7xl px-6 py-24 lg:px-8 lg:py-32">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-bold tracking-tight text-stone-900 sm:text-4xl">
                Simple, transparent pricing
              </h2>
              <p className="mt-4 text-lg text-stone-600">
                No subscriptions, no surprises — pay once and get your photos
                enhanced.
              </p>
            </div>

            <div className="mx-auto mt-16 max-w-sm">
              <div className="rounded-2xl border border-stone-200 bg-white p-10 text-center shadow-xl">
                <p className="text-xs font-semibold uppercase tracking-wide text-orange-600">
                  Full Photo Package
                </p>
                <div className="mt-4 flex items-baseline justify-center gap-2">
                  <span className="text-5xl font-bold tracking-tight text-stone-900">
                    $49
                  </span>
                </div>
                <p className="mt-2 text-sm text-stone-500">
                  Full photo package enhancement
                </p>

                <ul className="mt-8 space-y-3 text-left">
                  {pricingFeatures.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                      <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-orange-50 text-orange-600">
                        <CheckIcon className="h-3 w-3" />
                      </span>
                      <span className="text-sm text-stone-700">{feature}</span>
                    </li>
                  ))}
                </ul>

                <a
                  href={`mailto:${CONTACT_EMAIL}?subject=Get%20Started%20with%20Clickworthy`}
                  className="btn-press mt-10 block w-full rounded-lg bg-orange-600 px-6 py-3.5 text-center text-base font-semibold text-white shadow-sm hover:bg-orange-700"
                >
                  Get Started
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Contact */}
        <section id="contact" className="border-t border-stone-800 bg-stone-900">
          <div className="mx-auto max-w-3xl px-6 py-24 text-center lg:px-8 lg:py-28">
            <p className="text-xs font-semibold uppercase tracking-wide text-orange-400">
              Get in touch
            </p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Questions? Reach out anytime.
            </h2>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="mt-8 inline-block text-xl font-semibold text-orange-300 underline-offset-4 transition-colors hover:text-orange-200 hover:underline sm:text-2xl"
            >
              {CONTACT_EMAIL}
            </a>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-stone-800 bg-stone-950">
        <div className="mx-auto max-w-7xl px-6 py-10 text-center lg:px-8">
          <p className="text-sm font-medium text-stone-400">
            © 2026 Clickworthy
          </p>
          <p className="mt-1 text-xs text-stone-600">
            AI-powered photo enhancement for restaurants.
          </p>
        </div>
      </footer>
    </div>
  );
}
