// A plain test writing temp files; the effect under test runs with Node's services and a fake HTTP client.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { lookupLatest } from "./Latest.ts";

const NIGHTLY = "0.0.46-nightly.20261003.2623";

interface Seen {
  readonly url: string;
  readonly ifNoneMatch: string | undefined;
}

/** A registry and GitHub that answer `github` for the releases index and count what is asked. */
const fake = (github: { status: number; etag?: string }, down = false) => {
  const seen: Array<Seen> = [];
  const layer = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request, url) => {
      seen.push({ url: url.toString(), ifNoneMatch: request.headers["if-none-match"] });
      const reply = (status: number, body: string, headers: Record<string, string> = {}) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(status === 304 ? null : body, { status, headers }),
          ),
        );
      if (down) return reply(503, "");
      if (url.hostname === "registry.npmjs.org")
        return reply(200, JSON.stringify({ version: "9.9.9" }), { etag: '"npm"' });
      if (request.headers["if-none-match"] === github.etag && github.etag !== undefined)
        return reply(304, "");
      return reply(
        github.status,
        JSON.stringify([{ tag_name: `v${NIGHTLY}` }]),
        github.etag === undefined ? {} : { etag: github.etag },
      );
    }),
  );
  return { seen, layer };
};

const lookup = (cache: string, layer: Layer.Layer<HttpClient.HttpClient>) =>
  Effect.runPromise(
    lookupLatest([NIGHTLY], cache).pipe(Effect.provide(Layer.merge(layer, NodeServices.layer))),
  );

describe("lookupLatest", () => {
  let token: string | undefined;
  beforeEach(() => {
    token = process.env["GITHUB_TOKEN"];
    // Never spawn `gh auth token` from a test.
    process.env["GITHUB_TOKEN"] = "test-token";
  });
  afterEach(() => {
    if (token === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = token;
  });

  it("answers from its cache for 15 minutes, then revalidates with the ETag", async () => {
    const cache = join(mkdtempSync(join(tmpdir(), "t3-fleet-latest-")), "latest.json");
    const github = fake({ status: 200, etag: '"r1"' });
    const first = await lookup(cache, github.layer);
    expect(first.t3.nightly?.versions[0]).toBe(NIGHTLY);
    expect(github.seen).toHaveLength(3);
    const second = await lookup(cache, github.layer);
    expect(second).toEqual(first);
    expect(github.seen).toHaveLength(3);
    // Fifteen minutes later: asked again, conditionally, and a 304 keeps the answer.
    const entries = JSON.parse(readFileSync(cache, "utf8")) as Record<string, { at: number }>;
    for (const entry of Object.values(entries)) entry.at -= 16 * 60 * 1000;
    writeFileSync(cache, JSON.stringify(entries));
    const third = await lookup(cache, github.layer);
    expect(third.t3.nightly?.versions[0]).toBe(NIGHTLY);
    expect(github.seen.slice(3).find((s) => s.url.includes("api.github.com"))?.ifNoneMatch).toBe(
      '"r1"',
    );
  });

  it("keeps answering from an hours-old lookup while offline, but not from one days old", async () => {
    const cache = join(mkdtempSync(join(tmpdir(), "t3-fleet-latest-")), "latest.json");
    await lookup(cache, fake({ status: 200 }).layer);
    const age = (ms: number) => {
      const entries = JSON.parse(readFileSync(cache, "utf8")) as Record<string, { at: number }>;
      for (const entry of Object.values(entries)) entry.at -= ms;
      writeFileSync(cache, JSON.stringify(entries));
    };
    age(2 * 60 * 60 * 1000);
    const hours = await lookup(cache, fake({ status: 200 }, true).layer);
    expect(hours.t3.nightly?.versions[0]).toBe(NIGHTLY);
    expect(hours.failed).toBeUndefined();
    age(2 * 24 * 60 * 60 * 1000);
    const days = await lookup(cache, fake({ status: 200 }, true).layer);
    expect(days.t3.nightly).toBeUndefined();
    expect(days.agents.claude).toBeNull();
    expect(days.failed?.t3).toBe("api.github.com answered 503; the last answer is 2 days old");
  });

  it("says why the releases are unknown, rather than nothing", async () => {
    const cache = join(mkdtempSync(join(tmpdir(), "t3-fleet-latest-")), "latest.json");
    const latest = await lookup(cache, fake({ status: 403 }).layer);
    expect(latest.t3.nightly).toBeUndefined();
    expect(latest.failed?.t3).toContain("60 anonymous requests an hour");
  });
});
