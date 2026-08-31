// Tests for worker/lib/outreachEmail.ts — mainly signatureBlock() and its
// placement in the composed body. Added 2026-08-22 alongside the fix for
// Gmail signatures never appearing on outreach mail (every send goes through
// the Gmail API's messages.send directly, which bypasses the compose-window
// UI entirely — so a signature has to be code-appended, same as the
// CAN-SPAM footer already is). Run with `bun test`.

import { expect, test, describe } from "bun:test";
import {
  composeTouch1,
  composeBump,
  composeTouch2,
  formatPricingBlock,
  signatureBlock,
  complianceFooter,
  hasComplianceFooter,
  isBounceNotification,
  extractBouncedRecipient,
  isOptOut,
  type ComposeIdentity,
} from "./outreachEmail";
import type { Touch1Template, BumpTemplate, Touch2Template } from "@/lib/settings";
import { PACKAGE_ORDER, formatCents, type PackageId, type PackageTier } from "@/lib/packages";

const IDENTITY_NO_SIG: ComposeIdentity = { senderName: "Enrique", postalAddress: "123 Main St, Miami, FL", signature: "" };
const IDENTITY_WITH_SIG: ComposeIdentity = {
  senderName: "Enrique Hernandez",
  postalAddress: "868 N Wells St, Chicago, IL 60610",
  signature: "Founder\n\n868 N Wells St, Chicago, IL 60610\ncontact@clickworthytool.com\nhttps://clickworthytool.com/",
};

describe("signatureBlock", () => {
  test("empty signature — just the base sender/company line, no trailing blank", () => {
    expect(signatureBlock(IDENTITY_NO_SIG)).toBe("\n\nEnrique\nClickworthy");
  });

  test("non-empty signature — appended on its own line under the base line", () => {
    const block = signatureBlock(IDENTITY_WITH_SIG);
    expect(block).toBe(
      "\n\nEnrique Hernandez\nClickworthy\nFounder\n\n868 N Wells St, Chicago, IL 60610\ncontact@clickworthytool.com\nhttps://clickworthytool.com/"
    );
  });

  test("whitespace-only signature behaves like empty (trimmed)", () => {
    expect(signatureBlock({ ...IDENTITY_NO_SIG, signature: "   \n  " })).toBe("\n\nEnrique\nClickworthy");
  });
});

const TOUCH1_TEMPLATE: Touch1Template = {
  en: { subjects: ["s1", "s2", "s3"], body: "{{greeting}}\n\nBody text." },
  es: { subjects: ["s1", "s2", "s3"], body: "{{greeting}}\n\nTexto del cuerpo." },
};
const BUMP_TEMPLATE: BumpTemplate = {
  en: { body: "{{greeting}}\n\nBump text." },
  es: { body: "{{greeting}}\n\nTexto del bump." },
};
const TOUCH2_TEMPLATE: Touch2Template = {
  en: { subject: "your {{dish}}", body: "{{greeting}}\n\nHere it is." },
  es: { subject: "su {{dish}}", body: "{{greeting}}\n\nAquí está." },
};

const RESTAURANT = { restaurantName: "Casa del Sol", firstName: "Maria", dish: "ropa vieja", city: "Miami, FL" };

const TEST_PACKAGES: Record<PackageId, PackageTier> = {
  glow_up: {
    id: "glow_up",
    name: { en: "Menu Glow-Up", es: "Renovación de Menú" },
    priceCents: 49900,
    photoLimit: 30,
    blurb: { en: "Up to 30 dishes enhanced", es: "Hasta 30 platos mejorados" },
    billingNote: { en: "one-time", es: "pago único" },
    checkoutEnabled: true,
  },
  grand_opening: {
    id: "grand_opening",
    name: { en: "Grand Opening Package", es: "Paquete de Apertura" },
    priceCents: 89900,
    photoLimit: 40,
    blurb: { en: "Up to 40 photos", es: "Hasta 40 fotos" },
    billingNote: { en: "one-time", es: "pago único" },
    checkoutEnabled: true,
  },
  always_fresh: {
    id: "always_fresh",
    name: { en: "Always Fresh", es: "Siempre Fresco" },
    priceCents: 24900,
    photoLimit: 8,
    blurb: { en: "8 photos/month", es: "8 fotos al mes" },
    billingNote: { en: "per month", es: "por mes" },
    checkoutEnabled: false,
  },
};

