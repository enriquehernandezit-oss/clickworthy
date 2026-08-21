// Shared Anthropic client + the worker's three Claude tasks:
//   - scorePhoto:        Claude Vision quality score (2–6) + category
//   - checkHospitalityGroup: web-search-backed "is this a chain/group?" check
//   - (Revenue Impact Card copy lives in Phase 3, added later)

import Anthropic from "@anthropic-ai/sdk";
import { config, requireKey } from "../config";
import { sendAlert } from "@/lib/alerts";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: requireKey("anthropicApiKey", "ANTHROPIC_API_KEY") });
  return client;
}

// A billing/auth failure hits EVERY Claude call (photo scoring, dish detection,
// Revenue Impact copy), and each is caught per-photo upstream — so without this
// a depleted balance silently zeroes scores across a whole run with nothing in
// the inbox. Alert at most once an hour (systemic errors persist; per-photo
// alerts would be hundreds). In-memory cooldown is fine: the worker is long-
// lived, and a reboot re-arming the alert is acceptable.
let lastApiAlertAt = 0;
const API_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

async function maybeAlertApiError(err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  const isBilling = /credit balance is too low|billing|payment|quota/i.test(msg);
  const isAuth = status === 401 || /invalid x-api-key|authentication_error|authentication/i.test(msg);
  if (!isBilling && !isAuth) return; // transient blips (429/500/overloaded) aren't a human-fix alert
  if (Date.now() - lastApiAlertAt < API_ALERT_COOLDOWN_MS) return;
  lastApiAlertAt = Date.now();
  const kind = isBilling ? "credits/billing" : "authentication (API key)";
  await sendAlert(
    `Anthropic API ${kind} error — photo scoring is DOWN`,
    `A Claude API call failed with a ${kind} error. This affects EVERY worker Claude call — ` +
      `photo scoring, signature-dish detection, and Revenue Impact copy — so new leads get NO ` +
      `photo score or dish until it's fixed (enrichment still completes, just empty).\n\n` +
      `Error: ${msg}\n\n` +
      (isBilling
        ? "Add credits at console.anthropic.com -> Settings -> Billing."
        : "Check ANTHROPIC_API_KEY on the worker service."),
  ).catch(() => {}); // never let an alert failure mask the original error
}

// All worker Claude calls go through here so a systemic API failure (out of
// credits, bad key) gets surfaced once instead of silently swallowed upstream.
// The original error is still thrown for the caller's own per-call handling.
async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  try {
    return await getClient().messages.create(params);
  } catch (err) {
    await maybeAlertApiError(err);
    throw err;
  }
}

// Joins every text block in a Messages response, in order. A plain (no-tool)
// response has exactly one text block, so this is a no-op for scorePhoto /
// generateRevenueImpactCopy. checkHospitalityGroup is different: the web_search
// tool makes Claude interleave text with server_tool_use/web_search_tool_result
// blocks across multiple rounds, and its system prompt says to "End your reply"
// with the JSON — so the JSON lands in the LAST text block, not the first.
// Taking only the first block (the old behavior) silently grabbed the model's
// opening remark before it ever searched, which the JSON parse then failed on —
// producing a false "unparseable, defaulted to independent" on EVERY call and
// making the whole disqualifier a no-op. Caught 2026-08-21 rechecking 14 live
// drafts: Claude's own reasoning correctly called out several as chains/groups,
// but 0 of 14 were ever flagged because the JSON was never where this looked.
export function allText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
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
  dish: string | null; // the dish shown, if this is a food photo (e.g. "birria tacos") — for the cold email
};

