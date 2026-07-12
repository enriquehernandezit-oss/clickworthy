import Link from "next/link";

const CONTACT_EMAIL = "contact@clickworthytool.com";

// Shared across every route so the brand/nav stay identical everywhere.
// Nav links point at the landing page's anchors (via "/#...") so they work
// correctly from routes other than "/", like /enhance.
export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-stone-200/80 bg-stone-50/80 backdrop-blur-md backdrop-saturate-150">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 lg:px-8">
        <Link href="/" className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-sm bg-gradient-to-br from-orange-500 to-red-600" />
          <span className="text-lg font-bold tracking-tight text-stone-900">
            Clickworthy
          </span>
        </Link>
        <nav className="hidden items-center gap-8 text-sm font-medium text-stone-600 md:flex">
          <Link href="/#how-it-works" className="transition-colors hover:text-stone-900">
            How it works
          </Link>
          <Link href="/#pricing" className="transition-colors hover:text-stone-900">
            Pricing
          </Link>
          <Link href="/#contact" className="transition-colors hover:text-stone-900">
            Contact
          </Link>
        </nav>
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className="btn-press rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-stone-800"
        >
          Get Started
        </a>
      </div>
    </header>
  );
}
