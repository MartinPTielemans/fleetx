/**
 * Where a model request goes and what travels with it. Shared by the proxy on
 * every node and the relay's egress route, so both forward the same way.
 *
 * The boundary (docs/design/companion.md): the client's own request goes out
 * unchanged. Its credential, user-agent and version headers pass as they are;
 * only hop-by-hop headers are dropped, and the encoding is left to the HTTP
 * client, which decompresses, so the response loses its content-encoding.
 */
import type { ModelFailureClass } from "../Api.ts";
import type { UpstreamDef, Upstreams } from "./Recipes.ts";
import { header, legacyHeader } from "../Names.ts";

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
export const RELAY_TOKEN_HEADER = header("relay-token");
/** With egress through the relay, the upstream base the node resolved, for the relay to forward to. */
export const EGRESS_BASE_HEADER = header("egress-base");
/** Both, under their names and their fleetx names, which a node sends and the relay reads until 1.0. */
const OWN_HEADERS = new Set([RELAY_TOKEN_HEADER, EGRESS_BASE_HEADER, legacyHeader("relay-token"), legacyHeader("egress-base")]);

export const requestHeaders = (headers: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(lower) || OWN_HEADERS.has(lower)) continue;
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
 * neither. An upstream with a chatgpt_url sends the first there.
 */
export const isChatgptLogin = (headers: Readonly<Record<string, string | undefined>>) =>
  headers["chatgpt-account-id"] !== undefined || /^Bearer eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(headers["authorization"] ?? "");

export const baseFor = (upstream: UpstreamDef, headers: Readonly<Record<string, string | undefined>>) =>
  upstream.chatgptUrl !== undefined && isChatgptLogin(headers) ? upstream.chatgptUrl : upstream.url;

/** `/anthropic/v1/messages?beta=true` → the upstream's name and the rest of the path; null for a path with no name. */
export const splitPath = (url: string, prefix = ""): { upstream: string; rest: string } | null => {
  const m = new RegExp(`^${prefix}/([a-z0-9][a-z0-9-]*)(/[^?#]*)?(\\?[^#]*)?`).exec(url);
  if (m?.[1] === undefined) return null;
  return { upstream: m[1], rest: `${m[2] ?? ""}${m[3] ?? ""}` };
};

/** The full upstream URL for a request, or null when no upstream has that name. */
export const targetUrl = (upstreams: Upstreams, name: string, rest: string, headers: Readonly<Record<string, string | undefined>>) => {
  const upstream = upstreams[name];
  return upstream === undefined ? null : `${baseFor(upstream, headers)}${rest}`;
};

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
