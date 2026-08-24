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
//
// v2 (Aug 2026) — measured: only ~28% of leads WITH a website yielded an email,
// because a plain text-regex misses where restaurants actually put the address.
// Four extractors now run over the same HTML, all free:
//   1. Cloudflare email-protection (`data-cfemail`) — very common, was 100% invisible
//   2. mailto: hrefs — caught even when the visible label is "Email us"
//   3. JSON-LD (schema.org Restaurant/LocalBusiness `email`)
//   4. meta tags (og:email etc.)
// Plus a DOMAIN-WHITELIST guard: a live run scraped `team@latofonts.com` off a
// restaurant's CSS and NeverBounce confirmed it (it's the font foundry's real
// mailbox). An address on an unrelated domain belongs to a vendor, not the
// restaurant — see isAcceptableDomain().

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

// Mailboxes that exist on a restaurant's site but are the WRONG audience for a
// cold owner pitch — a donations/careers/press/no-reply inbox never reaches the
// decision-maker, and emailing it burns a send (and can hurt reputation) for a
// guaranteed non-answer. Matched on the exact LOCAL PART (not a substring of the
// whole address) so a domain like "jobsteakhouse.com" isn't caught by "jobs".
// Deliberately NOT here: reservations / catering — at an independent those often
// forward straight to the owner, so they stay eligible.
const JUNK_LOCALPARTS = new Set([
  "donations", "donate", "careers", "career", "jobs", "job", "recruiting", "recruitment",
  "hr", "press", "media", "newsletter", "marketing", "noreply", "no-reply", "donotreply",
  "do-not-reply", "unsubscribe", "mailer-daemon", "postmaster", "webmaster", "abuse",
  "privacy", "legal", "compliance", "billing", "accounts", "accounting", "invoices",
]);

// Consumer mailbox hosts. A restaurant legitimately using gmail/yahoo is
// common at the small end, so these stay eligible even though they don't match
// the site domain.
const FREE_MAILBOX_HOSTS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "protonmail.com",
  "proton.me", "gmx.com", "mail.com", "comcast.net", "sbcglobal.net", "att.net", "verizon.net",
  "bellsouth.net", "cox.net", "earthlink.net", "yahoo.es", "hotmail.es", "outlook.es",
]);

// Hosts that are somebody's PLATFORM, not a restaurant's own domain. Guessing
// info@<one of these> is meaningless, so the guess fallback skips them.
const NON_OWNED_HOSTS = [
  "wixsite.com", "wix.com", "squarespace.com", "weebly.com", "godaddysites.com", "business.site",
  "wordpress.com", "blogspot.com", "myshopify.com", "square.site", "clover.com", "toasttab.com",
  "chownow.com", "beyondmenu.com", "menufy.com", "slicelife.com", "orderonline.app", "linktr.ee",
  "facebook.com", "instagram.com", "yelp.com", "tripadvisor.com", "doordash.com", "ubereats.com",
  "grubhub.com", "opentable.com", "resy.com", "spotapps.co", "popmenu.com", "getbento.com",
  // restaurant listing / online-menu platforms — Places sometimes lists these AS
  // the restaurant's website, but their mailbox is the platform's, not the owner's
  "findaloco.com", "bentobox.com", "owner.com", "menusifu.com", "hungerrush.com",
  "restaurantji.com", "singleplatform.com", "zmenu.com", "allmenus.com", "seamless.com",
  // white-label online-ordering hosts caught live 2026-08-23: Places listed
  // qmenu.us and per-restaurant *.mobile-webviewN.com ordering pages as the
  // restaurant's website, so the guess fallback burned 3 NeverBounce checks on
  // addresses like info@ordertaqueriamorelia.mobile-webview4.com — mailboxes
  // that can't exist. The numbered-shard family is matched by pattern below.
  "qmenu.us",
];

