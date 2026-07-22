// Claid.ai integration for the /enhance flow.
//
// Two calls are chained per photo:
//   1. Image AI Edit (async) — applies the customer's free-text prompt.
//        POST https://api.claid.ai/v1/image/ai-edit   { input, options: { prompt } }
//        -> poll GET https://api.claid.ai/v1/image/ai-edit/{id} until status is DONE/ERROR
//   2. Image Edit (sync) — runs the AI-edited result through Claid's upscale/
//      enhance restoration to bring it up to a usable final resolution.
//        POST https://api.claid.ai/v1/image/edit   { input, operations: { restorations: { upscale } } }
//
// Both request and response shapes are confirmed against the live API (a real
// test job was run and inspected). A DONE ai-edit poll returns:
//   { data: { status: "DONE", result: { output_objects: [ { tmp_url, width,
//     height, ... } ] } } }
// Note output_objects is a plural ARRAY — that's the load-bearing detail.

const CLAID_BASE_URL = "https://api.claid.ai/v1";
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 30; // ~60s ceiling per photo before giving up

export class ClaidError extends Error {}

function requireApiKey(): string {
  const apiKey = process.env.CLAID_API_KEY;
  if (!apiKey) {
    console.warn(
      "[claid] CLAID_API_KEY is not set. TODO: add CLAID_API_KEY to the environment " +
        "before enhancement jobs can actually run — all Claid calls will fail until then."
    );
    throw new ClaidError("CLAID_API_KEY is not configured");
  }
  return apiKey;
}

function authHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function submitAiEdit(apiKey: string, imageUrl: string, prompt: string): Promise<string> {
  const res = await fetch(`${CLAID_BASE_URL}/image/ai-edit`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      input: imageUrl,
      options: {
        prompt,
        model: "v2",
        // Live-API-verified ceilings: guidance_scale maxes at 10.0 and
        // inference_steps at 50 (Claid's docs quote 12 / "max" — both rejected
        // with a 400). Max both out: high guidance keeps the model faithful to
        // the prompt (which forbids adding/removing objects), and we're at low
        // volume so quality beats speed.
        guidance_scale: 10,
        inference_steps: 50,
      },
    }),
  });

  if (!res.ok) {
    throw new ClaidError(`Claid AI Edit submission failed (${res.status}): ${await res.text()}`);
  }

  const body = await res.json();
  const taskId = body?.data?.id;
  if (taskId === undefined || taskId === null) {
    throw new ClaidError(`Claid AI Edit response missing task id: ${JSON.stringify(body)}`);
  }
  return String(taskId);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pulls the enhanced image URL out of a DONE ai-edit poll response. Primary
// path is data.result.output_objects[0].tmp_url (confirmed against the live
// API); the older singular `output`/`output_object` paths are kept as
// defensive fallbacks in case Claid varies the shape.
function extractResultUrl(payload: unknown): string | null {
  const p = payload as Record<string, unknown> | null | undefined;
  const data = p?.data as Record<string, unknown> | undefined;
  const result = (data?.result ?? data) as Record<string, unknown> | undefined;

  const outputObjects = result?.output_objects as Array<Record<string, unknown>> | undefined;
  const first = Array.isArray(outputObjects) ? outputObjects[0] : undefined;
  if (first) {
    const url = first.tmp_url ?? first.url;
    if (typeof url === "string") return url;
  }

  const output =
    (result?.output as Record<string, unknown> | undefined) ??
    (result?.output_object as Record<string, unknown> | undefined);
  const fallbackUrl = output?.tmp_url ?? output?.url;
  return typeof fallbackUrl === "string" ? fallbackUrl : null;
}

async function pollAiEdit(apiKey: string, taskId: string): Promise<string> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const res = await fetch(`${CLAID_BASE_URL}/image/ai-edit/${taskId}`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });

    if (!res.ok) {
      throw new ClaidError(`Claid AI Edit poll failed (${res.status}): ${await res.text()}`);
    }

    const body = await res.json();
    const status = body?.data?.status;

    if (status === "DONE") {
      const url = extractResultUrl(body);
      if (!url) {
        throw new ClaidError(`Claid AI Edit completed but no output URL found: ${JSON.stringify(body)}`);
      }
      return url;
    }

    if (status === "ERROR" || status === "CANCELLED") {
      throw new ClaidError(`Claid AI Edit job ${status.toLowerCase()}: ${JSON.stringify(body)}`);
    }
    // ACCEPTED / WAITING / PROCESSING / PAUSED — keep polling.
  }

  throw new ClaidError(`Claid AI Edit job ${taskId} did not finish within the polling window`);
}

async function upscale(apiKey: string, imageUrl: string): Promise<string> {
  const res = await fetch(`${CLAID_BASE_URL}/image/edit`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      input: imageUrl,
      operations: {
        restorations: { upscale: "smart_enhance" },
      },
      output: { format: "jpeg" },
    }),
  });

  if (!res.ok) {
    throw new ClaidError(`Claid upscale failed (${res.status}): ${await res.text()}`);
  }

  const body = await res.json();
  const url = body?.data?.output?.tmp_url;
  if (typeof url !== "string") {
    throw new ClaidError(`Claid upscale response missing output URL: ${JSON.stringify(body)}`);
  }
  return url;
}

// Runs the full AI-edit -> upscale/enhance pipeline for one photo and
// returns the final enhanced image URL (a Claid temporary URL, valid ~24h).
export async function enhancePhoto(imageUrl: string, prompt: string): Promise<string> {
  const apiKey = requireApiKey();
  const taskId = await submitAiEdit(apiKey, imageUrl, prompt);
  const editedUrl = await pollAiEdit(apiKey, taskId);
  return upscale(apiKey, editedUrl);
}
