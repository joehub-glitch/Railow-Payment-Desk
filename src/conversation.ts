// Ties a rider's verification to the chat it happened in, so they verify once per conversation.
//
// Chord (not the model) sends the conversation identifier with each tool call. We read it from the
// request, keep it for the duration of that request, and store verification under a hash of it.
// The model cannot set or change it, so another chat can never reuse this chat's verification.
//
// Where the identifier lives is set with CONVERSATION_KEY, e.g. "header:x-chord-conversation-id" or
// "meta:conversationId". When unset, a few common names are tried; if none is present nothing
// changes and the rider's session value is used as before.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Request } from "express";

const als = new AsyncLocalStorage<{ key: string | null; source: string | null }>();

const CANDIDATE_HEADERS = [
  "x-chord-conversation-id", "x-conversation-id", "x-chord-thread-id", "x-thread-id",
  "x-chord-session-id", "x-chat-id", "x-chord-chat-id",
];
const CANDIDATE_META = ["conversationId", "conversation_id", "threadId", "thread_id", "chatId", "chat_id"];

function pick(req: Request): { value: string; source: string } | null {
  const meta = ((req.body as { params?: { _meta?: Record<string, unknown> } })?.params?._meta ?? {}) as Record<string, unknown>;
  const configured = (process.env.CONVERSATION_KEY ?? "").trim();
  if (configured) {
    const [kind, ...rest] = configured.split(":");
    const name = rest.join(":").trim();
    const v = kind === "header" ? req.headers[name.toLowerCase()] : kind === "meta" ? meta[name] : undefined;
    const s = Array.isArray(v) ? v[0] : v;
    return s ? { value: String(s), source: configured } : null;
  }
  for (const h of CANDIDATE_HEADERS) {
    const v = req.headers[h];
    if (v) return { value: String(Array.isArray(v) ? v[0] : v), source: `header:${h}` };
  }
  for (const m of CANDIDATE_META) {
    if (meta[m]) return { value: String(meta[m]), source: `meta:${m}` };
  }
  return null;
}

/** Runs fn with the conversation of this request available to the domain code. */
export function withConversation<T>(req: Request, fn: () => T): T {
  const p = pick(req);
  const key = p ? createHash("sha256").update(`conv:${p.value}`).digest("hex").slice(0, 32) : null;
  return als.run({ key, source: p?.source ?? null }, fn);
}

/** Hashed conversation key for this tool call, or null if Chord sent none. */
export const conversationKey = () => als.getStore()?.key ?? null;
export const conversationSource = () => als.getStore()?.source ?? null;
