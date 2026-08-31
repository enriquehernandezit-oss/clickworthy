// Gmail API client using a Google service account with domain-wide delegation,
// impersonating mail@clickworthytool.com. This is how cold outreach is sent
// (Resend's AUP forbids cold email; Gmail is also the mailbox Lemwarm warms)
// and how replies are read back.
//
// SETUP (Enrique's one-time Workspace tasks — see worker/README.md):
//   1. GCP: create a service account, enable the Gmail API, create a JSON key.
//   2. Workspace Admin > Security > API controls > Domain-wide delegation:
//      authorize the service account's client ID for these scopes:
//        https://www.googleapis.com/auth/gmail.send
//        https://www.googleapis.com/auth/gmail.readonly
//   3. Set env:
//        GMAIL_SENDER=mail@clickworthytool.com
//        GOOGLE_SERVICE_ACCOUNT_JSON=<the full JSON key, single line>
//
// Everything here is a no-op-until-configured: calls throw a clear error if the
// service account env isn't set, so the rest of the worker builds and runs.

import { JWT } from "google-auth-library";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];

let cachedClient: JWT | null = null;

function getClient(): JWT {
  if (cachedClient) return cachedClient;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sender = process.env.GMAIL_SENDER;
  if (!raw || !sender) {
    throw new Error(
      "Gmail is not configured — set GOOGLE_SERVICE_ACCOUNT_JSON and GMAIL_SENDER. " +
        "(Cold outreach + reply reading are disabled until then.)"
    );
  }

  let key: { client_email: string; private_key: string };
  try {
    key = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  cachedClient = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES,
    subject: sender, // impersonate the sending mailbox via domain-wide delegation
  });
  return cachedClient;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const client = getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Failed to obtain a Gmail access token");

  return fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

// Base64url-encode an RFC 2822 message for the Gmail send endpoint.
function encodeMessage(mime: string): string {
  return Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type SentMessage = { id: string; threadId: string };

// Sends a plaintext email. Returns Gmail's message + thread ids (stored so we
// can later match inbound replies back to the outreach they answer).
// Pass `threadId` + `inReplyTo` (the original RFC Message-ID) to reply in-thread.
// RFC 2047 encoded-word. MIME headers are 7-bit ASCII only, so a raw non-ASCII
// Subject ships as mojibake — "Mi Ranchito Taquería" arriving as "TaquerÃ­a",
// which reads as broken to the recipient AND is a spam signal. Body text is
// unaffected (it declares charset=UTF-8); this is a header-only problem.
//
// ASCII subjects are returned untouched, so the common case produces byte-for
// -byte the same header it always did. Base64 (?B?) over quoted-printable
// because it is trivially correct for arbitrary UTF-8 — no per-character
// escaping rules to get subtly wrong.
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  body: string;
  fromName?: string;
  threadId?: string;
  inReplyTo?: string | null;
}): Promise<SentMessage> {
  const sender = process.env.GMAIL_SENDER!;
  // Only the display name is encoded — the address itself must stay literal.
  // outreach_sender_name is operator-editable, so "Enrique Hernández" with the
  // accent is a realistic value and would otherwise garble the From line.
  const from = params.fromName ? `${encodeHeaderValue(params.fromName)} <${sender}>` : sender;

  const headers = [
    `From: ${from}`,
    `To: ${params.to}`,
    `Subject: ${encodeHeaderValue(params.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (params.inReplyTo) {
    headers.push(`In-Reply-To: ${params.inReplyTo}`, `References: ${params.inReplyTo}`);
  }
  const mime = [...headers, "", params.body].join("\r\n");

  const res = await authedFetch("/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: encodeMessage(mime), ...(params.threadId ? { threadId: params.threadId } : {}) }),
  });
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${await res.text()}`);

  const body = (await res.json()) as { id: string; threadId: string };
  return { id: body.id, threadId: body.threadId };
}

