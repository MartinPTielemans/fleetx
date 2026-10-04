/**
 * Giving Claude and Codex back their own MCP servers.
 *
 * An entry counts as T3 Fleet's only while it still is what T3 Fleet registers
 * for that server (the endpoint its definition resolves to, or the hub's URL
 * for it), or T3 Fleet's own `t3-fleet mcp`. With setup's snapshot, T3 Fleet's
 * entries give way to the user's entries from before setup, or are removed; an
 * entry the user changed since is left alone and reported. Without a
 * snapshot, only `t3-fleet mcp` goes.
 *
 * Both files are edited structurally and written whole, atomically: Claude's
 * ~/.claude.json as JSON, Codex's config.toml table by table (every other
 * line kept), and checked by parsing the result. Values never reach the plan
 * or a command line, as entries may hold tokens.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { resolveEndpoint, type Endpoint, type McpDesired } from "../areas/Mcp.ts";
import { CLI } from "../Names.ts";
import { editFile, isObject, prettyJson } from "./Files.ts";

type Json = Record<string, unknown>;
export type Client = "claude" | "codex";
const CLIENT_NAMES: Record<Client, string> = { claude: "Claude", codex: "Codex" };

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** What an entry is, without any of its values: "stdio (command, args, env)". */
export const describeEntry = (entry: unknown) => {
  if (!isObject(entry)) return "an entry";
  const kind =
    typeof entry["url"] === "string"
      ? "http"
      : typeof entry["command"] === "string"
        ? "stdio"
        : "other";
  return `${kind} (${Object.keys(entry).sort().join(", ")})`;
};

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : isObject(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v instanceof Date
        ? v.toISOString()
        : v;
export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// ---- Codex's config.toml, table by table ------------------------------------

/** The dotted key of a table header line (`[a."b c".d]`), or null for any other line. */
export const headerPath = (line: string): Array<string> | null => {
  const m = /^\s*\[\[?(.*?)\]\]?\s*(#.*)?$/.exec(line);
  if (m?.[1] === undefined) return null;
  const parts: Array<string> = [];
  let rest = m[1].trim();
  while (rest.length > 0) {
    let key: string;
    if (rest.startsWith('"')) {
      const end = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
      if (end?.[1] === undefined) return null;
      key = JSON.parse(`"${end[1]}"`) as string;
      rest = rest.slice(end[0].length);
    } else if (rest.startsWith("'")) {
      const end = /^'([^']*)'/.exec(rest);
      if (end?.[1] === undefined) return null;
      key = end[1];
      rest = rest.slice(end[0].length);
    } else {
      const end = /^[A-Za-z0-9_-]+/.exec(rest);
      if (end === null) return null;
      key = end[0];
      rest = rest.slice(end[0].length);
    }
    parts.push(key);
    rest = rest.trimStart();
    if (rest.startsWith(".")) rest = rest.slice(1).trimStart();
    else if (rest.length > 0) return null;
  }
  return parts;
};

/**
 * Codex's config with each named server replaced (an entry) or removed
 * (null): the server's tables are cut out, new ones appended, and every other
 * line stays as it was. Fails, changing nothing, when the result does not
 * parse to exactly the edit asked for (a server written as an inline table or
 * dotted keys elsewhere, say).
 */
