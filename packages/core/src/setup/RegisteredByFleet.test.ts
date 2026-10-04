import { describe, expect, it } from "vite-plus/test";

import { claudeEntry, codexStdio, resolveEndpoint } from "../areas/Mcp.ts";
import { fromClaude, fromCodex, secretNamer } from "./Credentials.ts";
import type { Discovery, FoundServer } from "./Discover.ts";
import { buildPlan, EMPTY_FLEET, type FleetView } from "./Plan.ts";
import { registeredByFleet } from "./RegisteredByFleet.ts";

const HOME = "/home/u";
const secrets: Record<string, string> = {
  T3_FLEET_RELAY_TOKEN: "relay-token-value-0123456789abcdef",
  CTX_API_KEY: "ctx-key-value-0123456789abcdef",
};
const definitions = new Map<string, Record<string, unknown>>([
  ["fetch", { kind: "remote", url: "https://fetch.example/mcp" }],
  ["t3-fleet", { kind: "stdio", command: "~/.local/bin/t3-fleet", args: ["mcp"] }],
  ["ctx", { kind: "stdio", command: "npx", args: ["ctx"], env: { CTX_API_KEY: "$CTX_API_KEY" } }],
]);
const mcp = {
  servers: ["fetch", "t3-fleet", "ctx"],
  hub: true,
  gateway: "https://relay.example:8399",
};

/** What the mcp area registers in each client for a definition, read back as discovery reads it. */
const registered = (name: string, client: "claude" | "codex"): FoundServer => {
  const resolved = resolveEndpoint(name, definitions.get(name) as never, mcp, HOME);
  if (resolved.endpoint === null) throw new Error(resolved.problem);
  const e = resolved.endpoint;
  let entry: Record<string, unknown>;
  if (client === "claude") {
    entry = { ...claudeEntry(e, (n) => secrets[n]).entry };
    // Older registrations wrote the home as $HOME.
    if (typeof entry["command"] === "string")
      entry["command"] = entry["command"].replace(HOME, "$HOME");
  } else if (e.type === "http")
    entry = { url: e.url, ...(e.tokenEnv === null ? {} : { bearer_token_env_var: e.tokenEnv }) };
  else {
    const run = codexStdio(e);
    entry = { command: run.command, args: run.args, env: run.env };
  }
  const ctx = { home: HOME, env: {}, name: secretNamer([]) };
  return {
    name,
    client,
    project: null,
    entry,
    extracted: (client === "claude" ? fromClaude(name, entry, ctx) : fromCodex(name, entry, ctx))!,
  };
};

describe("setup on a machine set up already", () => {
  const servers = ["fetch", "t3-fleet", "ctx"].flatMap((n) => [
    registered(n, "claude"),
    registered(n, "codex"),
  ]);
  const found: Discovery = {
    node: "laptop",
    skills: [],
    plugins: [],
    servers,
    instructions: [],
    t3: { running: false, version: null, channel: null, providers: [] },
    agents: [],
    raw: { claude: null, codex: null },
    unreadable: [],
  };
  const fleet: FleetView = { ...EMPTY_FLEET, servers: definitions, declared: mcp.servers };
  const isFleets = registeredByFleet({
    servers: definitions,
    mcp,
    home: HOME,
    value: (n) => secrets[n],
  });

  it("knows the fleet's own registrations: hub gateways, expanded homes, filled secrets", () => {
    for (const s of servers)
      expect([s.name, s.client, isFleets(s)]).toEqual([s.name, s.client, true]);
  });

  it("so it offers to change none of the fleet's definitions", () => {
    const plan = buildPlan({
      mode: "again",
      node: "laptop",
      authority: true,
      found,
      fleet,
      registered: isFleets,
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.add.servers).toEqual([]);
  });

  it("and when a registration has drifted, the default is the fleet's", () => {
    const drifted = { ...registered("fetch", "claude") };
    const changed: FoundServer = {
      ...drifted,
      entry: { ...drifted.entry, url: "https://elsewhere.example/mcp" },
      extracted: fromClaude(
        "fetch",
        { type: "http", url: "https://elsewhere.example/mcp" },
        {
          home: HOME,
          env: {},
          name: secretNamer([]),
        },
      )!,
    };
    expect(isFleets(changed)).toBe(false);
    const plan = buildPlan({
      mode: "again",
      node: "laptop",
      authority: true,
      found: { ...found, servers: [changed] },
      fleet,
      registered: isFleets,
    });
    expect(plan.conflicts.map((c) => [c.id, c.default])).toEqual([["server:fetch", "fleet"]]);
  });
});
