// Classifies the WEBSITE a restaurant is using — the qualifying signal for the
// future website product (see /admin/photo/website-leads).
//
// Deliberately URL-ONLY: no fetch, no API call, so it can be applied to every
// stored lead for free and backfilled over the whole table instantly. The
// strongest signal needs nothing else — a restaurant on `name.weebly.com` never
// bought a domain, which says more about their web presence than any page
// analysis could.
//
// This is a DIFFERENT question from Gate 1's photo richness
// (worker/lib/websitePhotos.ts), which asks "do they already have professional
// photography?". A site can be photo-rich and still be a website prospect, or
// photo-sparse on a perfectly good custom site. Raspados Don Manuel is the case
// that motivated this: richness 51 ("unclear", so invisible to the website-leads
// page) while sitting on a free Weebly subdomain — a textbook website lead.

export type WebsiteTier =
  | "none" // no website at all — strongest prospect (also the phone call_list)
  | "free_subdomain" // never bought a domain: name.weebly.com, name.wixsite.com …
  | "ordering_platform" // an ordering/menu page standing in for a website
  | "social_only" // a Facebook/Instagram page listed as the website
  | "diy_builder" // own domain, but on a consumer drag-and-drop builder
  | "custom"; // own domain, professionally-built or unrecognized — not a prospect

export type WebsitePlatform = {
  tier: WebsiteTier;
  platform: string | null; // human label, e.g. "Weebly"
  // True when this lead is worth pitching a website to. `custom` is the only
  // tier that isn't (we can't tell that we'd improve on it).
  isProspect: boolean;
};

// host suffix -> label. A URL whose hostname ENDS WITH one of these is on that
// provider's free/shared subdomain, i.e. they never registered a domain.
const FREE_SUBDOMAIN_HOSTS: [string, string][] = [
  ["weebly.com", "Weebly"],
  ["wixsite.com", "Wix"],
  ["editmysite.com", "Weebly"],
  ["business.site", "Google Business Site"],
  ["godaddysites.com", "GoDaddy"],
  ["square.site", "Square Online"],
  ["myshopify.com", "Shopify"],
  ["wordpress.com", "WordPress.com"],
  ["blogspot.com", "Blogspot"],
  ["site123.me", "Site123"],
  ["jimdosite.com", "Jimdo"],
  ["yolasite.com", "Yola"],
  ["webnode.com", "Webnode"],
  ["webs.com", "Webs"],
  ["tripod.com", "Tripod"],
  ["angelfire.com", "Angelfire"],
  ["netlify.app", "Netlify (unconfigured)"],
  ["vercel.app", "Vercel (unconfigured)"],
  ["github.io", "GitHub Pages"],
];

// Ordering/menu platforms Google sometimes returns as the "website". These
// people have no site of their own at all — a strong prospect.
const ORDERING_HOSTS: [string, string][] = [
  ["qmenu.us", "qMenu"],
  ["chownow.com", "ChowNow"],
  ["menufy.com", "Menufy"],
  ["beyondmenu.com", "BeyondMenu"],
  ["slicelife.com", "Slice"],
  ["toasttab.com", "Toast"],
  ["clover.com", "Clover"],
  ["orderonline.app", "Order Online"],
  ["spotapps.co", "SpotHopper"],
  ["popmenu.com", "Popmenu"],
  ["gloriafood.com", "GloriaFood"],
  ["linktr.ee", "Linktree"],
  ["allmenus.com", "AllMenus"],
  ["zmenu.com", "ZMenu"],
  ["singleplatform.com", "SinglePlatform"],
  ["restaurantji.com", "Restaurantji"],
  ["seamless.com", "Seamless"],
  ["doordash.com", "DoorDash"],
  ["ubereats.com", "Uber Eats"],
  ["grubhub.com", "Grubhub"],
];

const SOCIAL_HOSTS: [string, string][] = [
  ["facebook.com", "Facebook"],
  ["instagram.com", "Instagram"],
  ["yelp.com", "Yelp"],
  ["tripadvisor.com", "TripAdvisor"],
];

// Consumer builders on the restaurant's OWN domain. Weaker than a free
// subdomain (they at least bought a domain) but still a DIY site we can beat.
// Squarespace/Wix-on-own-domain are judgement calls: they're capable tools, but
// a restaurant using one usually built it themselves.
const DIY_BUILDER_MARKERS: [string, string][] = [
  ["weebly", "Weebly"],
  ["wixstatic", "Wix"],
  ["wsimg.com", "GoDaddy"],
  ["multiscreensite.com", "Duda"],
  ["cdn-website.com", "Duda"],
];

// Per-customer numbered shards that can't be listed literally.
const ORDERING_PATTERNS: [RegExp, string][] = [[/(^|\.)mobile-webview\d*\.com$/, "Mobile Webview"]];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

const endsWithHost = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

// Classifies from the URL alone. `html` is optional and only used to catch a
// DIY builder serving a custom domain (the markers live in the page, not the
// hostname) — everything else is decided without it.
export function classifyWebsite(url: string | null | undefined, html?: string | null): WebsitePlatform {
  if (!url || !url.trim()) return { tier: "none", platform: null, isProspect: true };

  const host = hostOf(url);
  if (!host) return { tier: "none", platform: null, isProspect: true };

  for (const [suffix, label] of FREE_SUBDOMAIN_HOSTS) {
    // Only a SUBDOMAIN is the "never bought a domain" signal — the provider's
    // own root domain would be the company itself, not a restaurant.
    if (host.endsWith(`.${suffix}`)) return { tier: "free_subdomain", platform: label, isProspect: true };
  }
  for (const [suffix, label] of ORDERING_HOSTS) {
    if (endsWithHost(host, suffix)) return { tier: "ordering_platform", platform: label, isProspect: true };
  }
  for (const [re, label] of ORDERING_PATTERNS) {
    if (re.test(host)) return { tier: "ordering_platform", platform: label, isProspect: true };
  }
  for (const [suffix, label] of SOCIAL_HOSTS) {
    if (endsWithHost(host, suffix)) return { tier: "social_only", platform: label, isProspect: true };
  }

  if (html) {
    const lower = html.toLowerCase();
    for (const [marker, label] of DIY_BUILDER_MARKERS) {
      if (lower.includes(marker)) return { tier: "diy_builder", platform: label, isProspect: true };
    }
  }

  return { tier: "custom", platform: null, isProspect: false };
}

// Short human label for the admin table.
export function describeWebsiteTier(t: WebsiteTier): string {
  switch (t) {
    case "none": return "no website";
    case "free_subdomain": return "free subdomain";
    case "ordering_platform": return "ordering page only";
    case "social_only": return "social page only";
    case "diy_builder": return "DIY builder";
    case "custom": return "own site";
  }
}
