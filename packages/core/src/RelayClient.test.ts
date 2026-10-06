// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadConfigFrom } from "./Config.ts";
import { listen, redactSecrets } from "./RelayClient.ts";

describe("redactSecrets", () => {
  it("takes out a secret that begins with another whole, whichever is listed first", () => {
    const secrets = new Map([
      ["SHORT", "abcdef"],
      ["LONG", "abcdef-secret-tail"],
      ["SAME", "abcdef"],
      ["TINY", "abc"],
    ]);
    expect(redactSecrets("token abcdef-secret-tail and abcdef, abc", secrets)).toBe(
      "token ••• and •••, abc",
    );
  });
});

describe("listen", () => {
  const originalHome = process.env["HOME"];
  afterEach(() => {
    process.env["HOME"] = originalHome;
  });

  it("catches up on the fleet before it subscribes, so nothing reported meanwhile is taken as seen", async () => {
    const home = mkdtempSync(join(tmpdir(), "t3-fleet-listen-"));
    process.env["HOME"] = home;
    mkdirSync(join(home, ".config/t3-fleet"), { recursive: true });
    writeFileSync(join(home, ".config/t3-fleet/secrets.env"), "T3_FLEET_RELAY_TOKEN=token-123\n");
    const repo = join(home, "fleet");
    mkdirSync(join(repo, "nodes"), { recursive: true });
    writeFileSync(join(repo, "nodes/laptop.toml"), 'roles = ["member"]\n');
    writeFileSync(
      join(repo, "t3-fleet.toml"),
      '[relay]\nurl = "http://hub.example"\n\n[notify]\ndesktop = ["laptop"]\n',
    );
    const asked: Array<string> = [];
    // A relay with nothing to report: /fleet empty, /events open briefly, then closed.
    const server = createServer((req, res) => {
      asked.push(req.url ?? "");
      if (req.url === "/fleet") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        setTimeout(() => res.end(), 100);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const config = yield* loadConfigFrom(repo, "laptop");
          yield* listen(
            config,
            () => Effect.void,
            () => Effect.void,
            undefined,
            `http://127.0.0.1:${port}`,
          ).pipe(Effect.timeout("1 second"), Effect.ignore);
        }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(asked.slice(0, 2)).toEqual(["/fleet", "/events?since=0"]);
  });
});