// Platform families whose hostnames shard per customer (mobile-webview2.com,
// mobile-webview4.com, …) — a static list can't enumerate them, so they're
// matched by shape. Keep patterns tight: a false positive here silently turns
// off email guessing for a legitimately-owned domain.
const NON_OWNED_HOST_PATTERNS: RegExp[] = [
  /(^|\.)mobile-webview\d*\.com$/,
];

export function isNonOwnedHost(host: string): boolean {
  if (NON_OWNED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  return NON_OWNED_HOST_PATTERNS.some((re) => re.test(host));
}

// The registrable label of a hostname, minus the TLD ("joesdiner.com" -> "joesdiner").
function rootLabel(host: string): string {
  const parts = host.split(".").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : host;
}

// Is this address plausibly the RESTAURANT's, rather than a vendor's?
// Accept: same domain as the site · a consumer mailbox host · a clearly related
// domain (joesdiner.com vs joesdinergroup.com). Reject everything else — that's
// how a font foundry / agency / analytics address gets in (the latofonts bug).
export function isAcceptableDomain(emailDomain: string, siteDomain: string | null): boolean {
  // A platform mailbox (hello@findaloco.com, info@toasttab.com) reaches the
  // PLATFORM, not the restaurant — reject even when Places lists that platform
  // as the restaurant's website.
  if (isNonOwnedHost(emailDomain)) return false;
  if (FREE_MAILBOX_HOSTS.has(emailDomain)) return true;
  if (!siteDomain) return false; // no site to compare against: only free hosts are safe
  if (emailDomain === siteDomain) return true;
  const a = rootLabel(emailDomain);
  const b = rootLabel(siteDomain);
  if (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

export type DiscoveredEmail = {
  email: string;
  rank: number; // 1 (best) .. 4 (weak); lower is better
};

// Exported so enrichment can fetch the homepage ONCE and hand the HTML to both
// this module (discoverEmail) and the photo-fit gates — the same page drives
// email extraction and the website-photo assessment, so it shouldn't be fetched
// twice.
export async function fetchHomepageHtml(url: string): Promise<string | null> {
  return fetchText(url);
}

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

// --- Extractor 1: Cloudflare email protection ---------------------------
// Cloudflare rewrites addresses to <a class="__cf_email__" data-cfemail="HEX">.
// The first hex byte is an XOR key for the remaining bytes. Restaurants on
// Cloudflare (very common) were previously undiscoverable.
export function decodeCfEmail(encoded: string): string | null {
  if (!/^[0-9a-f]{6,}$/i.test(encoded) || encoded.length % 2 !== 0) return null;
  const key = parseInt(encoded.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < encoded.length; i += 2) {
    const code = parseInt(encoded.slice(i, i + 2), 16) ^ key;
    if (code < 32 || code > 126) return null; // not printable ASCII -> not an address
    out += String.fromCharCode(code);
  }
  return out.includes("@") ? out : null;
}

export function extractCfEmails(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/data-cfemail\s*=\s*["']([0-9a-fA-F]+)["']/g)) {
    const decoded = decodeCfEmail(m[1]);
    if (decoded) out.push(decoded);
  }
  // Cloudflare also uses /cdn-cgi/l/email-protection#HEX on hrefs.
  for (const m of html.matchAll(/email-protection#([0-9a-fA-F]+)/g)) {
    const decoded = decodeCfEmail(m[1]);
    if (decoded) out.push(decoded);
  }
  return out;
}

// --- Extractor 2: mailto: hrefs -----------------------------------------
// Caught explicitly so a link labelled "Email us" (no visible address) works.
export function extractMailtoEmails(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*["']\s*mailto:([^"'?\s>]+)/gi)) {
    const decoded = decodeURIComponent(m[1].trim());
    if (decoded.includes("@")) out.push(decoded);
  }
  return out;
}

// --- Extractor 3: JSON-LD ------------------------------------------------
// schema.org Restaurant / LocalBusiness blocks often carry `email` outright.
// Walks nested objects/arrays (incl. @graph). Malformed JSON is common — never throw.
export function extractJsonLdEmails(html: string): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k.toLowerCase() === "email" && typeof v === "string" && v.includes("@")) {
          out.push(v.replace(/^mailto:/i, "").trim());
        } else {
          walk(v);
        }
      }
    }
  };
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch {
      // malformed JSON-LD is normal; skip this block
    }
  }
  return out;
}

