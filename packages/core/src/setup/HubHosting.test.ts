import { describe, expect, it } from "vite-plus/test";

// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { moveServersBack, moveServersToHub, writtenPaths } from "./Apply.ts";
import { backFromHub, hostingOf, hostingPlan, hostingWords } from "./HubHosting.ts";

describe("which MCP servers the hub takes over (B5)", () => {
  it("moves a plain https server, its bearer secret kept, and leaves what it cannot host, saying why", () => {
    expect(
      hostingOf({
        kind: "direct",
        url: "https://mcp.posthog.example/mcp",
        auth: { type: "bearer", token_env: "POSTHOG_KEY" },
      }),
    ).toEqual({
      on: "hub",
      definition: {
        kind: "remote",
        url: "https://mcp.posthog.example/mcp",
        auth: { type: "bearer", token_env: "POSTHOG_KEY" },
        moved_from: {
          kind: "direct",
          url: "https://mcp.posthog.example/mcp",
          auth: { type: "bearer", token_env: "POSTHOG_KEY" },
        },
      },
    });
    // Every field the hub reads for a remote goes along: its OAuth login, static client, denied tools.
    const oauth = {
      kind: "direct",
      url: "https://mcp.linear.example/mcp",
      transport: "streamable-http",
      remote_auth: true,
      remote_auth_scopes: ["read", "write"],
      oauth: {
        client_id: "fleet",
        client_secret_env: "LINEAR_CLIENT_SECRET",
        issuer: "https://auth.linear.example",
        scopes: ["read"],
      },
      tools: { deny: ["delete_*"] },
      description: "Linear",
    };
    expect(hostingOf(oauth)).toEqual({
      on: "hub",
      definition: {
        kind: "remote",
        url: "https://mcp.linear.example/mcp",
        remote_auth: true,
        remote_auth_scopes: ["read", "write"],
        oauth: {
          client_id: "fleet",
          client_secret_env: "LINEAR_CLIENT_SECRET",
          issuer: "https://auth.linear.example",
          scopes: ["read"],
        },
        tools: { deny: ["delete_*"] },
        description: "Linear",
        moved_from: oauth,
      },
    });
    const why = (definition: Record<string, unknown>) => {
      const h = hostingOf(definition);
      return h.on === "machines" ? h.why : null;
    };
    expect(why({ kind: "stdio", command: "npx", args: ["notes"] })).toContain("runs a command");
    // One the hub could not serve as a remote stays, rather than move and lose what it needs.
    expect(
      why({ ...oauth, oauth: { client_id: "fleet", client_secret_env: "LINEAR_CLIENT_SECRET" } }),
    ).toContain("oauth needs the https issuer");
    expect(why({ kind: "direct", url: "https://x.example/mcp", headers: { A: "$B" } })).toContain(
      "headers of its own",
    );
    expect(why({ kind: "direct", url: "https://x.example/sse", transport: "sse" })).toContain(
      "SSE",
    );
    expect(why({ kind: "direct", url: "https://x.example/mcp?key=$KEY" })).toContain(
      "carries a secret",
    );
    expect(why({ kind: "direct", url: "http://localhost:3000/mcp" })).toContain("plain http");
    expect(hostingOf({ kind: "container", image: "ghcr.io/x/y" })).toEqual({
      on: "hub",
      definition: null,
    });
  });

  it("lists every server once, sorted, in the plan's words", () => {
    const plan = hostingPlan(
      new Map<string, Record<string, unknown>>([
        ["search", { kind: "direct", url: "https://s.example/mcp", transport: "sse" }],
        ["posthog", { kind: "direct", url: "https://p.example/mcp" }],
        ["fetch", { kind: "remote", url: "https://f.example/mcp" }],
      ]),
    );
    expect(plan.map((s) => [s.name, s.hub])).toEqual([
      ["fetch", true],
      ["posthog", true],
      ["search", false],
    ]);
    expect(hostingWords("box", plan)).toEqual([
      "On box: fetch, posthog",
      "Stays on each machine: search, as it speaks SSE, which the hub does not proxy",
    ]);
    expect(hostingWords("box", [])).toEqual([
      "No MCP server moves to box: none is one it can host",
    ]);
  });
});

describe("turning the MCP hub off (review #47)", () => {
  it("puts every server the hub took back as it was, and leaves a remote written as one", async () => {
    const repo = mkdtempSync(join(tmpdir(), "t3-fleet-hub-off-"));
    mkdirSync(join(repo, "mcp"));
    const posthog = {
      kind: "direct",
      url: "https://mcp.posthog.example/mcp",
      auth: { type: "bearer", token_env: "POSTHOG_KEY" },
      remote_auth_scopes: ["read"],
    };
    const own = { kind: "remote", url: "https://own.example/mcp" };
    const text = (d: unknown) => `${JSON.stringify(d, null, 2)}\n`;
    writeFileSync(join(repo, "mcp/posthog.json"), text(posthog));
    writeFileSync(join(repo, "mcp/own.json"), text(own));
    const run = <A, E>(e: Effect.Effect<A, E, NodeServices.NodeServices>) =>
      Effect.runPromise(e.pipe(Effect.provide(NodeServices.layer)));
    expect((await run(moveServersToHub(repo))).moved).toEqual(["posthog"]);
    const read = (name: string) =>
      JSON.parse(readFileSync(join(repo, `mcp/${name}.json`), "utf8")) as Record<string, unknown>;
    expect(read("posthog")["kind"]).toBe("remote");
    const back = await run(moveServersBack(repo));
    expect(back).toEqual({ back: ["posthog"], files: ["mcp/posthog.json"] });
    expect(read("posthog")).toEqual(posthog);
    expect(read("own")).toEqual(own);
    expect(backFromHub(own)).toBe(null);
    // And the run commits what it put back.
    const input = {
      node: "laptop",
      extras: { relay: null },
      upkeep: { mcpHub: false },
      actions: { skills: [], servers: [], instructions: [] },
    } as unknown as Parameters<typeof writtenPaths>[0];
    expect(writtenPaths(input)).toContain("mcp");
  });
});
