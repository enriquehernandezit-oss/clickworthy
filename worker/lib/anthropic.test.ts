// Regression test for the checkHospitalityGroup parsing bug (2026-08-21): a
// web_search-using response comes back as MULTIPLE content blocks (text ->
// server_tool_use -> web_search_tool_result -> text -> ... -> final text with
// the JSON, since the prompt says to "End your reply" with it). The old
// firstText() took only the FIRST block — the model's opening remark before it
// ever searched — so the JSON parse failed on every single call and the whole
// disqualifier silently defaulted to "not a group," every time. allText()
// fixes this by joining every text block in order. Run with `bun test`.

import { expect, test, describe } from "bun:test";
import { allText } from "./anthropic";
import type Anthropic from "@anthropic-ai/sdk";

// A single-block (no-tool) response — scorePhoto / generateRevenueImpactCopy
// shape. Must behave identically to before (this is the "no regression" half).
function plainMessage(text: string): Anthropic.Message {
  return { content: [{ type: "text", text, citations: [] }] } as unknown as Anthropic.Message;
}

// A multi-block, web_search-shaped response: opening remark -> tool use ->
// tool result -> final text carrying the JSON. This is the real shape that
// broke production (2026-08-21).
function searchMessage(opening: string, finalWithJson: string): Anthropic.Message {
  return {
    content: [
      { type: "text", text: opening, citations: [] },
      { type: "server_tool_use", id: "srvtoolu_x", name: "web_search", input: { query: "x" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_x", content: [] },
      { type: "text", text: finalWithJson, citations: [] },
    ],
  } as unknown as Anthropic.Message;
}

describe("allText — single-block responses (no regression)", () => {
  test("returns the one text block unchanged", () => {
    expect(allText(plainMessage('{"score": 5}'))).toBe('{"score": 5}');
  });

  test("trims whitespace", () => {
    expect(allText(plainMessage("  hello  "))).toBe("hello");
  });
});

describe("allText — multi-block web_search responses (the production bug)", () => {
  test("includes the FINAL text block, not just the first", () => {
    const msg = searchMessage(
      "Let me research this restaurant.",
      'Punch House is part of a larger hospitality group. {"isGroup": true, "reasoning": "part of Thalia Hall group", "ownerFirstName": null}'
    );
    const text = allText(msg);
    expect(text).toContain("isGroup");
    expect(text).toContain("true");
  });

  test("the OLD bug reproduced: taking only the first block loses the JSON entirely", () => {
    const msg = searchMessage(
      "Let me research this restaurant.",
      '{"isGroup": true, "reasoning": "chain", "ownerFirstName": null}'
    );
    const firstBlockOnly = (msg.content[0] as { type: "text"; text: string }).text;
    expect(firstBlockOnly).not.toContain("isGroup"); // proves the old code's failure mode
    expect(allText(msg)).toContain("isGroup"); // proves the fix
  });

  test("a real JSON object is extractable from the joined text via the same regex parseJsonObject uses", () => {
    const msg = searchMessage(
      "Searching for ownership info...",
      'Based on my research, this is independent. {"isGroup": false, "reasoning": "single independent restaurant", "ownerFirstName": "Maria"}'
    );
    const text = allText(msg);
    const match = text.match(/\{[\s\S]*\}/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![0]);
    expect(parsed.isGroup).toBe(false);
    expect(parsed.ownerFirstName).toBe("Maria");
  });
});
