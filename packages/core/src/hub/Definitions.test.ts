// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { makeCallLog } from "./Calls.ts";
import { expandSecrets, parseDefinition } from "./Definitions.ts";
import { makeSseParser } from "./JsonRpc.ts";
import { constantTimeEqual, isDenied } from "./Policy.ts";

describe("hub definitions", () => {
  it("reads the existing JSON, ignoring ToolHive-only fields", () => {
    const remote = parseDefinition(
      "posthog",
      JSON.stringify({
        kind: "remote",
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        remote_auth: true,
        remote_auth_scopes: ["openid", "query:read"],
        remote_auth_callback_port: 8666,
        remote_auth_timeout: "60m",
        registry_ref: "io.example/posthog",
        proxy_path: "/",
      }),
    );
    expect(remote).toMatchObject({ kind: "remote", runner: { type: "remote", url: "https://mcp.example.com/mcp" }, auth: { type: "oauth", scopes: ["openid", "query:read"], client: null } });
    expect(parseDefinition("fetch", JSON.stringify({ kind: "container", image: "ghcr.io/example/fetch:1", transport: "streamable-http" }))).toMatchObject({
      runner: { type: "docker-http", image: "ghcr.io/example/fetch:1", targetPort: 8080, path: "/mcp" },
      auth: { type: "none" },
    });
    expect(parseDefinition("docs", JSON.stringify({ kind: "registry", image: "ghcr.io/example/docs:1", transport: "stdio", network: "none", env: { KEY: "$DOCS_KEY" } }))).toMatchObject({
      runner: { type: "docker-stdio", network: "none", env: { KEY: "$DOCS_KEY" } },
    });
    expect(
      parseDefinition("s", JSON.stringify({ kind: "remote", url: "https://s/mcp", oauth: { client_id: "abc", client_secret_env: "S_SECRET", issuer: "https://auth.s" }, tools: { deny: ["delete_*"] } })),
    ).toMatchObject({ auth: { type: "oauth", client: { clientId: "abc", clientSecretEnv: "S_SECRET", issuer: "https://auth.s" } }, deny: ["delete_*"] });
    expect(parseDefinition("b", JSON.stringify({ kind: "remote", url: "https://b/mcp", auth: { type: "bearer", token_env: "B_TOKEN" } }))).toMatchObject({ auth: { type: "bearer", tokenEnv: "B_TOKEN" } });
  });

  it("explains what it cannot serve", () => {
    expect(parseDefinition("x", JSON.stringify({ kind: "stdio", command: "x" }))).toEqual({ problem: "kind stdio is not hosted" });
    expect(parseDefinition("x", JSON.stringify({ kind: "remote" }))).toEqual({ problem: "remote definition has no url" });
    expect(parseDefinition("x", JSON.stringify({ kind: "remote", url: "file:///etc/passwd" }))).toMatchObject({ problem: expect.stringMatching(/http/) });
    expect(parseDefinition("x", JSON.stringify({ kind: "container", image: "i", network: "none" }))).toMatchObject({ problem: expect.stringMatching(/stdio/) });
    expect(parseDefinition("x", JSON.stringify({ kind: "remote", url: "http://mcp.example.com/mcp" }))).toMatchObject({ problem: expect.stringMatching(/https/) });
    expect(parseDefinition("x", JSON.stringify({ kind: "remote", url: "http://127.0.0.1:9/mcp" }))).toMatchObject({ runner: { type: "remote" } });
    expect(parseDefinition("x", JSON.stringify({ kind: "remote", url: "http://box.tailnet.ts.net:3000/mcp" }))).toMatchObject({ runner: { type: "remote" } });
    expect(parseDefinition("x", JSON.stringify({ kind: "remote", url: "https://s/mcp", oauth: { client_id: "abc" } }))).toMatchObject({ problem: expect.stringMatching(/issuer/) });
    expect(parseDefinition("x", JSON.stringify({ kind: "container", image: "--privileged" }))).toMatchObject({ problem: expect.stringMatching(/not an image/) });
    expect(parseDefinition("x", JSON.stringify({ kind: "registry", image: "-v/:/host", transport: "stdio" }))).toMatchObject({ problem: expect.stringMatching(/not an image/) });
    expect(parseDefinition("Bad Name", "{}")).toMatchObject({ problem: expect.stringMatching(/not a valid server name/) });
  });

  it("fills environments from the fleet's secrets", () => {
    expect(expandSecrets("Bearer $A and ${B}, not $c", { A: "1", B: "2" })).toBe("Bearer 1 and 2, not $c");
  });
});

describe("hub policy", () => {
  it("matches deny patterns as globs", () => {
    expect(isDenied(["delete_*", "drop"], "delete_all")).toBe(true);
    expect(isDenied(["delete_*", "drop"], "drop")).toBe(true);
    expect(isDenied(["delete_*", "drop"], "dropper")).toBe(false);
    expect(isDenied(["a.b"], "axb")).toBe(false);
    expect(isDenied([], "anything")).toBe(false);
  });

  it("compares tokens in constant time without false positives", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("parses SSE split across chunks", () => {
    const parse = makeSseParser();
    expect(parse("event: message\ndata: {\"a\"")).toEqual([]);
    expect(parse(":1}\n\n: comment\n\ndata: x\r\ndata: y\r\n\r\n")).toEqual([
      { event: "message", id: null, data: '{"a":1}' },
      { event: null, id: null, data: "x\ny" },
    ]);
  });
});

describe("hub call log", () => {
  it("keeps a ring of recent calls and a bounded private file that survives a restart", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "fleetx-calls-")), "hub/calls.jsonl");
    const call = (i: number) => ({ at: i, server: i % 2 === 0 ? "a" : "b", client: "relay", method: "tools/call", tool: "t", durationMs: 1, outcome: "ok" as const, error: null });
    const recent = await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* makeCallLog(file, { capacity: 10, maxBytes: 2000 });
        for (let i = 0; i < 40; i++) yield* log.record(call(i));
        return yield* log.list({ server: "a", limit: 3 });
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(recent.map((c) => c.at)).toEqual([38, 36, 34]);
    expect(readFileSync(file, "utf8").length).toBeLessThanOrEqual(2000);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const reloaded = await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* makeCallLog(file, { capacity: 10, maxBytes: 2000 });
        return yield* log.list({});
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(reloaded[0]?.at).toBe(39);
  });
});
