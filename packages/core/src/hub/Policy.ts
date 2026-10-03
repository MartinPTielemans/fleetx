/**
 * Who may use the gateway, and which tools they may call.
 *
 * Tokens are compared by their SHA-256 digests in constant time, so neither
 * the relay token nor a client token leaks through response timing, and the
 * relay keeps only digests of client tokens. Randomness and hashing come from
 * Web Crypto, available in Node 24.
 */
import * as Effect from "effect/Effect";

import { sha256 } from "../Hash.ts";

/** Tool names longer than this are refused, never matched: patterns stay cheap and log records short. */
export const MAX_TOOL_NAME = 128;

const escapeRegExp = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * A server's deny patterns as one matcher, compiled once (`*` matches any run
 * of characters). Over-long names count as denied: fail closed.
 */
export const compileDeny = (deny: ReadonlyArray<string>): ((tool: string) => boolean) => {
  if (deny.length === 0) return (tool) => tool.length > MAX_TOOL_NAME;
  const pattern = new RegExp(`^(?:${deny.map((p) => p.split("*").map(escapeRegExp).join(".*")).join("|")})$`);
  return (tool) => tool.length > MAX_TOOL_NAME || pattern.test(tool);
};

/** Whether a tool matches any deny pattern. Compile with `compileDeny` where it is called often. */
export const isDenied = (deny: ReadonlyArray<string>, tool: string) => compileDeny(deny)(tool);

/** Equal-length strings compared without an early exit. */
export const constantTimeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export const hashToken = (token: string) => Effect.promise(() => sha256(token));

/** The token in an `Authorization: Bearer …` header, or null. */
export const bearerOf = (header: string | undefined) => {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m?.[1] ?? null;
};

/** Whether the header carries exactly `token`, compared by digest in constant time. */
export const bearerMatches = (header: string | undefined, token: string) =>
  Effect.gen(function* () {
    const given = bearerOf(header);
    if (given === null || token === "") return false;
    return constantTimeEqual(yield* hashToken(given), yield* hashToken(token));
  });

export const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** A fresh secret: 32 random bytes, base64url. */
export const randomSecret = () => base64url(randomBytes(32));

/** A new client token; the prefix makes it recognizable in a secrets file. */
export const newClientToken = () => `fxh_${randomSecret()}`;

/** SHA-256 as base64url, for PKCE. */
export const sha256Base64url = (text: string) =>
  Effect.promise(async () => base64url(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))));