// Fetches a sent/received message's RFC 2822 Message-ID + Subject headers (for
// threading a reply via In-Reply-To, and for a correct "Re: ..." subject line —
// Gmail's own UI threads purely on threadId, but other mail clients still rely
// on Subject matching, so an empty/mismatched subject can break threading
// outside Gmail). Returns nulls if the message can't be fetched.
export async function getThreadingInfo(
  gmailMessageId: string
): Promise<{ messageId: string | null; subject: string | null }> {
  const res = await authedFetch(`/messages/${gmailMessageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject`);
  if (!res.ok) return { messageId: null, subject: null };
  const body = (await res.json()) as { payload?: { headers?: { name: string; value: string }[] } };
  const header = (name: string) => body.payload?.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? null;
  return { messageId: header("message-id"), subject: header("subject") };
}

// Fetches the RFC Message-ID + Subject of the NEWEST message in a thread —
// i.e. the customer's own reply, once they've written back. Replying with
// In-Reply-To pointing at their message (rather than at our original) is what
// makes Touch 2 read as a genuine answer to them instead of a new broadcast.
// Returns nulls if the thread can't be read, so callers can fall back to
// sending standalone rather than not sending at all.
export async function getThreadTail(
  threadId: string
): Promise<{ messageId: string | null; subject: string | null }> {
  const res = await authedFetch(
    `/threads/${threadId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject`
  );
  if (!res.ok) return { messageId: null, subject: null };
  const body = (await res.json()) as {
    messages?: { payload?: { headers?: { name: string; value: string }[] } }[];
  };
  const last = body.messages?.[body.messages.length - 1];
  if (!last) return { messageId: null, subject: null };
  const header = (name: string) =>
    last.payload?.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? null;
  return { messageId: header("message-id"), subject: header("subject") };
}

// --- Reply reading ---------------------------------------------------------

export type GmailMessageMeta = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
};

// Lists message ids newer than a given history id (incremental). On the first
// run (no historyId), falls back to listing recent inbox messages.
export async function listInboxMessages(query = "in:inbox newer_than:7d"): Promise<{ id: string; threadId: string }[]> {
  const res = await authedFetch(`/messages?q=${encodeURIComponent(query)}&maxResults=100`);
  if (!res.ok) throw new Error(`Gmail list failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { messages?: { id: string; threadId: string }[] };
  return body.messages ?? [];
}

type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
};

export type FetchedMessage = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  bodyText: string;
  imageAttachments: { attachmentId: string; filename: string; mimeType: string }[];
};

function header(headers: { name: string; value: string }[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function walkParts(part: GmailPart, acc: FetchedMessage) {
  const mime = part.mimeType ?? "";
  if (mime === "text/plain" && part.body?.data) {
    acc.bodyText += Buffer.from(part.body.data, "base64").toString("utf-8");
  }
  if (mime.startsWith("image/") && part.body?.attachmentId && part.filename) {
    acc.imageAttachments.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: mime,
    });
  }
  for (const child of part.parts ?? []) walkParts(child, acc);
}

export async function getMessage(id: string): Promise<FetchedMessage> {
  const res = await authedFetch(`/messages/${id}?format=full`);
  if (!res.ok) throw new Error(`Gmail get message failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as {
    id: string;
    threadId: string;
    payload: GmailPart;
  };

  const acc: FetchedMessage = {
    id: body.id,
    threadId: body.threadId,
    from: header(body.payload.headers, "From"),
    subject: header(body.payload.headers, "Subject"),
    bodyText: "",
    imageAttachments: [],
  };
  walkParts(body.payload, acc);
  return acc;
}

export async function getAttachmentBytes(messageId: string, attachmentId: string): Promise<Buffer> {
  const res = await authedFetch(`/messages/${messageId}/attachments/${attachmentId}`);
  if (!res.ok) throw new Error(`Gmail get attachment failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { data: string };
  return Buffer.from(body.data, "base64");
}