// Scores one owner-uploaded listing photo. Bytes are passed in-memory (never
// stored — Google ToS). contentType must be a Claude-supported image mime.
export async function scorePhoto(bytes: Buffer, contentType: string): Promise<PhotoScore> {
  const mediaType = normalizeImageMime(contentType);
  const message = await createMessage({
    model: config.claudeModel,
    max_tokens: 200,
    system:
      "You are a restaurant-photo quality grader. Rate an owner-uploaded listing photo on a 2–6 scale " +
      "(2 = poor: dark, blurry, badly composed; 6 = already professional). Give the category, how much a " +
      "professional AI enhancement (lighting/color/sharpness, no scene changes) would improve it, and — if " +
      'it is a food photo — name the specific dish shown in a few words (e.g. "birria tacos", "ribeye steak"); ' +
      "otherwise dish is null. " +
      'Respond ONLY with JSON: {"score": <2-6 int>, "category": "food"|"menu"|"interior"|"exterior"|"other", ' +
      '"enhancementValue": <2-6 int>, "dish": "<short dish name>"|null}.',
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

  const parsed = parseJsonObject<PhotoScore>(allText(message));
  return {
    score: clamp(parsed.score, 2, 6),
    category: parsed.category || "other",
    enhancementValue: clamp(parsed.enhancementValue, 2, 6),
    dish: typeof parsed.dish === "string" && parsed.dish.trim() ? parsed.dish.trim() : null,
  };
}

export type HospitalityGroupResult = {
  isGroup: boolean;
  reasoning: string;
  ownerFirstName: string | null; // best-effort, for the cold email greeting; null if unknown
};

// Uses Claude + web search to decide whether a restaurant is part of a
// hospitality group / chain (a hard-filter disqualifier), and — same search,
// no extra call — to grab the owner's first name if it's easy to find (for the
// cold-email greeting; null when not confidently known). The web_search tool
// lets it reason about ambiguous cases ("Boka" the group vs. a lone "Boka").
export async function checkHospitalityGroup(
  name: string,
  city: string
): Promise<HospitalityGroupResult> {
  const message = await createMessage({
    model: config.claudeModel,
    // 500 was too tight: up to 3 web-search rounds plus reasoning after each
    // can exhaust it before the model ever reaches the "end with JSON"
    // instruction, so the response gets cut off mid-sentence and (even after
    // fixing allText) there is genuinely no JSON anywhere in the output.
    // Caught 2026-08-21 rechecking live drafts: 6 of 14 truncated mid-word
    // ("...As part of the renowned San[kalp]", "...woman-own[ed]"). Raising
    // the CAP costs nothing unless the model actually needs the room — output
    // is billed on tokens actually generated, not the ceiling.
    max_tokens: 1500,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    system:
      "For a given restaurant, decide two things and search the web if unsure. " +
      "(1) Is it part of a larger hospitality/restaurant group or a chain (multiple locations, parent company, " +
      "or franchise)? A single independently-owned restaurant is NOT a group even if the name sounds corporate. " +
      "(2) What is the OWNER's first name? Only give it if you find it confidently (bio, press, 'owner' mention); " +
      "otherwise null. Never guess a name. " +
      'End your reply with a JSON object on its own: {"isGroup": <bool>, "reasoning": "<one sentence>", ' +
      '"ownerFirstName": "<first name>"|null}.',
    messages: [
      { role: "user", content: `Restaurant: "${name}" in ${city}. Is it a group/chain, and who owns it?` },
    ],
  });

  const text = allText(message);
  try {
    const parsed = parseJsonObject<HospitalityGroupResult>(text);
    return {
      isGroup: Boolean(parsed.isGroup),
      reasoning: parsed.reasoning ?? "",
      ownerFirstName:
        typeof parsed.ownerFirstName === "string" && parsed.ownerFirstName.trim()
          ? parsed.ownerFirstName.trim()
          : null,
    };
  } catch {
    // If the model didn't emit clean JSON, fail open (treat as NOT a group) so
    // we don't silently drop independents — but log the raw reply for review.
    console.warn(`[anthropic] hospitality-group parse fallback for "${name}": ${text.slice(0, 160)}`);
    return { isGroup: false, reasoning: "unparseable model reply; defaulted to independent", ownerFirstName: null };
  }
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
// magic-link page right after a restaurant's free sample. Generated once at
// link creation and stored. Positioning (locked): Clickworthy isn't a photo
// service — it helps restaurants shift orders off delivery apps onto their own
// channels, where they keep 100% instead of paying commission. Lead with that
// bleed, not with "your photos look bad."
export async function generateRevenueImpactCopy(i: RevenueImpactInputs): Promise<string> {
  const message = await createMessage({
    model: config.claudeModel,
    max_tokens: 300,
    system:
      "Write a 3-sentence personalized revenue-impact summary for a restaurant owner, shown right after they " +
      "received their free enhanced photo. Sentence 1: name what delivery-app commission is likely costing " +
      "them — apps charge 15-30% per order, often 30-40% effective once promos/fees stack, while their own " +
      "website, Google profile, and Instagram keep 100%; tie it to their price level/rating tier, be concrete " +
      "but not hypey. Sentence 2: connect it to their photos specifically — their delivery listing currently " +
      "outshines their own channels, which is backwards, and that's fixable. Sentence 3: frame getting the " +
      "rest of their menu enhanced as the obvious next step. Compliance rule: we ENHANCE real photos, never " +
      '"generate" food — never use the phrase "AI-generated." Be credible (an owner might fact-check the ' +
      "numbers). No greeting or signature. " +
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
  return allText(message);
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
