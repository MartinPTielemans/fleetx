// These tests run a real sh and set up machines in temporary homes.
// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vite-plus/test";

import * as Schema from "effect/Schema";

import { setVar } from "../Secrets.ts";
import {
  codexStdio,
  dq,
  Endpoint,
  McpArea,
  parseSecrets,
  registerInClaude,
  resolveEndpoint,
  toolhiveWorkloads,
  type McpDesired,
} from "./Mcp.ts";

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
      resolveEndpoint("r", remote, { ...desired, token_env: "T3_FLEET_MCP_TOKEN_LAPTOP" }, home)
        .endpoint,
    ).toMatchObject({ tokenEnv: "T3_FLEET_MCP_TOKEN_LAPTOP" });
    expect(resolveEndpoint("r", remote, { hub: true }, home).problem).toMatch(/no \[mcp\] gateway/);
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
  const observeDocs = (
    claudeEntry: Record<string, unknown>,
    codexEntry: string,
    env?: Record<string, string>,
  ) => {
    const scratch = mkdtempSync(join(tmpdir(), "t3f-mcp-"));
    mkdirSync(join(scratch, "fleet/mcp"), { recursive: true });
    mkdirSync(join(scratch, "bin"));
    mkdirSync(join(scratch, ".codex"));
    for (const bin of ["claude", "codex"])
      writeFileSync(join(scratch, "bin", bin), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(
      join(scratch, "fleet/mcp/docs.json"),
      JSON.stringify({ kind: "stdio", command: "docs-mcp", args: ["--new"], ...(env && { env }) }),
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
      "re-registering drops Claude's env DOCS_API_KEY, Codex's startup_timeout_sec, Codex's env DOCS_API_KEY",
    );
    expect(JSON.stringify(found)).not.toContain("secret");
  });

  it("re-registers unattended when the settings are the ones the definition declares", async () => {
    const found = await observeDocs(
      { type: "stdio", command: "docs-mcp", args: ["--old"], env: { DOCS_API_KEY: "secret" } },
      `[mcp_servers.docs.env]\nDOCS_API_KEY = "secret"\n`,
      { DOCS_API_KEY: "$DOCS_API_KEY" },
    );
    expect(found?.fix?.safe).toBe(true);
    // Codex gets the secret by name; the old literal leaves config.toml.
    expect(found?.fix?.command).toContain('[[mcp_servers."docs".env_vars]]');
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

describe("mcp area: definitions that carry credentials", () => {
  it("keeps a stdio server's env, and a direct server's headers and SSE transport", () => {
    expect(
      resolveEndpoint(
        "github",
        {
          kind: "stdio",
          command: "github-mcp",
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$GITHUB_TOKEN", GITHUB_TOOLSETS: "repos" },
        },
        {},
        home,
      ).endpoint,
    ).toEqual({
      type: "stdio",
      command: "github-mcp",
      args: [],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$GITHUB_TOKEN", GITHUB_TOOLSETS: "repos" },
    });
    expect(
      resolveEndpoint(
        "c7",
        {
          kind: "direct",
          url: "https://c7/mcp",
          headers: { CONTEXT7_API_KEY: "$CONTEXT7_API_KEY" },
          transport: "sse",
        },
        {},
        home,
      ).endpoint,
    ).toEqual({
      type: "http",
      url: "https://c7/mcp",
      tokenEnv: null,
      headers: { CONTEXT7_API_KEY: "$CONTEXT7_API_KEY" },
      transport: "sse",
    });
  });

  it("refuses fields a kind does not take, and names that are not names", () => {
    for (const [d, problem] of [
      [{ kind: "stdio", command: "x", headers: { A: "b" } }, /headers are for direct/],
      [{ kind: "direct", url: "https://d", env: { A: "b" } }, /env is for stdio/],
      [{ kind: "direct", url: "https://d", transport: "websocket" }, /transport websocket/],
      [{ kind: "stdio", command: "x", env: { "A; id": "b" } }, /is not a variable name/],
      [{ kind: "direct", url: "https://d", headers: { "A B": "c" } }, /is not a header name/],
    ] as const)
      expect(resolveEndpoint("s", d, {}, home).problem).toMatch(problem);
  });

  it("hands Codex a secret by name, renaming it in a shell when the server expects another", () => {
    const run = codexStdio({
      type: "stdio",
      command: "printenv",
      args: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$GITHUB_TOKEN", SAME: "$SAME", MODE: "ro" },
    });
    // In the shell, the literal too: Codex's own `env` would be set before it runs.
    expect(run).toMatchObject({ env: {}, vars: ["GITHUB_TOKEN", "SAME"] });
    expect(run.command).toBe("sh");
    const out = execFileSync(run.command, run.args, {
      env: { GITHUB_TOKEN: "ghp_x$y", SAME: "s", PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(out).toBe("ghp_x$y\n");
    expect(codexStdio({ type: "stdio", command: "s", args: [], env: { TOKEN: "$TOKEN" } })).toEqual(
      { command: "s", args: [], env: {}, vars: ["TOKEN"] },
    );
  });

  it("reads every source before setting any variable, and refuses when one is not set", () => {
    // Swapped names, and a literal over another's source: each variable still gets its own source.
    const run = codexStdio({
      type: "stdio",
      command: "env",
      args: [],
      env: { A: "$B", B: "$A", C: "$D", D: "literal" },
    });
    const env = { A: "a", B: "b", D: "d", PATH: "/usr/bin:/bin" };
    expect(execFileSync(run.command, run.args, { env, encoding: "utf8" }).split("\n")).toEqual(
      expect.arrayContaining(["A=b", "B=a", "C=d", "D=literal"]),
    );
    const missing = spawnSync(run.command, run.args, {
      env: { A: "a", D: "d", PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toBe("t3-fleet: B is not set in Codex's environment\n");
  });

  it("copies sources under names no declared variable has", () => {
    const run = codexStdio({
      type: "stdio",
      command: "env",
      args: [],
      env: { _t3f_0: "declared", A: "$B" },
    });
    const out = execFileSync(run.command, run.args, {
      env: { B: "b", PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    }).split("\n");
    expect(out).toEqual(expect.arrayContaining(["A=b", "_t3f_0=declared"]));
  });

  it("fills a secret into an argument for Codex in a shell, as one word, never into config.toml", () => {
    const run = codexStdio({
      type: "stdio",
      command: "printf",
      args: ["%s|", "--api-key=$CTX_API_KEY", "postgres://u:${DB_PW}@db/x", "$(id)"],
    });
    expect(run.vars).toEqual(["CTX_API_KEY", "DB_PW"]);
    expect(JSON.stringify(run)).not.toContain("k $1");
    const out = execFileSync(run.command, run.args, {
      env: { CTX_API_KEY: "k $1 `id`", DB_PW: "p'w", PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(out).toBe("--api-key=k $1 `id`|postgres://u:p'w@db/x|$(id)|");
  });

  const diagnose = (observed: Parameters<typeof McpArea.diagnose>[0]["observed"]) =>
    McpArea.diagnose({ node: "box", desired: {}, observed, fleet: [], authority: null });

  it("registers an SSE server in Claude only, and says why Codex has none", () => {
    const findings = diagnose({
      servers: [
        {
          name: "legacy",
          endpoint: { type: "http", url: "https://l/sse", tokenEnv: null, transport: "sse" },
          problem: null,
          claude: null,
          codex: null,
          live: "ok",
        },
      ],
      clients: { claude: true, codex: true },
    });
    expect(findings.map((f) => [f.key, f.severity])).toEqual([
      ["mcp-legacy-not-in-codex", "info"],
      ["mcp-legacy-unregistered", "warn"],
    ]);
    expect(findings[1]?.fix?.command).toBe(
      `t3-fleet mcp register-claude legacy '{"type":"http","url":"https://l/sse","tokenEnv":null,"transport":"sse"}'`,
    );
  });

  it("leaves Claude unregistered while the node lacks a secret it would store", () => {
    const findings = diagnose({
      servers: [
        {
          name: "github",
          endpoint: { type: "stdio", command: "g", args: [], env: { T: "$GITHUB_TOKEN" } },
          problem: null,
          claude: null,
          codex: null,
          live: null,
          missing: ["GITHUB_TOKEN"],
        },
      ],
      clients: { claude: true, codex: true },
    });
    expect(findings.map((f) => f.key)).toEqual([
      "mcp-github-secret-missing",
      "mcp-github-unregistered",
    ]);
    expect(findings[0]?.detail).toContain("t3-fleet secrets set GITHUB_TOKEN=…");
    expect(findings[1]?.title).toBe("MCP server github is not registered as declared in Codex");
  });

  it("reports the servers a machine has that the fleet does not declare for it", () => {
    const [finding] = diagnose({
      servers: [],
      clients: { claude: true, codex: true },
      undeclared: { claude: ["github", "figma"], codex: ["github"] },
    });
    expect(finding).toMatchObject({
      key: "mcp-undeclared",
      severity: "info",
      title: "box has MCP servers the fleet does not declare for it: figma, github",
    });
    expect(finding?.detail).toContain("figma (Claude), github (Claude and Codex)");
    expect(finding?.detail).toContain("t3-fleet mcp add");
    expect(finding?.fix).toBeUndefined();
  });
});

describe("mcp area: registering credentials, end to end", () => {
  /** Stand-ins for the clients: Claude keeps what add-json gets; Codex writes entries as `codex mcp add` does. */
  const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs"); const p = process.env.HOME + "/.claude.json"; const a = process.argv.slice(2);
const j = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {}; j.mcpServers = j.mcpServers || {};
if (a[1] === "remove") delete j.mcpServers[a[4]];
if (a[1] === "add-json") j.mcpServers[a[4]] = JSON.parse(a[5]);
fs.writeFileSync(p, JSON.stringify(j));
`;
  const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("fs"); const p = process.env.HOME + "/.codex/config.toml"; const a = process.argv.slice(2);
if (a[1] !== "add") process.exit(0);
const q = JSON.stringify; const out = ["", "[mcp_servers." + a[2] + "]"]; const env = []; let i = 3;
for (; i < a.length && a[i] !== "--"; i += 2) {
  if (a[i] === "--url") out.push("url = " + q(a[i + 1]));
  if (a[i] === "--bearer-token-env-var") out.push("bearer_token_env_var = " + q(a[i + 1]));
  if (a[i] === "--env") { const [k, ...v] = a[i + 1].split("="); env.push(q(k) + " = " + q(v.join("="))); }
}
if (a[i] === "--") out.push("command = " + q(a[i + 1]), "args = " + q(a.slice(i + 2)));
if (env.length > 0) out.push("[mcp_servers." + a[2] + ".env]", ...env);
fs.appendFileSync(p, out.join("\\n") + "\\n");
`;

  const SECRETS = ["ghp_a", "ctx7sk", "leg-1", "sk-9", "ctx-8"];

  const machine = (
    mcp: { readonly servers?: Array<string>; readonly ignore?: Array<string> } = {},
    extraEnv: Record<string, string> = {},
  ) => {
    const scratch = mkdtempSync(join(tmpdir(), "t3f-mcp-creds-"));
    for (const dir of ["fleet/mcp", "bin", ".codex", ".config/t3-fleet"])
      mkdirSync(join(scratch, dir), { recursive: true });
    writeFileSync(join(scratch, "bin/claude"), FAKE_CLAUDE, { mode: 0o755 });
    writeFileSync(join(scratch, "bin/codex"), FAKE_CODEX, { mode: 0o755 });
    writeFileSync(
      join(scratch, "bin/t3-fleet"),
      `#!/usr/bin/env node\nrequire("fs").appendFileSync(process.env.HOME + "/t3-fleet-calls", JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(scratch, ".codex/config.toml"), "");
    const definitions = {
      github: {
        kind: "stdio",
        command: "github-mcp",
        args: ["stdio"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$GITHUB_TOKEN", PRICE: "cost $5" },
      },
      context7: {
        kind: "direct",
        url: "https://mcp.context7.com/mcp",
        headers: { CONTEXT7_API_KEY: "$CONTEXT7_API_KEY", "X-Client": "t3 $fleet" },
      },
      legacy: {
        kind: "direct",
        url: "https://legacy.example.com/sse",
        transport: "sse",
        auth: { type: "bearer", token_env: "LEGACY_TOKEN" },
      },
      // Credentials only a url or an argument can carry.
      search: { kind: "direct", url: "https://search.example.com/mcp?apiKey=$SEARCH_APIKEY" },
      docs: { kind: "stdio", command: "docs-mcp", args: ["--api-key", "$CTX_API_KEY"] },
    };
    for (const [name, d] of Object.entries(definitions))
      writeFileSync(join(scratch, `fleet/mcp/${name}.json`), JSON.stringify(d));
    const setSecrets = (github: string) =>
      writeFileSync(
        join(scratch, ".config/t3-fleet/secrets.env"),
        `GITHUB_TOKEN="${github}"\nCONTEXT7_API_KEY=ctx7sk-123\nLEGACY_TOKEN=leg-1\nSEARCH_APIKEY=sk-9\nCTX_API_KEY=ctx-8\n`,
      );
    setSecrets("ghp_a\\$b");
    const env = {
      HOME: scratch,
      PATH: `${join(scratch, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
      ...extraEnv,
    };
    const requests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const services = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(HttpClient.HttpClient)(
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push({ method: request.method, url: request.url, headers: request.headers });
            return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }));
          }),
        ),
      ),
    );
    const ctx = {
      home: scratch,
      checkout: join(scratch, "fleet"),
      env,
      engine: null,
      engineBuild: null,
      node: "m",
      roles: [],
      relay: null,
    };
    const desired = {
      servers: mcp.servers ?? ["github", "context7", "legacy", "search", "docs"],
      ...(mcp.ignore === undefined ? {} : { ignore: mcp.ignore }),
    };
    const check = () =>
      Effect.runPromise(McpArea.observe(desired, ctx).pipe(Effect.provide(services))).then(
        (observed) => ({
          observed,
          findings: McpArea.diagnose({ node: "m", desired, observed, fleet: [], authority: null }),
        }),
      );
    // The fix runs `t3-fleet mcp register-claude`; the stand-in records it, and it runs here.
    const calls = join(scratch, "t3-fleet-calls");
    const run = async (command: string) => {
      writeFileSync(calls, "");
      execFileSync("/bin/sh", ["-c", command], { env });
      for (const line of readFileSync(calls, "utf8").split("\n").filter(Boolean)) {
        const [, verb, name = "", endpoint = ""] = Schema.decodeSync(
          Schema.fromJsonString(Schema.Array(Schema.String)),
        )(line);
        expect(verb).toBe("register-claude");
        await Effect.runPromise(
          registerInClaude(
            scratch,
            name,
            Schema.decodeSync(Schema.fromJsonString(Endpoint))(endpoint),
            env,
          ).pipe(Effect.provide(NodeServices.layer)),
        );
      }
    };
    return { scratch, check, run, requests, setSecrets };
  };

  it("registers env, headers and SSE in both clients without writing a secret into Codex's config", async () => {
    const m = machine();
    const { observed, findings } = await m.check();
    expect(findings.map((f) => f.key)).toEqual([
      "mcp-github-unregistered",
      "mcp-context7-unregistered",
      "mcp-legacy-not-in-codex",
      "mcp-legacy-unregistered",
      "mcp-search-not-in-codex",
      "mcp-search-unregistered",
      "mcp-docs-unregistered",
    ]);
    expect(findings.find((f) => f.key === "mcp-search-not-in-codex")?.title).toBe(
      "Codex cannot use MCP server search: its URL holds SEARCH_APIKEY",
    );
    const published = JSON.stringify({ observed, findings });
    for (const value of SECRETS) expect(published).not.toContain(value);
    expect(m.requests).toContainEqual(
      expect.objectContaining({ url: "https://search.example.com/mcp?apiKey=sk-9" }),
    );
    // The live checks send the declared headers; the SSE server's event stream is opened.
    expect(m.requests).toContainEqual(
      expect.objectContaining({
        method: "POST",
        url: "https://mcp.context7.com/mcp",
        headers: expect.objectContaining({
          context7_api_key: "ctx7sk-123",
          "x-client": "t3 $fleet",
        }),
      }),
    );
    expect(m.requests).toContainEqual(
      expect.objectContaining({
        method: "GET",
        url: "https://legacy.example.com/sse",
        headers: expect.objectContaining({
          accept: "text/event-stream",
          authorization: "Bearer leg-1",
        }),
      }),
    );

    for (const f of findings) {
      if (f.fix === undefined) continue;
      expect(f.fix.safe).toBe(true);
      await m.run(f.fix.command);
    }
    const claude = JSON.parse(readFileSync(join(m.scratch, ".claude.json"), "utf8")).mcpServers;
    expect(claude).toEqual({
      github: {
        type: "stdio",
        command: "github-mcp",
        args: ["stdio"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_a$b", PRICE: "cost $5" },
      },
      context7: {
        type: "http",
        url: "https://mcp.context7.com/mcp",
        headers: { CONTEXT7_API_KEY: "ctx7sk-123", "X-Client": "t3 $fleet" },
      },
      legacy: {
        type: "sse",
        url: "https://legacy.example.com/sse",
        headers: { Authorization: "Bearer leg-1" },
      },
      search: { type: "http", url: "https://search.example.com/mcp?apiKey=sk-9" },
      docs: { type: "stdio", command: "docs-mcp", args: ["--api-key", "ctx-8"] },
    });
    const codexText = readFileSync(join(m.scratch, ".codex/config.toml"), "utf8");
    for (const value of SECRETS) expect(codexText).not.toContain(value);
    expect(parseToml(codexText)).toEqual({
      mcp_servers: {
        github: {
          command: "sh",
          args: [
            "-c",
            `[ -n "\${GITHUB_TOKEN+x}" ] || { echo 't3-fleet: GITHUB_TOKEN is not set in Codex'\\''s environment' >&2; exit 1; }; _t3f_0="$GITHUB_TOKEN"; export GITHUB_PERSONAL_ACCESS_TOKEN="$_t3f_0"; export PRICE='cost $5'; exec "github-mcp" "stdio"`,
          ],
          env_vars: [{ name: "GITHUB_TOKEN" }],
        },
        context7: {
          url: "https://mcp.context7.com/mcp",
          http_headers: { "X-Client": "t3 $fleet" },
          env_http_headers: { CONTEXT7_API_KEY: "CONTEXT7_API_KEY" },
        },
        docs: {
          command: "sh",
          args: [
            "-c",
            `[ -n "\${CTX_API_KEY+x}" ] || { echo 't3-fleet: CTX_API_KEY is not set in Codex'\\''s environment' >&2; exit 1; }; _t3f_0="$CTX_API_KEY"; exec "docs-mcp" "--api-key" "\${_t3f_0}"`,
          ],
          env_vars: [{ name: "CTX_API_KEY" }],
        },
      },
    });

    // Registered as declared: nothing left to do.
    expect((await m.check()).findings.map((f) => f.key)).toEqual([
      "mcp-legacy-not-in-codex",
      "mcp-search-not-in-codex",
    ]);

    // A changed secret re-registers Claude, which stores its value; Codex reads it when it runs.
    m.setSecrets("ghp_new");
    const changed = (await m.check()).findings.find((f) => f.key === "mcp-github-unregistered");
    expect(changed?.title).toBe("MCP server github is not registered as declared in Claude");
    expect(changed?.fix?.safe).toBe(true);
  });

  it("publishes what differs in a registration by name, never a url or argument holding a credential", async () => {
    const m = machine();
    writeFileSync(
      join(m.scratch, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          search: { type: "http", url: "https://search.example.com/mcp?apiKey=old-key-in-url" },
          docs: { type: "stdio", command: "docs-mcp", args: ["--api-key", "old-key-in-arg"] },
        },
      }),
    );
    writeFileSync(
      join(m.scratch, ".codex/config.toml"),
      '[mcp_servers.docs]\ncommand = "docs-mcp"\nargs = ["--api-key", "old-key-in-arg"]\n',
    );
    const { observed, findings } = await m.check();
    const published = JSON.stringify({ observed, findings });
    for (const value of ["old-key-in-url", "old-key-in-arg"])
      expect(published).not.toContain(value);
    const server = (name: string) =>
      observed.servers.find((s: { readonly name: string }) => s.name === name);
    expect(server("search")?.claude).toEqual({ type: "http", differs: ["url"] });
    expect(server("docs")?.claude).toEqual({ type: "stdio", differs: ["args"] });
    expect(server("docs")?.codex).toEqual({
      type: "stdio",
      differs: ["command", "args", "env_vars CTX_API_KEY"],
    });
    expect(findings.find((f) => f.key === "mcp-docs-unregistered")?.fix?.safe).toBe(true);
  });

  it("lists the servers the clients have that the fleet does not declare, but not its own", async () => {
    const m = machine();
    writeFileSync(
      join(m.scratch, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          figma: { type: "http", url: "https://figma/mcp" },
          "t3 fleet": { type: "stdio", command: "/usr/local/bin/t3-fleet", args: ["mcp"] },
        },
      }),
    );
    writeFileSync(
      join(m.scratch, ".codex/config.toml"),
      '[mcp_servers.github-own]\ncommand = "gh-mcp"\n',
    );
    const { observed } = await m.check();
    expect(observed.undeclared).toEqual({ claude: ["figma"], codex: ["github-own"] });
  });

  it("reads and registers Claude's config where CLAUDE_CONFIG_DIR puts it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3f-claude-dir-"));
    const moved = machine({ servers: ["context7"] }, { CLAUDE_CONFIG_DIR: dir });
    for (const f of (await moved.check()).findings)
      if (f.fix !== undefined && f.title.includes("Claude")) await moved.run(f.fix.command);
    expect(
      JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers.context7,
    ).toMatchObject({ url: "https://mcp.context7.com/mcp" });
    const claude = (await moved.check()).observed.servers[0]?.claude;
    expect(claude).toEqual({ type: "http" });
    expect(existsSync(join(moved.scratch, ".claude.json"))).toBe(false);
  });

  it("makes Claude's config backups that hold a secret readable by their owner alone", async () => {
    const m = machine({ servers: [] });
    const backups = join(m.scratch, ".claude/backups");
    mkdirSync(backups, { recursive: true });
    const backup = (name: string, text: string, mode: number) =>
      writeFileSync(join(backups, `.claude.json.backup.${name}`), text, { mode });
    backup("1", '{"mcpServers":{"c":{"headers":{"K":"ctx7sk-123"}}}}', 0o644);
    backup("2", '{"mcpServers":{"c":{"headers":{"K":"ctx7sk-123"}}}}', 0o600);
    backup("3", '{"mcpServers":{}}', 0o644);
    // The config itself holds a short secret, leg-1: short ones count too.
    writeFileSync(join(m.scratch, ".claude.json"), '{"x":"leg-1"}', { mode: 0o644 });
    writeFileSync(join(m.scratch, ".claude.json.backup.4"), '{"y":"ctx7sk-123"}', { mode: 0o604 });
    const found = (await m.check()).findings.find((f) => f.key === "mcp-claude-config-exposed");
    expect(found).toMatchObject({
      severity: "error",
      fix: {
        command:
          'chmod 600 "$HOME"/.claude.json "$HOME"/.claude.json.backup.4 "$HOME"/.claude/backups/.claude.json.backup.1',
        safe: true,
      },
    });
    expect(JSON.stringify(found)).not.toContain("ctx7sk");
    await m.run(found?.fix?.command ?? "");
    expect(statSync(join(backups, ".claude.json.backup.1")).mode & 0o777).toBe(0o600);
    expect(statSync(join(backups, ".claude.json.backup.3")).mode & 0o777).toBe(0o644);
    expect((await m.check()).findings.map((f) => f.key)).not.toContain("mcp-claude-config-exposed");
  });

  it("finds a credential the definitions take from the environment, and never opens a FIFO", async () => {
    const m = machine({ servers: ["envkey"] }, { ENVKEY: "e-42" });
    writeFileSync(
      join(m.scratch, "fleet/mcp/envkey.json"),
      JSON.stringify({ kind: "direct", url: "https://e/mcp", headers: { K: "$ENVKEY" } }),
    );
    const backups = join(m.scratch, ".claude/backups");
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, ".claude.json.backup.1"), '{"K":"e-42"}', { mode: 0o644 });
    execFileSync("mkfifo", ["-m", "644", join(backups, ".claude.json.backup.2")]);
    const { observed, findings } = await m.check();
    expect(observed.exposed).toEqual(["~/.claude/backups/.claude.json.backup.1"]);
    expect(observed.unchecked).toBe(true);
    expect(findings.find((f) => f.key === "mcp-claude-config-exposed")?.detail).toContain(
      "some copies were not looked into",
    );
  });

  it("leaves the servers a machine's [mcp] ignore lists unreported", async () => {
    const m = machine({ servers: [], ignore: ["figma", "node_repl"] });
    writeFileSync(
      join(m.scratch, ".claude.json"),
      JSON.stringify({ mcpServers: { figma: { url: "https://f" }, other: { url: "https://o" } } }),
    );
    writeFileSync(
      join(m.scratch, ".codex/config.toml"),
      '[mcp_servers.node_repl]\ncommand = "n"\n',
    );
    const { observed, findings } = await m.check();
    expect(observed.undeclared).toEqual({ claude: ["other"], codex: [] });
    expect(findings.find((f) => f.key === "mcp-undeclared")?.detail).toContain(
      '[mcp] "ignore.add" = ["<name>"]',
    );
  });

  it("leaves to a person a credential the replacement would not write", async () => {
    const m = machine({ servers: ["plain"] });
    writeFileSync(
      join(m.scratch, "fleet/mcp/plain.json"),
      JSON.stringify({ kind: "direct", url: "https://plain.example.com/mcp" }),
    );
    writeFileSync(
      join(m.scratch, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          plain: {
            type: "http",
            url: "https://old.example.com/mcp",
            headers: { Authorization: "Bearer handmade" },
          },
        },
      }),
    );
    writeFileSync(
      join(m.scratch, ".codex/config.toml"),
      '[mcp_servers.plain]\nurl = "https://old.example.com/mcp"\nbearer_token_env_var = "HANDMADE"\n[mcp_servers.plain.http_headers]\nAuthorization = "Bearer handmade"\n',
    );
    const { findings } = await m.check();
    const found = findings.find((f) => f.key === "mcp-plain-unregistered");
    expect(found?.fix?.safe).toBe(false);
    expect(found?.detail).toContain(
      "re-registering drops Claude's header Authorization, Codex's bearer_token_env_var, Codex's header Authorization",
    );
    expect(JSON.stringify(findings)).not.toContain("handmade");
  });

  it("settles a declared Authorization header without bearer auth", async () => {
    const m = machine({ servers: ["keyed"] });
    writeFileSync(
      join(m.scratch, "fleet/mcp/keyed.json"),
      JSON.stringify({
        kind: "direct",
        url: "https://keyed.example.com/mcp",
        headers: { Authorization: "$CONTEXT7_API_KEY" },
      }),
    );
    for (const f of (await m.check()).findings) if (f.fix !== undefined) await m.run(f.fix.command);
    expect((await m.check()).findings).toEqual([]);
  });
});

