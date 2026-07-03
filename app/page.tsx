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
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-stone-200/80 bg-stone-50/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 lg:px-8">
          <a href="#" className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-sm bg-gradient-to-br from-orange-500 to-red-600" />
            <span className="text-lg font-bold tracking-tight text-stone-900">
              Clickworthy
            </span>
          </a>
          <nav className="hidden items-center gap-8 text-sm font-medium text-stone-600 md:flex">
            <a href="#how-it-works" className="transition-colors hover:text-stone-900">
              How it works
            </a>
            <a href="#pricing" className="transition-colors hover:text-stone-900">
              Pricing
            </a>
            <a href="#contact" className="transition-colors hover:text-stone-900">
              Contact
            </a>
          </nav>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-stone-800"
          >
            Get Started
          </a>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-16 px-6 py-24 sm:py-28 lg:grid-cols-2 lg:gap-12 lg:px-8 lg:py-36">
            <div>
              <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange-700">
                <SparkleIcon className="h-3.5 w-3.5" />
                AI photo enhancement
              </p>
              <h1 className="text-4xl font-bold tracking-tight text-stone-900 sm:text-5xl lg:text-6xl">
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
                  className="group inline-flex items-center justify-center gap-2 rounded-lg bg-orange-600 px-6 py-3.5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-orange-700"
                >
                  Get Started
                  <ArrowRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </a>
                <a
                  href="#how-it-works"
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-stone-300 bg-white px-6 py-3.5 text-base font-semibold text-stone-800 transition-colors hover:border-stone-400 hover:bg-stone-100"
                >
                  See how it works
                </a>
              </div>
            </div>

            {/* Abstract before/after graphic */}
            <div className="relative mx-auto aspect-square w-full max-w-md lg:mx-0">
              <div className="absolute -top-8 right-0 h-64 w-64 rounded-full bg-orange-300/40 blur-3xl" />
              <div className="absolute -bottom-8 left-0 h-56 w-56 rounded-full bg-red-300/30 blur-3xl" />

              <div className="absolute left-2 top-12 h-64 w-48 -rotate-6 rounded-2xl bg-gradient-to-br from-stone-300 to-stone-400 shadow-xl ring-1 ring-black/5 sm:h-72 sm:w-56">
                <div className="absolute bottom-4 left-4 rounded-full bg-white/80 px-3 py-1 text-xs font-semibold text-stone-600 shadow-sm">
                  Before
                </div>
              </div>

              <div className="absolute right-2 top-2 h-64 w-48 rotate-3 rounded-2xl bg-gradient-to-br from-amber-300 via-orange-400 to-red-500 shadow-2xl ring-1 ring-black/5 sm:h-72 sm:w-56">
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
                  className="mt-10 block w-full rounded-lg bg-orange-600 px-6 py-3.5 text-center text-base font-semibold text-white shadow-sm transition-colors hover:bg-orange-700"
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
