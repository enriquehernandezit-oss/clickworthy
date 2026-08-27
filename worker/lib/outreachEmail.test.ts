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
  signatureBlock,
  complianceFooter,
  hasComplianceFooter,
  isBounceNotification,
  type ComposeIdentity,
} from "./outreachEmail";
import type { Touch1Template, BumpTemplate, Touch2Template } from "@/lib/settings";

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
