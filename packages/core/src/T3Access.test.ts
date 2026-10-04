// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { describe, expect, it } from "vite-plus/test";

import { mintAccess, t3AccessAttemptPath, t3AccessPath } from "./T3Access.ts";

/** T3's CLI and token endpoint, faked: the endpoint grants `expiresIn` seconds. */
const mint = (expiresIn: number) => {
  const home = mkdtempSync(join(tmpdir(), "t3f-access-"));
  const t3 = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              access_token: "tok",
              expires_in: expiresIn,
              scope: "orchestration:read",
            }),
          ),
        ),
      ),
    ),
  );
  const cli = { command: "/bin/sh", args: ["-c", `echo '{"credential":"pair"}'`, "t3"], env: {} };
  const result = Effect.runPromise(
    mintAccess({ home, origin: "http://127.0.0.1:3773", cli, now: 1_000 }).pipe(
      Effect.result,
      Effect.provide(Layer.mergeAll(NodeServices.layer, t3)),
    ),
  );
  return { home, result };
};

describe("mintAccess", () => {
  it("records the attempt and keeps a 30-day token", async () => {
    const { home, result } = mint(30 * 86_400);
    expect((await result)._tag).toBe("Success");
    expect(readFileSync(t3AccessAttemptPath(home), "utf8").trim()).toBe("1000");
    expect(existsSync(t3AccessPath(home))).toBe(true);
  });

  it("does not count a token due for renewal at once as renewed", async () => {
    const { home, result } = mint(2 * 86_400);
    const outcome = await result;
    expect(outcome._tag).toBe("Failure");
    expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain(
      "valid for only 48 hours",
    );
    expect(readFileSync(t3AccessAttemptPath(home), "utf8").trim()).toBe("1000");
  });
});