export const editCodexServers = (text: string, edits: Readonly<Record<string, Json | null>>) => {
  const before = Effect.try(() => parseToml(text) as Json);
  return before.pipe(
    Effect.mapError(() => "~/.codex/config.toml is not valid TOML; it was left as it is"),
    Effect.flatMap((parsed) => {
      const names = new Set(Object.keys(edits));
      const kept: Array<string> = [];
      let cut: Array<string> = [];
      let cutting = false;
      for (const line of text.split("\n")) {
        const path = headerPath(line);
        if (path !== null) {
          const was = cutting;
          cutting = path[0] === "mcp_servers" && path[1] !== undefined && names.has(path[1]);
          // Comments and blank lines right before the next table belong to it.
          if (was && !cutting) {
            let i = cut.length;
            while (i > 0 && /^\s*(#.*)?$/.test(cut[i - 1] ?? "")) i--;
            kept.push(...cut.slice(i));
          }
          cut = [];
        }
        if (cutting) cut.push(line);
        else kept.push(line);
      }
      let result = kept.join("\n");
      const added = Object.entries(edits).filter((e): e is [string, Json] => e[1] !== null);
      if (added.length > 0) {
        const tables = stringifyToml({ mcp_servers: Object.fromEntries(added) }).trim();
        result = `${result.replace(/\n*$/, "")}${result.trim() === "" ? "" : "\n\n"}${tables}\n`;
      }
      const want = structuredClone(parsed);
      const servers = isObject(want["mcp_servers"]) ? { ...want["mcp_servers"] } : {};
      for (const [name, entry] of Object.entries(edits)) {
        if (entry === null) delete servers[name];
        else servers[name] = entry;
      }
      if (Object.keys(servers).length > 0 || isObject(want["mcp_servers"]))
        want["mcp_servers"] = servers;
      return Effect.try(() => parseToml(result) as Json).pipe(
        Effect.mapError(
          () =>
            "~/.codex/config.toml holds these servers in a form T3 Fleet does not edit (inline tables or dotted keys); edit it by hand",
        ),
        Effect.filterOrFail(
          (got) =>
            sameValue(
              { ...got, mcp_servers: isObject(got["mcp_servers"]) ? got["mcp_servers"] : {} },
              { ...want, mcp_servers: servers },
            ),
          () =>
            "~/.codex/config.toml holds these servers in a form T3 Fleet does not edit (inline tables or dotted keys); edit it by hand",
        ),
        Effect.as(result),
      );
    }),
  );
};

/** Claude's ~/.claude.json with each named server replaced or removed; keeps its layout's indent and final newline. */
export const editClaudeServers = (
  text: string | null,
  edits: Readonly<Record<string, Json | null>>,
) =>
  Effect.gen(function* () {
    const parsed = text === null ? Option.some({} as unknown) : decodeJson(text);
    if (Option.isNone(parsed) || !isObject(parsed.value))
      return yield* Effect.fail("~/.claude.json is not valid JSON; it was left as it is");
    const config = structuredClone(parsed.value);
    const servers = isObject(config["mcpServers"]) ? { ...config["mcpServers"] } : {};
    for (const [name, entry] of Object.entries(edits)) {
      if (entry === null) delete servers[name];
      else servers[name] = entry;
    }
    config["mcpServers"] = servers;
    return `${prettyJson(config)}${text === null || text.endsWith("\n") ? "\n" : ""}`;
  });

// ---- what is T3 Fleet's ---------------------------------------------------------

const Definition = Schema.Struct({
  kind: Schema.String,
  url: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  auth: Schema.optionalKey(
    Schema.Struct({ type: Schema.String, token_env: Schema.optionalKey(Schema.String) }),
  ),
});
const decodeDefinition = Schema.decodeUnknownOption(Schema.fromJsonString(Definition));

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** T3 Fleet's own MCP server (`t3-fleet mcp`). */
export const isSelf = (entry: unknown) =>
  isObject(entry) &&
  typeof entry["command"] === "string" &&
  basename(entry["command"]) === CLI &&
  Array.isArray(entry["args"]) &&
  entry["args"][0] === "mcp";

/** Whether an entry is still what T3 Fleet registers for `name`. */
export const isFleets = (
  entry: unknown,
  name: string,
  endpoint: Endpoint | null,
  gateway: string | null,
  home: string,
) => {
  if (!isObject(entry)) return false;
  const norm = (s: unknown) =>
    typeof s === "string" ? s.replace(/^(\$HOME|\$\{HOME\}|~)(?=\/)/, home) : s;
  const url = entry["url"];
  if (gateway !== null && url === `${gateway}/mcp/${name}`) return true;
  if (endpoint === null) return false;
  if (endpoint.type === "http") return url === endpoint.url;
  const args = Array.isArray(entry["args"]) ? entry["args"].map(norm) : [];
  return norm(entry["command"]) === endpoint.command && sameValue(args, endpoint.args.map(norm));
};

export interface McpChange {
  readonly client: Client;
  readonly name: string;
  /** The entry it gets back; null removes it. */
  readonly entry: Json | null;
  /** The plan saw no entry there. */
  readonly wasMissing: boolean;
  readonly line: string;
}

export interface McpPlan {
  readonly changes: ReadonlyArray<McpChange>;
  readonly notes: ReadonlyArray<string>;
  /** Whether an entry is still T3 Fleet's, asked again right before it is changed. */
  readonly owned: (client: Client, name: string, entry: unknown) => boolean;
}

/** Claude's and Codex's user-level servers, as they are now. */
export const readRegistrations = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const claudeText = yield* fs.readFileString(`${home}/.claude.json`).pipe(Effect.option);
    const claudeJson = Option.isSome(claudeText)
      ? Option.getOrUndefined(decodeJson(claudeText.value))
      : undefined;
    const codexText = yield* fs.readFileString(`${home}/.codex/config.toml`).pipe(Effect.option);
    const codexToml = Option.isSome(codexText)
      ? yield* Effect.try(() => parseToml(codexText.value) as Json).pipe(
          Effect.orElseSucceed(() => ({}) as Json),
        )
      : {};
    return {
      claude: (isObject(claudeJson) && isObject(claudeJson["mcpServers"])
        ? claudeJson["mcpServers"]
        : {}) as Json,
      codex: (isObject(codexToml["mcp_servers"]) ? codexToml["mcp_servers"] : {}) as Json,
    };
  });

