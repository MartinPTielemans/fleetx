// @effect-diagnostics-next-line nodeBuiltinImport:off
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { describe, expect, it } from "vite-plus/test";

import { configDir } from "../Names.ts";
import { onTailnet, RelayArea } from "./RelayArea.ts";

const services = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make(() => Effect.die("no network in this test")),
  ),
);

/** A relay node in a temp HOME whose PATH has only the system's own tools and `bin`. */
const relayNode = (url: string) => {
  const home = mkdtempSync(join(tmpdir(), "t3f-relay-"));
  const checkout = join(home, "fleet");
  const bin = join(home, "bin");
  mkdirSync(join(checkout, "mcp"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(checkout, "mcp/github.json"), '{"kind": "container", "image": "gh"}\n');
  writeFileSync(join(checkout, "mcp/exa.json"), '{"kind": "remote", "url": "https://x"}\n');
  const ctx = {
    home,
    checkout,
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    engine: null,
    engineBuild: null,
    node: "box",
    roles: ["relay"],
    relay: { url, port: 8399 },
  };
  const findings = async () => {
    const observed = await Effect.runPromise(
      RelayArea.observe(null, ctx).pipe(Effect.provide(services)),
    );
    return RelayArea.diagnose({ node: "box", desired: null, observed, fleet: [], authority: null });
  };
  const tool = (name: string, script: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  return { home, findings, tool };
};

describe("the relay before its service", () => {
  it("says what it lacks, and offers no service that would only crash", async () => {
    const node = relayNode("https://box.tail1234.ts.net:8399");
    const findings = await node.findings();
    expect(findings.map((f) => f.key)).toEqual([
      "relay-token-missing",
      "relay-tailscale-missing",
      "relay-docker-missing",
    ]);
    expect(findings[0]?.detail).toContain(
      't3-fleet secrets set T3_FLEET_RELAY_TOKEN="$(openssl rand -hex 32)"',
    );
    expect(findings[2]?.title).toContain("runs github in a container");
    expect(findings.some((f) => f.fix !== undefined)).toBe(false);
  });

  it("offers the service once the token is there, and publishing once Tailscale is", async () => {
    const node = relayNode("https://box.tail1234.ts.net:8399");
    mkdirSync(configDir(node.home), { recursive: true });
    writeFileSync(join(configDir(node.home), "secrets.env"), "T3_FLEET_RELAY_TOKEN=abc123\n");
    node.tool("tailscale", "exit 0");
    node.tool("docker", "exit 0");
    const findings = await node.findings();
    expect(findings.map((f) => f.key)).toEqual(["relay-serve", "relay-unpublished"]);
    expect(findings.every((f) => f.fix?.safe === true)).toBe(true);
  });

  it("needs no Tailscale when the relay is reached some other way", async () => {
    const node = relayNode("https://relay.example.com");
    mkdirSync(configDir(node.home), { recursive: true });
    writeFileSync(join(configDir(node.home), "secrets.env"), "T3_FLEET_RELAY_TOKEN=abc123\n");
    node.tool("docker", "exit 0");
    expect((await node.findings()).map((f) => f.key)).toEqual(["relay-serve"]);
  });
});

describe("a tailnet name", () => {
  it("is a MagicDNS name or a Tailscale address", () => {
    expect(onTailnet("https://box.tail1234.ts.net")).toBe(true);
    expect(onTailnet("http://box:8399")).toBe(true);
    expect(onTailnet("http://100.101.2.3:8399")).toBe(true);
    expect(onTailnet(null)).toBe(true);
    expect(onTailnet("https://relay.example.com")).toBe(false);
    expect(onTailnet("http://localhost:8399")).toBe(false);
    expect(onTailnet("http://192.168.1.4:8399")).toBe(false);
  });
});
