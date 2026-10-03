/**
 * Where a model request goes and what travels with it. Shared by the proxy on
 * every node and the relay's egress route, so both forward the same way.
 *
 * The boundary (docs/design/companion.md): the client's own request goes out
 * unchanged. Its credential, user-agent and version headers pass as they are;
 * only hop-by-hop headers are dropped, and the encoding is left to the HTTP
 * client, which decompresses, so the response loses its content-encoding.
 */
import type { ModelFailureClass, ModelUpstream } from "../Api.ts";

export interface Upstreams {
  readonly anthropic: string;
  /** Codex with an API key. */
  readonly openaiApi: string;
  /** Codex with a ChatGPT login. */
  readonly openaiChatgpt: string;
}

export const UPSTREAMS: Upstreams = {
  anthropic: "https://api.anthropic.com",
  openaiApi: "https://api.openai.com/v1",
  openaiChatgpt: "https://chatgpt.com/backend-api/codex",
};

/** Headers that describe one connection, not the request (RFC 9110 §7.6.1), plus what the client re-derives. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
]);

/** The relay token travels in its own header, so the client's Authorization passes untouched. */
export const RELAY_TOKEN_HEADER = "x-fleetx-relay-token";

export const requestHeaders = (headers: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(lower) || lower === RELAY_TOKEN_HEADER) continue;
    out[lower] = value;
  }
  return out;
};

/** The response's headers for the client; content-encoding goes because the body arrives decoded. */
export const responseHeaders = (headers: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(lower) || lower === "content-encoding" || lower === "content-type") continue;
    out[lower] = value;
  }
  return out;
};

/**
 * Codex is pointed at the proxy with `-c openai_base_url=…`, which keeps its
 * built-in provider for both logins, so the proxy has to tell them apart: a
 * ChatGPT login sends `chatgpt-account-id` and a JWT bearer, an API key
 * neither. The built-in provider uses chatgpt.com/backend-api/codex for the
 * first and api.openai.com/v1 for the second.
 */
export const openaiBase = (headers: Readonly<Record<string, string | undefined>>, upstreams: Upstreams = UPSTREAMS) =>
  headers["chatgpt-account-id"] !== undefined || /^Bearer eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(headers["authorization"] ?? "")
    ? upstreams.openaiChatgpt
    : upstreams.openaiApi;

/** `/anthropic/v1/messages?beta=true` → the upstream and the rest of the path; null for any other path. */
export const splitPath = (url: string, prefix = ""): { upstream: ModelUpstream; rest: string } | null => {
  const m = new RegExp(`^${prefix}/(anthropic|openai)(/[^?#]*)?(\\?[^#]*)?`).exec(url);
  if (m === null) return null;
  return { upstream: m[1] as ModelUpstream, rest: `${m[2] ?? ""}${m[3] ?? ""}` };
};

export const targetUrl = (upstream: ModelUpstream, rest: string, headers: Readonly<Record<string, string | undefined>>, upstreams: Upstreams = UPSTREAMS) =>
  `${upstream === "anthropic" ? upstreams.anthropic : openaiBase(headers, upstreams)}${rest}`;

/** The path for the log: no query string, which can carry anything. */
export const logPath = (rest: string) => rest.split("?")[0] ?? "";

// ---- retries ---------------------------------------------------------------

/** Statuses worth another attempt, before the first byte has reached the client. */
export const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
export const MAX_RETRIES = 3;
export const MAX_RETRY_AFTER_MS = 30_000;

export const failureClassOf = (status: number): ModelFailureClass | null =>
  status === 429 ? "429" : status === 529 ? "529" : status >= 500 ? "5xx" : status >= 400 ? "4xx" : null;

/** `retry-after` as milliseconds: delta-seconds or an HTTP date; null when absent or unreadable. */
export const retryAfterMs = (value: string | undefined, now: number): number | null => {
  if (value === undefined || value.trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
};

/**
 * What to do after an attempt that has not sent the client anything: wait
 * this many ms and try again, or give up (null) and pass the answer on.
 * `random` is in [0, 1), for jitter.
 */
export const retryDelay = (input: {
  readonly attempt: number;
  readonly status: number | null;
  readonly retryAfter: number | null;
  readonly random: number;
  readonly maxRetries?: number | undefined;
  readonly baseMs?: number | undefined;
}): number | null => {
  if (input.attempt >= (input.maxRetries ?? MAX_RETRIES)) return null;
  if (input.status !== null && !RETRY_STATUSES.has(input.status)) return null;
  if (input.retryAfter !== null && input.retryAfter > MAX_RETRY_AFTER_MS) return null;
  const backoff = (input.baseMs ?? 500) * 2 ** input.attempt * (0.5 + input.random);
  return Math.round(Math.max(backoff, input.retryAfter ?? 0));
};

// ---- server-sent events ----------------------------------------------------

export const KEEPALIVE = ": keepalive\n\n";

/** Whether bytes sent so far end between two events, where a comment line may go. */
export const endsAtEventBoundary = (tail: string) => tail === "" || tail.endsWith("\n\n") || tail.endsWith("\r\n\r\n") || tail.endsWith("\r\r");