export const planMcp = (
  home: string,
  repo: string,
  table: Json,
  snapshot: {
    readonly claude: Readonly<Record<string, Json>>;
    readonly codex: Readonly<Record<string, Json>>;
  } | null,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mcp = (isObject(table["mcp"]) ? table["mcp"] : {}) as McpDesired & Json;
    const declared = Array.isArray(mcp?.servers)
      ? mcp.servers.filter((s): s is string => typeof s === "string")
      : [];
    const gateway = typeof mcp?.gateway === "string" ? mcp.gateway.replace(/\/+$/, "") : null;
    const endpoints = new Map<string, Endpoint | null>();
    for (const name of declared) {
      const text = yield* fs
        .readFileString(path.join(repo, "mcp", `${name}.json`))
        .pipe(Effect.option);
      const def = Option.isSome(text) ? decodeDefinition(text.value) : Option.none();
      endpoints.set(
        name,
        Option.isSome(def) ? resolveEndpoint(name, def.value, mcp, home).endpoint : null,
      );
    }
    const owned = (_client: Client, name: string, entry: unknown) =>
      isSelf(entry) ||
      (declared.includes(name) &&
        isFleets(entry, name, endpoints.get(name) ?? null, gateway, home));
    const current = yield* readRegistrations(home);
    const changes: Array<McpChange> = [];
    const notes: Array<string> = [];
    for (const client of ["claude", "codex"] as const) {
      const who = CLIENT_NAMES[client];
      const now = current[client];
      const fleets = (name: string) => owned(client, name, now[name]);
      if (snapshot === null) {
        for (const name of Object.keys(now).filter((n) => isSelf(now[n])))
          changes.push({
            client,
            name,
            entry: null,
            wasMissing: false,
            line: `${who}: remove ${name} (T3 Fleet's own server, which cannot work once this machine has left)`,
          });
        const viaHub = declared.filter(
          (n) => gateway !== null && isObject(now[n]) && now[n]["url"] === `${gateway}/mcp/${n}`,
        );
        if (viaHub.length > 0)
          notes.push(
            `MCP: ${viaHub.join(", ")} in ${who} go through the fleet's hub; they work only while the relay runs and accepts this machine's token`,
          );
        continue;
      }
      const before = snapshot[client];
      for (const name of new Set([
        ...declared,
        ...Object.keys(now).filter((n) => isSelf(now[n])),
      ])) {
        const was = before[name];
        const is = now[name];
        if (is === undefined) {
          if (was !== undefined)
            changes.push({
              client,
              name,
              entry: was,
              wasMissing: true,
              line: `${who}: ${name} gets back its entry from before setup, ${describeEntry(was)}`,
            });
          continue;
        }
        if (was !== undefined && sameValue(is, was)) continue;
        if (!fleets(name)) {
          notes.push(
            `MCP: ${name} in ${who} was changed since T3 Fleet registered it, so it is left as it is`,
          );
          continue;
        }
        changes.push(
          was === undefined
            ? {
                client,
                name,
                entry: null,
                wasMissing: false,
                line: `${who}: remove ${name} (T3 Fleet's ${describeEntry(is)})`,
              }
            : {
                client,
                name,
                entry: was,
                wasMissing: false,
                line: `${who}: ${name} goes back to its entry from before setup, ${describeEntry(was)}`,
              },
        );
      }
    }
    if (snapshot === null)
      notes.unshift(
        "MCP: no setup snapshot here (this machine joined before `t3-fleet setup`), so Claude's and Codex's registrations are kept; they keep working without T3 Fleet",
      );
    return { changes, notes, owned } satisfies McpPlan;
  });

