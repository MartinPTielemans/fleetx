// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { loadConfigFrom } from "@t3-fleet/core/Config";

import { mcpOf, servingOf } from "./relay.ts";

describe("what the relay serves from", () => {
  it("follows the MCP hub as it changes, and restarts only for its port or address", async () => {
    const repo = mkdtempSync(join(tmpdir(), "t3-fleet-relay-serving-"));
    mkdirSync(join(repo, "nodes"));
    writeFileSync(join(repo, "nodes/hub.toml"), 'roles = ["member", "relay"]\n');
    const fleet = (extra: string) =>
      writeFileSync(
        join(repo, "t3-fleet.toml"),
        `[relay]\nurl = "https://hub.tailnet.ts.net:8399"\nport = 8399\n${extra}`,
      );
    const read = () =>
      Effect.runPromise(loadConfigFrom(repo, "hub").pipe(Effect.provide(NodeServices.layer)));
    fleet("");
    const before = await read();
    expect(mcpOf(before)).toEqual({ enabled: false, ports: {} });
    // hostMcp: [defaults.mcp] hub. The hub follows it (Hub.ts serving); the relay keeps running.
    fleet('\n[defaults.mcp]\nhub = true\ngateway = "https://hub.tailnet.ts.net:8399"\n');
    const hosting = await read();
    expect(mcpOf(hosting)).toEqual({ enabled: true, ports: {} });
    expect(servingOf(hosting)).toBe(servingOf(before));
    // Where it listens is read only as it starts: that restarts it.
    writeFileSync(
      join(repo, "t3-fleet.toml"),
      '[relay]\nurl = "https://hub.tailnet.ts.net:8399"\nport = 8400\n',
    );
    expect(servingOf(await read())).not.toBe(servingOf(before));
  });
});
