/**
 * Where a model request goes and what travels with it. Shared by the proxy on
 * every node and the relay's egress route, so both forward the same way.
 *
 * The boundary (docs/design/companion.md): the client's own request goes out
 * unchanged. Its credential, user-agent and version headers pass as they are;
 * only hop-by-hop headers are dropped. Accept-encoding goes too, so upstreams
 * answer uncompressed and the proxy can put keepalives between events; a
 * response that comes compressed anyway passes through as it is.
 */
import type { ModelFailureClass } from "../Api.ts";
import { own, type UpstreamDef, type Upstreams } from "./Recipes.ts";
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
/**
 * On the relay's answer when it did not get one from the upstream: the
 * network error's code, or "refused" when the relay itself would not forward
 * (wrong token, an upstream it does not serve). The node reads it as its own
 * network error, never as the upstream's answer.
 */
export const EGRESS_FAILURE_HEADER = header("egress-failure");
/** Both, under their names and their fleetx names, which a node sends and the relay reads until 1.0. */
const OWN_HEADERS = new Set([
  RELAY_TOKEN_HEADER,
  EGRESS_BASE_HEADER,
  EGRESS_FAILURE_HEADER,
  legacyHeader("relay-token"),
  legacyHeader("egress-base"),
]);

export const requestHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(lower) || OWN_HEADERS.has(lower)) continue;
    out[lower] = value;
  }
  return out;
};

/** The response's headers for the client; content-type travels separately. */
export const responseHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP.has(lower) ||
      OWN_HEADERS.has(lower) ||
      lower === "content-type"
    )
      continue;
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
  headers["chatgpt-account-id"] !== undefined ||
  /^Bearer eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(headers["authorization"] ?? "");

export const baseFor = (
  upstream: UpstreamDef,
  headers: Readonly<Record<string, string | undefined>>,
) =>
  upstream.chatgptUrl !== undefined && isChatgptLogin(headers) ? upstream.chatgptUrl : upstream.url;

/** `/anthropic/v1/messages?beta=true` → the upstream's name and the rest of the path; null for a path with no name. */
export const splitPath = (url: string, prefix = ""): { upstream: string; rest: string } | null => {
  const m = new RegExp(`^${prefix}/([a-z0-9][a-z0-9-]*)(/[^?#]*)?(\\?[^#]*)?`).exec(url);
  if (m?.[1] === undefined) return null;
  return { upstream: m[1], rest: `${m[2] ?? ""}${m[3] ?? ""}` };
};

/** The full upstream URL for a request, or null when no upstream has that name. */
export const targetUrl = (
  upstreams: Upstreams,
  name: string,
  rest: string,
  headers: Readonly<Record<string, string | undefined>>,
) => {
  const upstream = own(upstreams, name);
  return upstream === undefined ? null : `${baseFor(upstream, headers)}${rest}`;
};

/** The path for the log: no query string, which can carry anything. */
export const logPath = (rest: string) => rest.split("?")[0] ?? "";

// ---- retries ---------------------------------------------------------------

/** Statuses worth another attempt, before the first byte has reached the client. */
export const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
export const MAX_RETRIES = 3;
/**
 * The most the proxy waits between attempts, all of them together. The CLIs
 * retry on their own after that, so the proxy only covers the short blips
 * and never keeps a client waiting long in silence.
 */
export const MAX_RETRY_WAIT_MS = 10_000;

export const failureClassOf = (status: number): ModelFailureClass | null =>
  status === 429
    ? "429"
    : status === 529
      ? "529"
      : status >= 500
        ? "5xx"
        : status >= 400
          ? "4xx"
          : null;

/** `retry-after` as milliseconds: delta-seconds or an HTTP date; null when absent or unreadable. */
export const retryAfterMs = (value: string | undefined, now: number): number | null => {
  if (value === undefined || value.trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
};

/** How long a response asks to wait: `retry-after-ms` (as Anthropic sends it) first, then `retry-after`. */
export const retryAfterOf = (
  headers: Readonly<Record<string, string | undefined>>,
  now: number,
): number | null => {
  const ms = Number(headers["retry-after-ms"] ?? "");
  return headers["retry-after-ms"] !== undefined && Number.isFinite(ms) && ms >= 0
    ? ms
    : retryAfterMs(headers["retry-after"], now);
};

/**
 * What to do after an attempt that has not sent the client anything: wait
 * this many ms and try again, or give up (null) and pass the answer on.
 * `shouldRetry` is the response's `x-should-retry`, which the CLIs obey
 * before anything else, and so does the proxy. `waited` is what earlier
 * retries of this request already waited. `random` is in [0, 1), for jitter.
 */
export const retryDelay = (input: {
  readonly attempt: number;
  readonly status: number | null;
  readonly retryAfter: number | null;
  readonly shouldRetry?: string | undefined;
  readonly waited?: number | undefined;
  readonly random: number;
  readonly maxRetries?: number | undefined;
  readonly baseMs?: number | undefined;
}): number | null => {
  if (input.attempt >= (input.maxRetries ?? MAX_RETRIES)) return null;
  const should = input.shouldRetry?.trim().toLowerCase();
  if (should === "false") return null;
  if (input.status !== null && !RETRY_STATUSES.has(input.status) && should !== "true") return null;
  const backoff = (input.baseMs ?? 500) * 2 ** input.attempt * (0.5 + input.random);
  const delay = Math.round(Math.max(backoff, input.retryAfter ?? 0));
  return (input.waited ?? 0) + delay > MAX_RETRY_WAIT_MS ? null : delay;
};

// ---- network errors --------------------------------------------------------

/**
 * The code of a network error ("ECONNREFUSED", "UND_ERR_HEADERS_TIMEOUT"),
 * the outermost one in its chain of causes; null when it has none.
 */
export const errorCode = (error: unknown): string | null => {
  let at: unknown = error;
  for (let depth = 0; depth < 8 && typeof at === "object" && at !== null; depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
    const next = at as { reason?: unknown; cause?: unknown };
    at = next.reason ?? next.cause;
  }
  return null;
};

/** Failures before the request left this machine: sending it again cannot repeat it. */
const NEVER_SENT = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  "refused",
]);

/**
 * Whether a request that failed with this code never reached the upstream:
 * refused, unresolvable, unreachable, a connect timeout, a failed TLS
 * handshake. Anything else (a reset, a timeout waiting for the answer) may
 * have been received, and a POST must not go twice.
 */
export const neverSent = (code: string | null) =>
  code !== null && (NEVER_SENT.has(code) || /^ERR_(SSL|TLS)_/.test(code) || code === "EPROTO");

/** Codes that mean the upstream was too slow, not unreachable. */
export const isTimeoutCode = (code: string | null) =>
  code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT";

// ---- server-sent events ----------------------------------------------------

export const KEEPALIVE = ": keepalive\n\n";

/** Whether bytes sent so far end between two events, where a comment line may go. */
export const endsAtEventBoundary = (tail: string) =>
  tail === "" || tail.endsWith("\n\n") || tail.endsWith("\r\n\r\n") || tail.endsWith("\r\r");
