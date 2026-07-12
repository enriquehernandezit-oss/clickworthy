import Anthropic from "@anthropic-ai/sdk";

export type ModerationResult = {
  flagged: boolean;
  reason?: string;
};

// Lightweight classification pass over the free-text enhancement prompt a
// visitor submits before any payment is attempted. This is a guardrail, not
// a general content-moderation system — it only needs to catch the obvious
// abusive/hateful/sexual cases and let ordinary photo-editing requests through.
export async function moderatePrompt(prompt: string): Promise<ModerationResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(
      "[moderation] ANTHROPIC_API_KEY is not set — skipping moderation check. " +
        "TODO: set ANTHROPIC_API_KEY before accepting real public submissions."
    );
    return { flagged: false };
  }

  const anthropic = new Anthropic({ apiKey });

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "You are a content moderation classifier for a restaurant photo-enhancement service. " +
      "The user submits a free-text instruction describing how they want their food/menu/interior " +
      "photos edited (e.g. 'brighten the lighting and sharpen the focus'). Flag ONLY if the text " +
      "contains hateful, sexual, abusive, harassing, or otherwise clearly inappropriate content that " +
      "has nothing to do with legitimate photo editing. Ordinary photo-editing requests, even unusual " +
      "or oddly worded ones, should NOT be flagged. " +
      'Respond with ONLY a JSON object, no other text: {"flagged": boolean, "reason": string}. ' +
      'Keep "reason" under 15 words and omit it (empty string) when not flagged.',
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    // Fail closed on unexpected response shape — better to ask the user to
    // rephrase than to silently let an unclassified prompt through.
    console.error("[moderation] Unexpected Anthropic response shape", message);
    return { flagged: true, reason: "Could not verify this request, please try rephrasing." };
  }

  try {
    const parsed = JSON.parse(textBlock.text.trim());
    return {
      flagged: Boolean(parsed.flagged),
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch (err) {
    console.error("[moderation] Failed to parse moderation response:", textBlock.text, err);
    return { flagged: true, reason: "Could not verify this request, please try rephrasing." };
  }
}
