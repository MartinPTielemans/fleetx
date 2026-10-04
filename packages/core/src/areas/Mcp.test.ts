// The shell-safety test runs a real sh.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { describe, expect, it } from "vite-plus/test";

import { dq, McpArea, resolveEndpoint, toolhiveWorkloads, type McpDesired } from "./Mcp.ts";

const home = "/home/u";
const gateway = "https://relay.tailnet.ts.net:8399/";

describe("mcp area: where clients connect", () => {
  const remote = { kind: "remote", url: "https://mcp.example.com/mcp", remote_auth: true };
  const container = { kind: "container", image: "ghcr.io/example/fetch:1" };
  const registry = { kind: "registry", image: "ghcr.io/example/docs:1", transport: "stdio" };

  it("sends every hosted kind to the hub's gateway, without ports, when the hub is on", () => {
    const desired: McpDesired = { hub: true, gateway };
    for (const [name, d] of [
      ["r", remote],
      ["c", container],
      ["g", registry],
      ["h", { kind: "hosted-stdio", command: "x" }],
    ] as const) {
      expect(resolveEndpoint(name, d, desired, home)).toEqual({
        endpoint: {
          type: "http",
          url: `https://relay.tailnet.ts.net:8399/mcp/${name}`,
          tokenEnv: "T3_FLEET_RELAY_TOKEN",
        },
        problem: null,
      });
    }
    expect(
      resolveEndpoint("r", remote, { ...desired, token_env: "FLEETX_MCP_TOKEN_LAPTOP" }, home)
        .endpoint,
    ).toMatchObject({ tokenEnv: "FLEETX_MCP_TOKEN_LAPTOP" });
    expect(resolveEndpoint("r", remote, { hub: true }, home).problem).toMatch(/no \[mcp\] gateway/);
    // A fleet that has the relay token under its fleetx name keeps using it.
    expect(
      resolveEndpoint("r", remote, desired, home, "FLEETX_RELAY_TOKEN").endpoint,
    ).toMatchObject({ tokenEnv: "FLEETX_RELAY_TOKEN" });
  });

  it("keeps the ports path for fleets without the hub", () => {
    expect(
      resolveEndpoint("c", container, { origin: "server", ports: { c: 18100 } }, home).endpoint,
    ).toEqual({ type: "http", url: "http://server:18100/mcp", tokenEnv: null });
    expect(
      resolveEndpoint("c", container, { gateway, ports: { c: 18100 } }, home).endpoint,
    ).toEqual({
      type: "http",
      url: "https://relay.tailnet.ts.net:8399/mcp/c",
      tokenEnv: "T3_FLEET_RELAY_TOKEN",
    });
    expect(resolveEndpoint("c", container, { gateway }, home).problem).toMatch(
      /no \[mcp\] origin and port/,
    );
  });

  it("leaves stdio and direct servers as they are", () => {
    expect(
      resolveEndpoint(
        "s",
        { kind: "stdio", command: "~/bin/s", args: ["~/x"] },
        { hub: true, gateway },
        home,
      ).endpoint,
    ).toEqual({
      type: "stdio",
      command: "/home/u/bin/s",
      args: ["/home/u/x"],
    });
    expect(
      resolveEndpoint(
        "d",
        { kind: "direct", url: "https://d/mcp", auth: { type: "bearer", token_env: "D_TOKEN" } },
        { hub: true, gateway },
        home,
      ).endpoint,
    ).toEqual({
      type: "http",
      url: "https://d/mcp",
      tokenEnv: "D_TOKEN",
    });
  });
});