/**
 * Writes the changes, checking each against the file as it is now: a server
 * that is no longer what the plan saw is left alone.
 */
export const applyMcp = (home: string, plan: McpPlan) =>
  Effect.gen(function* () {
    const done: Array<string> = [];
    for (const client of ["claude", "codex"] as const) {
      const mine = plan.changes.filter((c) => c.client === client);
      if (mine.length === 0) continue;
      const file = client === "claude" ? `${home}/.claude.json` : `${home}/.codex/config.toml`;
      let applied: Array<string> = [];
      let skipped: Array<string> = [];
      yield* editFile(
        file,
        (text) =>
          Effect.gen(function* () {
            const config =
              text === null
                ? {}
                : client === "claude"
                  ? (Option.getOrUndefined(decodeJson(text)) ?? {})
                  : yield* Effect.try(() => parseToml(text) as Json).pipe(
                      Effect.orElseSucceed(() => ({}) as Json),
                    );
            const key = client === "claude" ? "mcpServers" : "mcp_servers";
            const servers = isObject(config) && isObject(config[key]) ? config[key] : {};
            const edits: Record<string, Json | null> = {};
            applied = [];
            skipped = [];
            for (const c of mine) {
              const is = servers[c.name];
              if (is === undefined ? c.entry === null : sameValue(is, c.entry)) continue;
              // What the plan saw missing came back, or what was T3 Fleet's is someone's now.
              if (
                is === undefined ? !c.wasMissing : c.wasMissing || !plan.owned(client, c.name, is)
              ) {
                skipped.push(c.name);
                continue;
              }
              edits[c.name] = c.entry;
              applied.push(c.name);
            }
            if (Object.keys(edits).length === 0) return null;
            return client === "claude"
              ? yield* editClaudeServers(text, edits)
              : yield* editCodexServers(text ?? "", edits);
          }),
        // A config holding tokens is created private.
        { mode: 0o600 },
      );
      if (applied.length > 0) done.push(`${CLIENT_NAMES[client]}: ${applied.join(", ")}`);
      if (skipped.length > 0)
        done.push(`${CLIENT_NAMES[client]}: left alone, changed meanwhile: ${skipped.join(", ")}`);
    }
    return done;
  });
