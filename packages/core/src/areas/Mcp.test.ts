// The shell-safety test runs a real sh.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";

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
    for (const [name, d] of [["r", remote], ["c", container], ["g", registry], ["h", { kind: "hosted-stdio", command: "x" }]] as const) {
      expect(resolveEndpoint(name, d, desired, home)).toEqual({ endpoint: { type: "http", url: `https://relay.tailnet.ts.net:8399/mcp/${name}`, tokenEnv: "FLEETX_RELAY_TOKEN" }, problem: null });
    }
    expect(resolveEndpoint("r", remote, { ...desired, token_env: "FLEETX_MCP_TOKEN_LAPTOP" }, home).endpoint).toMatchObject({ tokenEnv: "FLEETX_MCP_TOKEN_LAPTOP" });
    expect(resolveEndpoint("r", remote, { hub: true }, home).problem).toMatch(/no \[mcp\] gateway/);
  });

  it("keeps the ports path for fleets without the hub", () => {
    expect(resolveEndpoint("c", container, { origin: "server", ports: { c: 18100 } }, home).endpoint).toEqual({ type: "http", url: "http://server:18100/mcp", tokenEnv: null });
    expect(resolveEndpoint("c", container, { gateway, ports: { c: 18100 } }, home).endpoint).toEqual({
      type: "http",
      url: "https://relay.tailnet.ts.net:8399/mcp/c",
      tokenEnv: "FLEETX_RELAY_TOKEN",
    });
    expect(resolveEndpoint("c", container, { gateway }, home).problem).toMatch(/no \[mcp\] origin and port/);
  });

  it("leaves stdio and direct servers as they are", () => {
    expect(resolveEndpoint("s", { kind: "stdio", command: "~/bin/s", args: ["~/x"] }, { hub: true, gateway }, home).endpoint).toEqual({
      type: "stdio",
      command: "/home/u/bin/s",
      args: ["/home/u/x"],
    });
    expect(resolveEndpoint("d", { kind: "direct", url: "https://d/mcp", auth: { type: "bearer", token_env: "D_TOKEN" } }, { hub: true, gateway }, home).endpoint).toEqual({
      type: "http",
      url: "https://d/mcp",
      tokenEnv: "D_TOKEN",
    });
  });
});

describe("mcp area: hub findings", () => {
  const diagnose = (observed: Parameters<typeof McpArea.diagnose>[0]["observed"]) =>
    McpArea.diagnose({ node: "box", desired: { hub: true, gateway }, observed, fleet: [], authority: null });
  const registered = { type: "http", url: "https://relay.tailnet.ts.net:8399/mcp/posthog", auth: true } as const;
  const server = (live: string) => ({
    name: "posthog",
    endpoint: { type: "http", url: "https://relay.tailnet.ts.net:8399/mcp/posthog", tokenEnv: "FLEETX_RELAY_TOKEN" },
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
        { name: "posthog", state: "needs-login", detail: "refreshing the login was refused (invalid_grant)" },
        { name: "fetch", state: "running", detail: null },
      ],
    });
    expect(findings.map((f) => f.key)).toEqual(["mcp-posthog-needs-login"]);
    expect(findings[0]?.fix).toBeUndefined();
    expect(findings[0]?.detail).toContain("fleetx mcp login posthog");
  });

  it("re-registers a client that sends a different credential than the declared one", () => {
    const stale = { ...registered, credential: false } as const;
    const findings = diagnose({ servers: [{ ...server("ok"), claude: stale, codex: registered }], clients: { claude: true, codex: true }, hub: [] });
    expect(findings.map((f) => [f.key, f.title])).toEqual([["mcp-posthog-unregistered", "MCP server posthog is not registered as declared in Claude"]]);
  });

  it("asks to stop ToolHive workloads the hub serves, as a disrupting fix", () => {
    const findings = diagnose({ servers: [server("ok")], clients: { claude: true, codex: true }, toolhive: ["sentry", "fetch"] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ key: "mcp-toolhive-left", fix: { command: "thv stop fetch sentry", safe: false } });
    expect(findings[0]?.fix?.disrupts).toContain("fetch, sentry");
  });

  it("points an expired credential at the hub's sign-in", () => {
    const [down] = diagnose({ servers: [server("HTTP 401: Unauthorized")], clients: { claude: true, codex: true } });
    expect(down?.key).toBe("mcp-posthog-down");
    expect(down?.detail).toContain("fleetx mcp login posthog");
  });

  it("reads running workloads from thv list", () => {
    expect(toolhiveWorkloads('[{"name":"fetch","status":"running"},{"name":"old","status":"stopped"},{"name":"bare"}]')).toEqual(["fetch", "bare"]);
    expect(toolhiveWorkloads("null")).toEqual([]);
    expect(toolhiveWorkloads("")).toEqual([]);
  });
});

describe("mcp area: shell safety", () => {
  it("leaves only plain $NAME and ${NAME} active in double quotes", () => {
    expect(dq("$HOME/bin/x")).toBe('"$HOME/bin/x"');
    expect(dq("Bearer ${TOKEN}")).toBe('"Bearer ${TOKEN}"');
    expect(dq("https://x/$(id)")).toBe('"https://x/\\$(id)"');
    expect(dq("$((1+1)) ${X:-$(id)} `id` \"q\" \\")).toBe('"\\$((1+1)) \\${X:-\\$(id)} \\`id\\` \\"q\\" \\\\"');
    expect(dq("cost $5")).toBe('"cost \\$5"');
    // What the shell makes of it: the text, with only the plain reference expanded.
    const out = execFileSync("/bin/sh", ["-c", `printf %s ${dq("$(echo pwned) `echo pwned` ${X:-d} $X")}`], { env: { X: "x", PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(out).toBe("$(echo pwned) `echo pwned` ${X:-d} x");
  });

  it("refuses a token_env that is not a plain variable name", () => {
    for (const bad of ["X; rm -rf ~", "$(id)", "lower_case", "A B"]) {
      expect(resolveEndpoint("d", { kind: "direct", url: "https://d/mcp", auth: { type: "bearer", token_env: bad } }, {}, home)).toMatchObject({
        endpoint: null,
        problem: expect.stringMatching(/is not a variable name/),
      });
      expect(resolveEndpoint("c", { kind: "container" }, { hub: true, gateway, token_env: bad }, home).endpoint).toBeNull();
    }
  });
});
