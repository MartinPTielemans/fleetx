/**
 * The little of JSON-RPC and server-sent events the hub needs to look into
 * MCP traffic: which requests a POST carries (for policy and the call log),
 * and which responses come back, whether as a JSON body or as SSE frames.
 *
 * Messages stay loosely typed on purpose: the hub forwards whatever a client
 * and a server say to each other and only reads ids, methods, tool names and
 * error messages. It never keeps arguments or results.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: JsonRpcId | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Parse JSON text; undefined when it is not JSON. */
export const parseJson = (text: string): unknown => Option.getOrUndefined(decodeJson(text));

/** Serialize a value as JSON text. */
export const toJson = (value: unknown): string => Option.getOrElse(encodeJson(value), () => "null");

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

const asMessage = (u: unknown): JsonRpcMessage | null =>
  isRecord(u) ? (u as JsonRpcMessage) : null;

/** The messages in a POST body: one message, or a batch. Null when the body is not JSON-RPC. */
export const parseMessages = (
  body: string,
): { readonly batch: boolean; readonly messages: ReadonlyArray<JsonRpcMessage> } | null => {
  const value = parseJson(body);
  if (Array.isArray(value)) {
    const messages = value.map(asMessage);
    return messages.every((m) => m !== null) && messages.length > 0
      ? { batch: true, messages: messages as Array<JsonRpcMessage> }
      : null;
  }
  const message = asMessage(value);
  return message === null ? null : { batch: false, messages: [message] };
};

const hasId = (m: JsonRpcMessage) => m.id !== undefined && m.id !== null;

export const isRequest = (m: JsonRpcMessage): boolean => typeof m.method === "string" && hasId(m);
export const isNotification = (m: JsonRpcMessage): boolean =>
  typeof m.method === "string" && !hasId(m);
export const isResponse = (m: JsonRpcMessage): boolean =>
  m.method === undefined && hasId(m) && ("result" in m || "error" in m);

const CANONICAL_KEYS: ReadonlyArray<string> = ["jsonrpc", "id", "method", "params"];

/**
 * A key as Go's encoding/json compares it when no key matches exactly: case
 * folded, with the four non-ASCII letters it folds to ASCII (ſ to s, ı and İ
 * to i, the Kelvin sign to k) folded too.
 */
export const foldKey = (key: string) =>
  key
    .replace(/[\u017f\u0131\u0130\u212a]/g, (c) =>
      c === "\u017f" ? "s" : c === "\u212a" ? "k" : "i",
    )
    .toLowerCase();

/**
 * A key that folds to one the hub reads (jsonrpc, id, method, params,
 * params.name) without being it, or null. Some servers (Go's encoding/json)
 * match keys that way, last one winning, so `{"name":"ok","Name":
 * "delete_repo"}` or `"paramſ"` beside `"params"` would show the policy one
 * tool and the server another.
 */
export const caseVariantKey = (m: JsonRpcMessage): string | null => {
  for (const key of Object.keys(m))
    if (CANONICAL_KEYS.includes(foldKey(key)) && !CANONICAL_KEYS.includes(key)) return key;
  if (isRecord(m.params))
    for (const key of Object.keys(m.params))
      if (foldKey(key) === "name" && key !== "name") return `params.${key}`;
  return null;
};

/**
 * The message rebuilt from its JSON-RPC fields alone: jsonrpc, id, method and
 * params for a request or notification, jsonrpc, id, result and error for a
 * response. What the hub forwards, so a key it did not read never reaches a
 * server, however that server matches keys.
 */
export const rebuildMessage = (m: JsonRpcMessage): JsonRpcMessage => {
  const keys =
    typeof m.method === "string"
      ? ["jsonrpc", "id", "method", "params"]
      : ["jsonrpc", "id", "result", "error"];
  const out: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(m, key)) out[key] = (m as Record<string, unknown>)[key];
  return out as JsonRpcMessage;
};

/** The tool a `tools/call` request names, or null. */
export const toolOf = (m: JsonRpcMessage): string | null => {
  if (m.method !== "tools/call" || !isRecord(m.params)) return null;
  const name = m.params["name"];
  return typeof name === "string" ? name : null;
};

export const errorMessage = (
  id: JsonRpcId | null,
  code: number,
  message: string,
): JsonRpcMessage => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** The key two ids compare equal under: 1 and "1" are different ids. */
export const idKey = (id: JsonRpcId): string => `${typeof id}:${String(id)}`;

// ── server-sent events ──────────────────────────────────────────────────

export interface SseEvent {
  readonly event: string | null;
  readonly id: string | null;
  readonly data: string;
}

export const sseFrame = (
  data: string,
  options?: { readonly event?: string; readonly id?: string },
): string =>
  `${options?.id === undefined ? "" : `id: ${options.id}\n`}${options?.event === undefined ? "" : `event: ${options.event}\n`}${data
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n")}\n\n`;

/** An incremental SSE parser: push text as it arrives, get the complete events. */
export const makeSseParser = () => {
  let buffer = "";
  return (text: string): ReadonlyArray<SseEvent> => {
    buffer += text.replace(/\r\n?/g, "\n");
    const events: Array<SseEvent> = [];
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event: string | null = null;
      let id: string | null = null;
      const data: Array<string> = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") data.push(value);
        else if (field === "event") event = value;
        else if (field === "id") id = value;
      }
      if (data.length > 0 || event !== null) events.push({ event, id, data: data.join("\n") });
    }
    return events;
  };
};

export const isEventStream = (contentType: string | undefined) =>
  (contentType ?? "").toLowerCase().includes("text/event-stream");

/** Every JSON-RPC message in a complete response body, JSON or SSE. */
export const messagesInBody = (
  contentType: string | undefined,
  text: string,
): ReadonlyArray<JsonRpcMessage> => {
  const chunks = isEventStream(contentType)
    ? makeSseParser()(`${text}\n\n`).map((e) => e.data)
    : [text];
  const out: Array<JsonRpcMessage> = [];
  for (const chunk of chunks) {
    const parsed = parseMessages(chunk);
    if (parsed !== null) out.push(...parsed.messages);
  }
  return out;
};