describe("mcp area: registering in Claude", () => {
  it("keeps the mode of a config it writes no secret into", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3f-claude-"));
    writeFileSync(join(dir, ".claude.json"), "{}", { mode: 0o644 });
    const result = await Effect.runPromise(
      registerInClaude(dir, "plain", { type: "stdio", command: "p", args: [] }, {}).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );
    expect(result.tightened).toBeNull();
    expect(statSync(join(dir, ".claude.json")).mode & 0o777).toBe(0o644);
  });

  it("takes a multi-line secret from secrets.env whole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3f-claude-"));
    mkdirSync(join(dir, ".config/t3-fleet"), { recursive: true });
    const value = 'line one\nline "two" $x \\ `three`';
    writeFileSync(join(dir, ".config/t3-fleet/secrets.env"), setVar("A=1\n", "MULTI", value));
    expect(parseSecrets(readFileSync(join(dir, ".config/t3-fleet/secrets.env"), "utf8"))).toEqual({
      A: "1",
      MULTI: value,
    });
    await Effect.runPromise(
      registerInClaude(
        dir,
        "multi",
        { type: "stdio", command: "m", args: [], env: { KEY: "$MULTI" } },
        {},
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(
      JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers.multi.env.KEY,
    ).toBe(value);
  });

  const endpoint = {
    type: "http",
    url: "https://q.example.com/mcp?key=$Q",
    tokenEnv: "TOKEN",
    headers: { "X-Odd": "$ODD", "X-Plain": "a $b" },
  } as const;
  const home = (claudeJson: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "t3f-claude-"));
    mkdirSync(join(dir, ".config/t3-fleet"), { recursive: true });
    writeFileSync(join(dir, ".config/t3-fleet/secrets.env"), 'Q=q1\nTOKEN="t\\"o\\\\k"\n');
    if (claudeJson !== null) writeFileSync(join(dir, ".claude.json"), claudeJson, { mode: 0o640 });
    return dir;
  };
  const register = (dir: string, env: Record<string, string>) =>
    Effect.runPromise(
      registerInClaude(dir, "q", endpoint, env).pipe(
        Effect.result,
        Effect.provide(NodeServices.layer),
      ),
    );

  it("replaces only its entry, with every value encoded, making the file its owner's alone", async () => {
    const dir = home(
      JSON.stringify({
        numStartups: 3,
        mcpServers: { keep: { type: "stdio", command: "k" }, q: {} },
      }),
    );
    const result = await register(dir, { ODD: 'line\nbreak "and" \\' });
    expect(result._tag).toBe("Success");
    const after = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    expect(after).toEqual({
      numStartups: 3,
      mcpServers: {
        keep: { type: "stdio", command: "k" },
        q: {
          type: "http",
          url: "https://q.example.com/mcp?key=q1",
          headers: {
            Authorization: 'Bearer t"o\\k',
            "X-Odd": 'line\nbreak "and" \\',
            "X-Plain": "a $b",
          },
        },
      },
    });
    // It holds secrets now: 640 would let the group read them.
    expect(result).toMatchObject({ success: { tightened: 0o640 } });
    expect(statSync(join(dir, ".claude.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.startsWith(".claude.json"))).toEqual([".claude.json"]);
  });

  it("changes nothing when a secret is missing or the file is not JSON", async () => {
    for (const before of [
      '{"mcpServers":{"q":{"type":"http","url":"https://old"}}}',
      "{ not json",
    ]) {
      const dir = home(before);
      const result = await register(dir, before.startsWith("{ not") ? { ODD: "o" } : {});
      expect(result._tag).toBe("Failure");
      expect(readFileSync(join(dir, ".claude.json"), "utf8")).toBe(before);
    }
  });

  it("puts no secret on the fix's command line", () => {
    const [finding] = McpArea.diagnose({
      node: "m",
      desired: {},
      observed: {
        servers: [{ name: "q", endpoint, problem: null, claude: null, codex: null, live: "ok" }],
        clients: { claude: true, codex: false },
      },
      fleet: [],
      authority: null,
    });
    expect(finding?.fix?.command).toBe(
      `t3-fleet mcp register-claude q '${JSON.stringify(endpoint)}'`,
    );
  });
});