describe("composeTouch1 / composeBump / composeTouch2 — signature placement", () => {
  test("body ends with: template body, then signature, then compliance footer — in that order", () => {
    const { body } = composeTouch1({
      ...RESTAURANT,
      language: "en",
      subjectVariant: 0,
      template: TOUCH1_TEMPLATE,
      identity: IDENTITY_WITH_SIG,
    });
    const expected =
      "Hi Maria,\n\nBody text." + signatureBlock(IDENTITY_WITH_SIG) + complianceFooter("en", IDENTITY_WITH_SIG.postalAddress);
    expect(body).toBe(expected);
  });

  test("composeBump places the signature before the compliance footer too", () => {
    const body = composeBump({ ...RESTAURANT, language: "en", template: BUMP_TEMPLATE, identity: IDENTITY_WITH_SIG });
    expect(body).toBe("Hi Maria,\n\nBump text." + signatureBlock(IDENTITY_WITH_SIG) + complianceFooter("en", IDENTITY_WITH_SIG.postalAddress));
  });

  test("composeTouch2 places the signature before the compliance footer too", () => {
    const { body } = composeTouch2({
      ...RESTAURANT,
      funnelUrl: "https://clickworthytool.com/l/abc",
      bookingUrl: null,
      pricingBlock: "",
      language: "en",
      template: TOUCH2_TEMPLATE,
      identity: IDENTITY_WITH_SIG,
    });
    expect(body).toBe("Hi Maria,\n\nHere it is." + signatureBlock(IDENTITY_WITH_SIG) + complianceFooter("en", IDENTITY_WITH_SIG.postalAddress));
  });

  test("empty signature setting still composes cleanly (no dangling blank lines / stray text)", () => {
    const { body } = composeTouch1({
      ...RESTAURANT,
      language: "en",
      subjectVariant: 0,
      template: TOUCH1_TEMPLATE,
      identity: IDENTITY_NO_SIG,
    });
    expect(body).toBe("Hi Maria,\n\nBody text.\n\nEnrique\nClickworthy" + complianceFooter("en", IDENTITY_NO_SIG.postalAddress));
  });

  test("compliance footer detector still passes with the signature inserted ahead of it", () => {
    const { body } = composeTouch1({
      ...RESTAURANT,
      language: "en",
      subjectVariant: 0,
      template: TOUCH1_TEMPLATE,
      identity: IDENTITY_WITH_SIG,
    });
    expect(hasComplianceFooter(body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bounce detection. A delivery failure arrives in the SAME thread as the
// message that failed, so without this the poller books it as a reply — which
// is exactly what happened on 2026-08-27: the only "reply" across 42 sends was
// a mailer-daemon "Address not found", so the reply rate read 1/42 instead of
// the true 0/42. False positives are the dangerous direction here (they
// silently bin a real reply), so the human-reply cases below are the point.
// ---------------------------------------------------------------------------

describe("isBounceNotification", () => {
  test("catches the exact Gmail bounce this pipeline received", () => {
    expect(
      isBounceNotification(
        "mailer-daemon@googlemail.com",
        "** Address not found ** Your message wasn't delivered to info@originaljohnnysshrimpboat.com because the address couldn't be found."
      )
    ).toBe(true);
  });

  test("catches a bounce by sender alone, even with an empty body", () => {
    expect(isBounceNotification("MAILER-DAEMON@example.net", "")).toBe(true);
    expect(isBounceNotification("postmaster@somehost.com", "")).toBe(true);
  });

  test("catches a bounce by body alone, from an unusual sender", () => {
    expect(isBounceNotification("bounces@mail.example", "Delivery Status Notification (Failure)")).toBe(true);
    expect(isBounceNotification("relay@example.com", "550 5.1.1 User unknown")).toBe(true);
  });

  test("does NOT swallow a genuine owner reply", () => {
    expect(isBounceNotification("maria@tacos.example", "Hi! Yes please send me the photo, sounds great.")).toBe(false);
    expect(isBounceNotification("owner@bistro.example", "Interested — what does it cost?")).toBe(false);
  });

  test("does NOT misread a reply that merely mentions delivery", () => {
    // A restaurant talking about ITS OWN delivery service is the realistic
    // false-positive risk; none of the DSN phrases appear here.
    expect(isBounceNotification("chef@x.example", "We do delivery on weekends, can you shoot those dishes?")).toBe(false);
    expect(isBounceNotification("chef@x.example", "Our delivery photos are terrible, yes let's talk.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractBouncedRecipient — added 2026-08-27 after finding that bounces were
// never being caught in production: DSNs arrive as their OWN Gmail thread, so
// the thread-matching handler was skipped entirely. Reading the dead address
// out of the DSN body removes the dependency on threading.
// ---------------------------------------------------------------------------

describe("extractBouncedRecipient", () => {
  test("parses the exact Gmail DSN body this pipeline received", () => {
    // Verbatim shape of the stored replyBody on Johnny's Shrimp Boat (job #129).
    const body =
      "\r\n** Address not found **\r\n\r\nYour message wasn't delivered to " +
      "info@originaljohnnysshrimpboat.com because the address couldn't be found, " +
      "or is unable to receive mail.\r\n";
    expect(extractBouncedRecipient(body)).toBe("info@originaljohnnysshrimpboat.com");
  });

  test("parses the three addresses that bounced un-caught on 2026-08-27", () => {
    for (const addr of ["info@tauropizza.com", "info@pinkyringpizza.com", "info@zatar.nyc"]) {
      const body = `** Address not found **\n\nYour message wasn't delivered to ${addr} because the address couldn't be found.`;
      expect(extractBouncedRecipient(body)).toBe(addr);
    }
  });

  test("prefers the machine-readable RFC 3464 Final-Recipient header", () => {
    const body =
      "Reporting-MTA: dns; mail.example.com\n" +
      "Final-Recipient: rfc822; owner@bistro.example\n" +
      "Action: failed\n" +
      "Status: 5.1.1\n";
    expect(extractBouncedRecipient(body)).toBe("owner@bistro.example");
  });

  test("handles an angle-bracketed Final-Recipient", () => {
    expect(extractBouncedRecipient("Final-Recipient: rfc822; <owner@bistro.example>")).toBe("owner@bistro.example");
  });

  test("strips a trailing sentence period", () => {
    const body = "Your message wasn't delivered to chef@x.example.";
    expect(extractBouncedRecipient(body)).toBe("chef@x.example");
  });

  test("lowercases the address so the restaurants lookup matches", () => {
    expect(extractBouncedRecipient("Your message wasn't delivered to INFO@Zatar.NYC because")).toBe("info@zatar.nyc");
  });

  test("handles the 'was not delivered' / 'could not be delivered' spellings", () => {
    expect(extractBouncedRecipient("Your message was not delivered to a@b.example because")).toBe("a@b.example");
    expect(extractBouncedRecipient("The message could not be delivered to c@d.example after 3 attempts")).toBe("c@d.example");
  });

  test("returns null rather than guessing when nothing matches", () => {
    // Suppression is effectively permanent for a lead, so a wrong guess here
    // costs a real prospect — null makes the caller log instead of act.
    expect(extractBouncedRecipient("Delivery Status Notification (Failure)")).toBe(null);
    expect(extractBouncedRecipient("")).toBe(null);
    expect(extractBouncedRecipient("Hi! Yes please send the photo.")).toBe(null);
  });

  test("does NOT pick up an unrelated address elsewhere in the body", () => {
    // The DSN quotes our own headers back at us; grabbing the first address in
    // the body would suppress the SENDER instead of the dead mailbox.
    const body =
      "** Address not found **\n\nYour message wasn't delivered to info@deadplace.example because " +
      "the address couldn't be found.\n\n----- Original message -----\nFrom: mail@clickworthytool.com\n" +
      "To: info@deadplace.example\n";
    expect(extractBouncedRecipient(body)).toBe("info@deadplace.example");
  });
});

// ---------------------------------------------------------------------------
// {{pricing}} — added 2026-08-27 so Touch 2 quotes live package_tiers instead
// of a hardcoded prose block that could drift from what checkout charges.
// ---------------------------------------------------------------------------

describe("formatPricingBlock", () => {
  test("renders one paragraph per tier, in PACKAGE_ORDER, with name/photoLimit/blurb", () => {
    const block = formatPricingBlock(TEST_PACKAGES, "en");
    const paragraphs = block.split("\n\n");
    expect(paragraphs).toHaveLength(PACKAGE_ORDER.length);
    PACKAGE_ORDER.forEach((id, i) => {
      const tier = TEST_PACKAGES[id];
      expect(paragraphs[i]).toContain(tier.name.en);
      expect(paragraphs[i]).toContain(String(tier.photoLimit));
      expect(paragraphs[i]).toContain(tier.blurb.en);
    });
  });

  test("consistency: quotes exactly the same price string checkout would charge", () => {
    // The whole point of this feature — Touch 2 and the funnel/checkout both
    // read priceCents off the SAME packages map, so this can never drift the
    // way the old hardcoded prose could. formatCents is what the funnel card
    // and Stripe unit_amount both ultimately derive from (see FunnelClient.tsx
    // and app/api/outreach/checkout/route.ts).
    const block = formatPricingBlock(TEST_PACKAGES, "en");
    for (const id of PACKAGE_ORDER) {
      expect(block).toContain(formatCents(TEST_PACKAGES[id].priceCents));
    }
  });

  test("renders the ES branch when language is es", () => {
    const block = formatPricingBlock(TEST_PACKAGES, "es");
    expect(block).toContain("Renovación de Menú");
    expect(block).not.toContain("Menu Glow-Up");
  });
});

describe("composeTouch2 — dish is optional", () => {
  const TOUCH2_NO_DISH: Touch2Template = {
    en: { subject: "your photo, enhanced", body: "{{greeting}}\n\nHere's your sample.\n\n{{pricing}}" },
    es: { subject: "su foto, mejorada", body: "{{greeting}}\n\nAquí está su muestra.\n\n{{pricing}}" },
  };

  test("composes fine with a template that never references {{dish}}", () => {
    const { subject, body } = composeTouch2({
      ...RESTAURANT,
      funnelUrl: "https://clickworthytool.com/l/abc",
      bookingUrl: null,
      pricingBlock: formatPricingBlock(TEST_PACKAGES, "en"),
      language: "en",
      template: TOUCH2_NO_DISH,
      identity: IDENTITY_WITH_SIG,
    });
    expect(subject).toBe("your photo, enhanced");
    expect(body).toContain("Here's your sample.");
    expect(body).toContain("Menu Glow-Up");
  });

  test("still composes with a template that DOES reference {{dish}} — backwards compatible", () => {
    const { subject, body } = composeTouch2({
      ...RESTAURANT,
      funnelUrl: "https://clickworthytool.com/l/abc",
      bookingUrl: null,
      pricingBlock: formatPricingBlock(TEST_PACKAGES, "en"),
      language: "en",
      template: TOUCH2_TEMPLATE, // subject is "your {{dish}}"
      identity: IDENTITY_WITH_SIG,
    });
    expect(subject).toBe("your ropa vieja");
    expect(body).toContain("Here it is.");
  });

  test("a dish-less lead still composes — falls back to the generic word, doesn't throw", () => {
    const { subject } = composeTouch2({
      ...RESTAURANT,
      dish: "",
      funnelUrl: "https://clickworthytool.com/l/abc",
      bookingUrl: null,
      pricingBlock: formatPricingBlock(TEST_PACKAGES, "en"),
      language: "en",
      template: TOUCH2_TEMPLATE,
      identity: IDENTITY_WITH_SIG,
    });
    expect(subject).toBe("your food");
  });
});

// ---------------------------------------------------------------------------
// Opt-out detection. Rewritten 2026-08-31: bare "no" removed (it silently
// destroyed leads — AUDIT.md), unambiguous phrases widened. False positives
// are the dangerous direction: one wrongly suppresses a restaurant forever.
// ---------------------------------------------------------------------------

describe("isOptOut", () => {
  test("catches unambiguous administrative opt-outs", () => {
    for (const s of [
      "stop", "STOP", "Unsubscribe", "unsubscribe me", "please unsubscribe",
      "remove", "Remove me", "please remove me", "take me off",
      "take me off the list", "opt out", "opt-out",
    ]) {
      expect(isOptOut(s)).toBe(true);
    }
  });

  test("catches the Spanish equivalents", () => {
    for (const s of ["baja", "darse de baja", "eliminar", "no me escriba", "no me escriban"]) {
      expect(isOptOut(s)).toBe(true);
    }
  });

  test("tolerates punctuation and extra whitespace", () => {
    expect(isOptOut("Remove me, please.")).toBe(false); // trailing word -> not an exact phrase
    expect(isOptOut("Remove me.")).toBe(true);
    expect(isOptOut("  unsubscribe!  ")).toBe(true);
    expect(isOptOut("remove  me")).toBe(true);
  });

  test("a bare 'no' is NOT an opt-out — it goes to a human instead", () => {
    // The regression this list was rewritten for: "no" can open a real
    // conversation as easily as end one, and auto-suppressing killed leads
    // silently. It must fall through to the needs-a-human branch.
    expect(isOptOut("no")).toBe(false);
    expect(isOptOut("No.")).toBe(false);
    expect(isOptOut("no thanks")).toBe(false);
    expect(isOptOut("no gracias")).toBe(false);
  });

  test("does NOT fire on a genuine reply that merely contains an opt-out word", () => {
    expect(isOptOut("Please remove the watermark and resend")).toBe(false);
    expect(isOptOut("Stop by the restaurant any time and we can talk")).toBe(false);
    expect(isOptOut("Interested — what does it cost?")).toBe(false);
    expect(isOptOut("We already have a photographer, but send info")).toBe(false);
  });

  test("only the FIRST line is considered", () => {
    expect(isOptOut("unsubscribe\n\n(sent from my iPhone)")).toBe(true);
    expect(isOptOut("Sounds great!\nunsubscribe")).toBe(false);
  });
});
