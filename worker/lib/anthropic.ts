// Shared Anthropic client + the worker's three Claude tasks:
//   - scorePhoto:        Claude Vision quality score (2–6) + category
//   - checkHospitalityGroup: web-search-backed "is this a chain/group?" check
//   - (Revenue Impact Card copy lives in Phase 3, added later)

import Anthropic from "@anthropic-ai/sdk";
import { config, requireKey } from "../config";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: requireKey("anthropicApiKey", "ANTHROPIC_API_KEY") });
  return client;
}

// Pulls the first text block out of a Messages response.
function firstText(message: Anthropic.Message): string {
  const block = message.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

// Extracts a JSON object from a model reply that may wrap it in prose/fences.
function parseJsonObject<T>(text: string): T {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object in model reply: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]) as T;
}

export type PhotoScore = {
  score: number; // 2–6 (PROJECT_CONTEXT Section 8)
  category: string; // "food" | "menu" | "interior" | "exterior" | "other"
  enhancementValue: number; // 2–6: how much a professional enhance would help
};

// Scores one owner-uploaded listing photo. Bytes are passed in-memory (never
// stored — Google ToS). contentType must be a Claude-supported image mime.
export async function scorePhoto(bytes: Buffer, contentType: string): Promise<PhotoScore> {
  const mediaType = normalizeImageMime(contentType);
  const message = await getClient().messages.create({
    model: config.claudeModel,
    max_tokens: 200,
    system:
      "You are a restaurant-photo quality grader. Rate an owner-uploaded listing photo on a 2–6 scale " +
      "(2 = poor: dark, blurry, badly composed; 6 = already professional). Also give the category and how " +
      "much a professional AI enhancement (lighting/color/sharpness, no scene changes) would improve it. " +
      'Respond ONLY with JSON: {"score": <2-6 int>, "category": "food"|"menu"|"interior"|"exterior"|"other", ' +
      '"enhancementValue": <2-6 int>}.',
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
          },
          { type: "text", text: "Grade this photo." },
        ],
      },
    ],
  });

  const parsed = parseJsonObject<PhotoScore>(firstText(message));
  return {
    score: clamp(parsed.score, 2, 6),
    category: parsed.category || "other",
    enhancementValue: clamp(parsed.enhancementValue, 2, 6),
  };
}

export type HospitalityGroupResult = {
  isGroup: boolean;
  reasoning: string;
};

// Uses Claude + web search to decide whether a restaurant is part of a
// hospitality group / chain (a hard-filter disqualifier). The web_search tool
// lets it reason about ambiguous cases ("Boka" the group vs. a lone "Boka").
export async function checkHospitalityGroup(
  name: string,
  city: string
): Promise<HospitalityGroupResult> {
  const message = await getClient().messages.create({
    model: config.claudeModel,
    max_tokens: 400,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    system:
      "Decide whether a given restaurant is part of a larger hospitality/restaurant group or a chain " +
      "(multiple locations, a parent company, or a franchise). A single independently-owned restaurant is NOT " +
      "a group even if the name sounds corporate. Search the web if unsure. " +
      'End your reply with a JSON object on its own: {"isGroup": <bool>, "reasoning": "<one sentence>"}.',
    messages: [
      { role: "user", content: `Restaurant: "${name}" in ${city}. Is it part of a hospitality group or chain?` },
    ],
  });

  const text = firstText(message);
  try {
    return parseJsonObject<HospitalityGroupResult>(text);
  } catch {
    // If the model didn't emit clean JSON, fail open (treat as NOT a group) so
    // we don't silently drop independents — but log the raw reply for review.
    console.warn(`[anthropic] hospitality-group parse fallback for "${name}": ${text.slice(0, 160)}`);
    return { isGroup: false, reasoning: "unparseable model reply; defaulted to independent" };
  }
}

export type Touch1Inputs = {
  name: string;
  city: string;
  rating: number | null;
  reviewCount: number | null;
  language: string; // 'en' | 'es'
  worstCategory: string | null; // e.g. "food" — the weakest photo category, if known
};

// Generates the Touch 1 cold-email BODY (no subject, no footer, no links) per
// PROJECT_CONTEXT Section 9's 3-line structure: (1) specific photo observation,
// (2) one financial signal tied to rating/city, (3) the free-sample offer.
//
// PLACEHOLDER: Jose owns the final Touch 1 copy. This generated version follows
// the structure so the pipeline is testable end-to-end; swap in the approved
// template when it exists.
export async function generateTouch1Body(i: Touch1Inputs): Promise<string> {
  const message = await getClient().messages.create({
    model: config.claudeModel,
    max_tokens: 300,
    system:
      "Write a 3-sentence cold email body to an independent restaurant owner about their online listing " +
      "photos. Sentence 1: a specific, plausible observation about their food/menu photos (angle, lighting, " +
      "or how they show up on Google/delivery apps). Sentence 2: one concrete financial signal tied to their " +
      "rating and city (lost delivery clicks / revenue — be realistic, not hypey). Sentence 3 (verbatim intent): " +
      "invite them to reply with a photo of one of their dishes to get a professionally enhanced version back, " +
      "free, to see the difference. No greeting, no signature, no links, no subject line — just the 3 sentences. " +
      `Write in ${i.language === "es" ? "Spanish" : "English"}.`,
    messages: [
      {
        role: "user",
        content:
          `Restaurant: ${i.name}\nCity: ${i.city}\nRating: ${i.rating ?? "n/a"} stars\n` +
          `Reviews: ${i.reviewCount ?? "n/a"}\nWeakest photo category: ${i.worstCategory ?? "food"}`,
      },
    ],
  });
  return firstText(message);
}

export type RevenueImpactInputs = {
  name: string;
  city: string;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: number | null;
  deliveryEnabled: boolean;
  avgPhotoScore: number | null;
  language: string;
};

// The Revenue Impact Card: a personalized 3-sentence narrative shown on the
// magic-link page (PROJECT_CONTEXT Section 9). Generated once at link creation
// and stored.
export async function generateRevenueImpactCopy(i: RevenueImpactInputs): Promise<string> {
  const message = await getClient().messages.create({
    model: config.claudeModel,
    max_tokens: 300,
    system:
      "Write a 3-sentence personalized revenue-impact summary for a restaurant owner. " +
      "Sentence 1: quantify what current photo quality is likely costing them in delivery clicks/revenue, " +
      "using a rating-tier-based percentage. Sentence 2: show the upside with a realistic benchmark for " +
      "similar restaurants in their city/tier. Sentence 3: frame the price as an obvious decision relative " +
      "to the problem. Be concrete and credible (an owner might fact-check). No greeting or signature. " +
      `Write in ${i.language === "es" ? "Spanish" : "English"}.`,
    messages: [
      {
        role: "user",
        content:
          `Restaurant: ${i.name}\nCity: ${i.city}\nRating: ${i.rating ?? "n/a"}\n` +
          `Reviews: ${i.reviewCount ?? "n/a"}\nPrice level: ${i.priceLevel ?? "n/a"}\n` +
          `Delivery: ${i.deliveryEnabled}\nAvg photo score (2-6): ${i.avgPhotoScore ?? "n/a"}`,
      },
    ],
  });
  return firstText(message);
}

function clamp(n: number, lo: number, hi: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function normalizeImageMime(contentType: string): "image/jpeg" | "image/png" | "image/webp" | "image/gif" {
  const c = contentType.toLowerCase();
  if (c.includes("png")) return "image/png";
  if (c.includes("webp")) return "image/webp";
  if (c.includes("gif")) return "image/gif";
  return "image/jpeg";
}
