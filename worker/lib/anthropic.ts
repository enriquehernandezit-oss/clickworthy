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