// --- Extractor 4: meta tags ---------------------------------------------
export function extractMetaEmails(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(
    /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:email|email|contact:email|business:contact_data:email)["'][^>]*content\s*=\s*["']([^"']+)["']/gi
  )) {
    if (m[1].includes("@")) out.push(m[1].trim());
  }
  return out;
}

// Strips the parts of a page that contain MACHINE text rather than contact
// info: <style> (font/theme license attributions — this is where
// impallari@gmail.com, the Lato font designer, was being scraped from),
// non-JSON-LD <script>, and HTML comments. JSON-LD is preserved because
// extractJsonLdEmails runs on the untouched HTML separately.
export function stripNonContentBlocks(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script(?![^>]*application\/ld\+json)[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function extractEmails(html: string): string[] {
  const found = new Set<string>();
  const raws = [
    ...(stripNonContentBlocks(html).match(EMAIL_RE) ?? []), // plain text, minus CSS/JS/comments
    ...extractCfEmails(html),          // Cloudflare-obfuscated
    ...extractMailtoEmails(html),      // mailto: hrefs
    ...extractJsonLdEmails(html),      // schema.org
    ...extractMetaEmails(html),        // meta tags
  ];
  for (const raw of raws) {
    const email = raw.toLowerCase().trim();
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) continue;
    if (JUNK_PATTERNS.some((j) => email.includes(j))) continue;
    if (JUNK_LOCALPARTS.has(email.split("@")[0])) continue; // wrong-audience mailbox (donations@, careers@, …)
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

// `homepageHtml`: pass the already-fetched homepage HTML to skip re-downloading
// it (enrichment fetches it once for the photo gates). `undefined` = fetch it
// here; `null` = caller fetched and got nothing (skip — don't retry).
export async function discoverEmail(
  websiteUrl: string,
  homepageHtml?: string | null
): Promise<DiscoveredEmail | null> {
  const domain = siteDomain(websiteUrl);
  const candidates = new Map<string, number>(); // email -> best rank seen

  const consider = (html: string) => {
    for (const email of extractEmails(html)) {
      // Vendor guard: an address on an unrelated domain (font foundry, agency,
      // analytics) is not the restaurant's. This is what stopped the pipeline
      // from emailing team@latofonts.com.
      if (!isAcceptableDomain(email.split("@")[1] ?? "", domain)) continue;
      const rank = rankEmail(email, domain);
      const prev = candidates.get(email);
      if (prev === undefined || rank < prev) candidates.set(email, rank);
    }
  };

  const home = homepageHtml === undefined ? await fetchText(websiteUrl) : homepageHtml;
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

// --- Verified-guess fallback --------------------------------------------
// Last resort when all four extractors come up empty on a site that clearly
// belongs to the restaurant. Generates the standard business mailboxes on the
// site's OWN domain, best first. These are only ever CANDIDATES — the caller
// must confirm each with NeverBounce before use, so the deliverability bar is
// identical to a scraped address (see runEnrichment).
//
// Returns [] when guessing is pointless: no parseable domain, or the site lives
// on someone else's platform (wixsite/facebook/toasttab/…), where info@<host>
// would be the platform's mailbox, not the restaurant's.
const GUESS_LOCALPARTS = ["info", "contact", "hello"] as const;

export function guessEmailCandidates(websiteUrl: string): string[] {
  const domain = siteDomain(websiteUrl);
  if (!domain) return [];
  if (FREE_MAILBOX_HOSTS.has(domain)) return [];
  if (isNonOwnedHost(domain)) return [];
  return GUESS_LOCALPARTS.map((lp) => `${lp}@${domain}`);
}
