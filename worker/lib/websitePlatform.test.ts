// Tests for the website-product qualifier (worker/lib/websitePlatform.ts).
// The motivating case: Raspados Don Manuel sits on a FREE Weebly subdomain but
// scores richness 51 ("unclear"), so the website-leads page — which keyed on
// `sparse` or no-website — never saw it. Run with `bun test`.

import { expect, test, describe } from "bun:test";
import { classifyWebsite, describeWebsiteTier } from "./websitePlatform";

describe("classifyWebsite — free subdomains (never bought a domain)", () => {
  test("the Raspados Don Manuel case", () => {
    const c = classifyWebsite("https://raspadosdonmanuel.weebly.com/");
    expect(c.tier).toBe("free_subdomain");
    expect(c.platform).toBe("Weebly");
    expect(c.isProspect).toBe(true);
  });

  test("other common free hosts", () => {
    for (const [url, platform] of [
      ["https://joesdiner.wixsite.com/home", "Wix"],
      ["https://tacos.business.site/", "Google Business Site"],
      ["https://cafe.godaddysites.com/", "GoDaddy"],
      ["https://shop.square.site/", "Square Online"],
    ] as [string, string][]) {
      const c = classifyWebsite(url);
      expect(c.tier, url).toBe("free_subdomain");
      expect(c.platform, url).toBe(platform);
    }
  });

  test("the provider's OWN root domain is not a restaurant on a free subdomain", () => {
    // weebly.com itself is the company — only *.weebly.com means a hosted site.
    expect(classifyWebsite("https://www.weebly.com/").tier).toBe("custom");
  });
});

describe("classifyWebsite — no real site of their own", () => {
  test("ordering/menu platforms standing in for a website", () => {
    expect(classifyWebsite("https://qmenu.us/#/tacos").tier).toBe("ordering_platform");
    expect(classifyWebsite("https://ordertaqueriamorelia.mobile-webview4.com/").tier).toBe("ordering_platform");
    expect(classifyWebsite("https://www.toasttab.com/local/order/x").platform).toBe("Toast");
  });

  test("a social page listed as the website", () => {
    expect(classifyWebsite("https://www.facebook.com/joesdiner").tier).toBe("social_only");
    expect(classifyWebsite("https://instagram.com/joesdiner").platform).toBe("Instagram");
  });

  test("no website at all is the strongest prospect", () => {
    for (const v of [null, undefined, "", "   "]) {
      const c = classifyWebsite(v);
      expect(c.tier).toBe("none");
      expect(c.isProspect).toBe(true);
    }
  });

  test("a malformed URL never throws", () => {
    expect(classifyWebsite("not a url").tier).toBe("none");
  });
});

describe("classifyWebsite — own domain", () => {
  test("a custom site is NOT a website prospect", () => {
    const c = classifyWebsite("https://joesdiner.com/");
    expect(c.tier).toBe("custom");
    expect(c.isProspect).toBe(false);
  });

  test("a DIY builder on a custom domain is only detectable from the HTML", () => {
    const url = "https://joesdiner.com/";
    expect(classifyWebsite(url).tier).toBe("custom"); // URL alone can't tell
    const c = classifyWebsite(url, `<img src="https://img1.wsimg.com/isteam/x.jpg">`);
    expect(c.tier).toBe("diy_builder");
    expect(c.platform).toBe("GoDaddy");
    expect(c.isProspect).toBe(true);
  });

  test("a custom domain with no builder markers stays custom", () => {
    const c = classifyWebsite("https://joesdiner.com/", `<html><body><h1>Joe's</h1></body></html>`);
    expect(c.tier).toBe("custom");
    expect(c.isProspect).toBe(false);
  });
});

test("describeWebsiteTier covers every tier", () => {
  for (const t of ["none", "free_subdomain", "ordering_platform", "social_only", "diy_builder", "custom"] as const) {
    expect(describeWebsiteTier(t).length).toBeGreaterThan(0);
  }
});
