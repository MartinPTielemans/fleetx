/**
 * On a machine set up already, its clients hold what the mcp area
 * registered for the fleet's definitions: a hosted server as the gateway's
 * URL with the relay token, a stdio server with its home expanded and its
 * secrets filled in. Read back, such an entry looks like a different server;
 * it is the fleet's own. This tells them apart by rendering, for each
 * definition, the entry the mcp area would write here (its own functions),
 * and comparing.
 */
import { claudeEntry, codexStdio, resolveEndpoint, type McpDesired } from "../areas/Mcp.ts";
import type { FoundServer } from "./Discover.ts";

type Definition = Parameters<typeof resolveEndpoint>[1];

const asTable = (v: unknown): Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The fleet's own registrations on this machine: `(server) => whether its entry is one`. */
export const registeredByFleet = (input: {
  readonly servers: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  /** This machine's merged `[mcp]` settings. */
  readonly mcp: Readonly<Record<string, unknown>>;
  readonly home: string;
  /** The machine's secrets, then its environment. */
  readonly value: (name: string) => string | undefined;
}) => {
  const path = (p: unknown) =>
    typeof p === "string"
      ? p.replace(/^\$HOME(?=\/|$)/, input.home).replace(/^~(?=\/|$)/, input.home)
      : p;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return (server: FoundServer): boolean => {
    if (server.project !== null) return false;
    const definition = input.servers.get(server.name);
    if (definition === undefined) return false;
    const resolved = resolveEndpoint(
      server.name,
      definition as Definition,
      input.mcp as McpDesired,
      input.home,
    );
    if (resolved.endpoint === null) return false;
    const endpoint = resolved.endpoint;
    const e = server.entry;
    if (server.client === "claude") {
      const want = claudeEntry(endpoint, input.value).entry;
      const type =
        typeof e["type"] === "string" ? e["type"] : e["url"] !== undefined ? "http" : "stdio";
      if (type !== want.type) return false;
      if (want.url !== undefined && e["url"] !== want.url) return false;
      if (want.command !== undefined && path(e["command"]) !== path(want.command)) return false;
      if (
        want.args !== undefined &&
        !same(((e["args"] as Array<unknown> | undefined) ?? []).map(path), want.args.map(path))
      )
        return false;
      const env = asTable(e["env"]);
      const headers = asTable(e["headers"]);
      return (
        Object.entries(want.env ?? {}).every(([k, v]) => env[k] === v) &&
        Object.entries(want.headers ?? {}).every(([k, v]) => headers[k] === v)
      );
    }
    if (endpoint.type === "http")
      return e["url"] === endpoint.url && (e["bearer_token_env_var"] ?? null) === endpoint.tokenEnv;
    const run = codexStdio(endpoint);
    return (
      path(e["command"]) === path(run.command) &&
      same(((e["args"] as Array<unknown> | undefined) ?? []).map(path), run.args.map(path))
    );
  };
};
