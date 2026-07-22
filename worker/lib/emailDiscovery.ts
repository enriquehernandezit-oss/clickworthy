// Email discovery for a restaurant given its website URL.
//
// Google Places does NOT return email addresses (verified — it only has phone +
// website), so the outreach funnel would have no one to email without this
// step. We fetch the site's homepage plus likely contact/about pages, regex out
// candidate addresses, rank them (prefer a real contact mailbox on the site's
// own domain), then the caller verifies the winner with NeverBounce.
//
// Deterministic + free by design (no per-restaurant LLM call) to keep the
// 200–1,500/mo sourcing cost near zero. Restaurants with no discoverable email
// get flagged for manual research instead of dropped.

const FETCH_TIMEOUT_MS = 8000;
const CONTACT_PATH_HINTS = ["contact", "contacto", "about", "nosotros", "reservations", "reservas"];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Junk/placeholder addresses that show up in page source but aren't contacts.
const JUNK_PATTERNS = [
  "example.com",
  "sentry",
  "wixpress",
  "wix.com",
  "squarespace",
  "godaddy",
  "@2x",
  "@3x",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  "your-email",
  "email@",
  "name@",
  "domain.com",
];

// Preferred local-parts for a business contact mailbox, best first.
const PREFERRED_LOCALPARTS = ["info", "contact", "contacto", "hello", "hola", "reservations", "reservas", "admin"];

export type DiscoveredEmail = {
  email: string;
  rank: number; // 1 (best) .. 4 (weak); lower is better
};

async function fetchText(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ClickworthyBot/1.0)" },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractEmails(html: string): string[] {
  const found = new Set<string>();
  for (const raw of html.match(EMAIL_RE) ?? []) {
    const email = raw.toLowerCase();
    if (JUNK_PATTERNS.some((j) => email.includes(j))) continue;
    found.add(email);
  }
  return [...found];
}

function siteDomain(websiteUrl: string): string | null {
  try {
    return new URL(websiteUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

// Ranks a single email against the site domain. 1 = preferred mailbox on the
// site's domain; 2 = any address on the site's domain; 3 = preferred mailbox
// on another domain (e.g. a gmail contact); 4 = anything else.
function rankEmail(email: string, domain: string | null): number {
  const [localPart, emailDomain] = email.split("@");
  const onSiteDomain = domain != null && emailDomain === domain;
  const preferred = PREFERRED_LOCALPARTS.includes(localPart);
  if (onSiteDomain && preferred) return 1;
  if (onSiteDomain) return 2;
  if (preferred) return 3;
  return 4;
}

// Finds candidate contact links on the homepage to also crawl.
function contactLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  for (const m of html.matchAll(hrefRe)) {
    const href = m[1];
    if (!CONTACT_PATH_HINTS.some((h) => href.toLowerCase().includes(h))) continue;
    try {
      links.add(new URL(href, baseUrl).toString());
    } catch {
      // ignore malformed hrefs
    }
  }
  return [...links].slice(0, 3);
}

export async function discoverEmail(websiteUrl: string): Promise<DiscoveredEmail | null> {
  const domain = siteDomain(websiteUrl);
  const candidates = new Map<string, number>(); // email -> best rank seen

  const consider = (html: string) => {
    for (const email of extractEmails(html)) {
      const rank = rankEmail(email, domain);
      const prev = candidates.get(email);
      if (prev === undefined || rank < prev) candidates.set(email, rank);
    }
  };

  const home = await fetchText(websiteUrl);
  if (home) {
    consider(home);
    // Crawl a couple of contact/about pages for addresses not on the homepage.
    for (const link of contactLinks(home, websiteUrl)) {
      const page = await fetchText(link);
      if (page) consider(page);
    }
  }

  if (candidates.size === 0) return null;

  // Best = lowest rank, tie-broken by shorter local part (usually the generic mailbox).
  const best = [...candidates.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[0].length - b[0].length;
  })[0];

  return { email: best[0], rank: best[1] };
}
