// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { loadConfigFrom } from "@t3-fleet/core/Config";

import { servingOf } from "./relay.ts";

describe("what the relay serves from", () => {
  it("changes when the hub starts hosting the fleet's MCP servers, and not for anything else", async () => {
    const repo = mkdtempSync(join(tmpdir(), "t3-fleet-relay-serving-"));
    mkdirSync(join(repo, "nodes"));
    writeFileSync(join(repo, "nodes/hub.toml"), 'roles = ["member", "relay"]\n');
    const fleet = (extra: string) =>
      writeFileSync(
        join(repo, "t3-fleet.toml"),
        `[relay]\nurl = "https://hub.tailnet.ts.net:8399"\nport = 8399\n${extra}`,
      );
    const serving = () =>
      Effect.runPromise(
        loadConfigFrom(repo, "hub").pipe(Effect.map(servingOf), Effect.provide(NodeServices.layer)),
      );
    fleet("");
    const before = await serving();
    // A change the relay follows while it runs (who may open its app): no restart.
    fleet('\n[ui]\nallow = ["me@example.com"]\n');
    expect(await serving()).toBe(before);
    // hostMcp: [defaults.mcp] hub, read only as it starts.
    fleet('\n[defaults.mcp]\nhub = true\ngateway = "https://hub.tailnet.ts.net:8399"\n');
    expect(await serving()).not.toBe(before);
  });
});