describe("mcp area: hub findings", () => {
  const diagnose = (observed: Parameters<typeof McpArea.diagnose>[0]["observed"]) =>
    McpArea.diagnose({
      node: "box",
      desired: { hub: true, gateway },
      observed,
      fleet: [],
      authority: null,
    });
  const registered = {
    type: "http",
    url: "https://relay.tailnet.ts.net:8399/mcp/posthog",
    auth: true,
  } as const;
  const server = (live: string) => ({
    name: "posthog",
    endpoint: {
      type: "http",
      url: "https://relay.tailnet.ts.net:8399/mcp/posthog",
      tokenEnv: "T3_FLEET_RELAY_TOKEN",
    },
    problem: null,
    claude: registered,
    codex: registered,
    live,
  });

  it("reports a server that needs a sign-in once, with the command, and not as down", () => {
    const findings = diagnose({
      servers: [server("needs-login")],
      clients: { claude: true, codex: true },
      hub: [
        {
          name: "posthog",
          state: "needs-login",
          detail: "refreshing the login was refused (invalid_grant)",
        },
        { name: "fetch", state: "running", detail: null },
      ],
    });
    expect(findings.map((f) => f.key)).toEqual(["mcp-posthog-needs-login"]);
    expect(findings[0]?.fix).toBeUndefined();
    expect(findings[0]?.detail).toContain("t3-fleet mcp login posthog");
  });

  it("re-registers a client that sends a different credential than the declared one", () => {
    const stale = { ...registered, credential: false } as const;
    const findings = diagnose({
      servers: [{ ...server("ok"), claude: stale, codex: registered }],
      clients: { claude: true, codex: true },
      hub: [],
    });
    expect(findings.map((f) => [f.key, f.title])).toEqual([
      ["mcp-posthog-unregistered", "MCP server posthog is not registered as declared in Claude"],
    ]);
  });

  it("asks to stop ToolHive workloads the hub serves, as a disrupting fix", () => {
    const findings = diagnose({
      servers: [server("ok")],
      clients: { claude: true, codex: true },
      toolhive: ["sentry", "fetch"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      key: "mcp-toolhive-left",
      fix: { command: "thv stop fetch sentry", safe: false },
    });
    expect(findings[0]?.fix?.disrupts).toContain("fetch, sentry");
  });

  it("points an expired credential at the hub's sign-in", () => {
    const [down] = diagnose({
      servers: [server("HTTP 401: Unauthorized")],
      clients: { claude: true, codex: true },
    });
    expect(down?.key).toBe("mcp-posthog-down");
    expect(down?.detail).toContain("t3-fleet mcp login posthog");
  });

  it("reads running workloads from thv list", () => {
    expect(
      toolhiveWorkloads(
        '[{"name":"fetch","status":"running"},{"name":"old","status":"stopped"},{"name":"bare"}]',
      ),
    ).toEqual(["fetch", "bare"]);
    expect(toolhiveWorkloads("null")).toEqual([]);
    expect(toolhiveWorkloads("")).toEqual([]);
  });
});

describe("mcp area: shell safety", () => {
  it("leaves only plain $NAME and ${NAME} active in double quotes", () => {
    expect(dq("$HOME/bin/x")).toBe('"$HOME/bin/x"');
    expect(dq("Bearer ${TOKEN}")).toBe('"Bearer ${TOKEN}"');
    expect(dq("https://x/$(id)")).toBe('"https://x/\\$(id)"');
    expect(dq('$((1+1)) ${X:-$(id)} `id` "q" \\')).toBe(
      '"\\$((1+1)) \\${X:-\\$(id)} \\`id\\` \\"q\\" \\\\"',
    );
    expect(dq("cost $5")).toBe('"cost \\$5"');
    // What the shell makes of it: the text, with only the plain reference expanded.
    const out = execFileSync(
      "/bin/sh",
      ["-c", `printf %s ${dq("$(echo pwned) `echo pwned` ${X:-d} $X")}`],
      { env: { X: "x", PATH: "/usr/bin:/bin" }, encoding: "utf8" },
    );
    expect(out).toBe("$(echo pwned) `echo pwned` ${X:-d} x");
  });

  it("refuses a token_env that is not a plain variable name", () => {
    for (const bad of ["X; rm -rf ~", "$(id)", "lower_case", "A B"]) {
      expect(
        resolveEndpoint(
          "d",
          { kind: "direct", url: "https://d/mcp", auth: { type: "bearer", token_env: bad } },
          {},
          home,
        ),
      ).toMatchObject({
        endpoint: null,
        problem: expect.stringMatching(/is not a variable name/),
      });
      expect(
        resolveEndpoint("c", { kind: "container" }, { hub: true, gateway, token_env: bad }, home)
          .endpoint,
      ).toBeNull();
    }
  });
});

describe("mcp area: re-registering", () => {
  const services = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make(() => Effect.die("no network in this test")),
    ),
  );

  /** A machine whose clients registered `docs` with an env (an API key, say) and options of their own. */
  const observeDocs = (claudeEntry: Record<string, unknown>, codexEntry: string) => {
    const scratch = mkdtempSync(join(tmpdir(), "t3f-mcp-"));
    mkdirSync(join(scratch, "fleet/mcp"), { recursive: true });
    mkdirSync(join(scratch, "bin"));
    mkdirSync(join(scratch, ".codex"));
    for (const bin of ["claude", "codex"])
      writeFileSync(join(scratch, "bin", bin), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(
      join(scratch, "fleet/mcp/docs.json"),
      JSON.stringify({ kind: "stdio", command: "docs-mcp", args: ["--new"] }),
    );
    writeFileSync(
      join(scratch, ".claude.json"),
      JSON.stringify({ mcpServers: { docs: claudeEntry } }),
    );
    writeFileSync(
      join(scratch, ".codex/config.toml"),
      `[mcp_servers.docs]\ncommand = "docs-mcp"\nargs = ["--old"]\n${codexEntry}`,
    );
    const ctx = {
      home: scratch,
      checkout: join(scratch, "fleet"),
      env: { HOME: scratch, PATH: `${join(scratch, "bin")}:/usr/bin:/bin` },
      engine: null,
      engineBuild: null,
      node: "m",
      roles: [],
      relay: null,
    };
    const desired = { servers: ["docs"] };
    return Effect.runPromise(McpArea.observe(desired, ctx).pipe(Effect.provide(services))).then(
      (observed) =>
        McpArea.diagnose({ node: "m", desired, observed, fleet: [], authority: null }).find(
          (f) => f.key === "mcp-docs-unregistered",
        ),
    );
  };

  it("leaves it to a person when an entry has settings the definition would drop", async () => {
    const found = await observeDocs(
      { type: "stdio", command: "docs-mcp", args: ["--old"], env: { DOCS_API_KEY: "secret" } },
      `startup_timeout_sec = 30\n[mcp_servers.docs.env]\nDOCS_API_KEY = "secret"\n`,
    );
    expect(found?.fix?.safe).toBe(false);
    expect(found?.detail).toContain(
      "re-registering drops Claude's env, Codex's startup_timeout_sec, Codex's env",
    );
    expect(JSON.stringify(found)).not.toContain("secret");
  });

  it("re-registers unattended when nothing would be lost", async () => {
    const found = await observeDocs(
      { type: "stdio", command: "docs-mcp", args: ["--old"], env: {} },
      "",
    );
    expect(found?.fix?.safe).toBe(true);
  });
});
