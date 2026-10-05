import { describe, expect, it } from "vite-plus/test";

import { hostingOf, hostingPlan, hostingWords } from "./HubHosting.ts";

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
