// @effect-diagnostics nodeBuiltinImport:off globalFetch:off preferSchemaOverJson:off globalTimers:off globalDate:off
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { generateX25519Identity } from "age-encryption";
import { describe, expect, it } from "vite-plus/test";

import { eventIds, relayLayer, snapshotThenLive, type RelayHandle } from "./Relay.ts";

const TOKEN = "relay-token-for-relay-tests";

/** One run of the relay over `dir`; `stop` is the restart; `handle` what the app beside it gets. */
const startRelay = async (dir: string, identity: string, withApp = false) => {
  const repo = join(dir, "repo");
  let handle: RelayHandle | undefined;
  const app = relayLayer({
    token: TOKEN,
    repo,
    branch: "main",
    pollEvery: Duration.hours(1),
    hub: {
      repo,
      home: dir,
      enabled: false,
      ports: {},
      relayUrl: null,
      identity,
      version: "test",
      stateDir: join(dir, "state"),
    },
    // Stands in for the app (HubUi.ts): it answers every path the relay does not.
    extra: (relay) => {
      handle = relay;
      return withApp
        ? HttpRouter.add("GET", "/*", HttpServerResponse.text("the app"))
        : Layer.empty;
    },
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)));
  const web = HttpRouter.toWebHandler(app, { disableLogger: true });
  const request = (path: string, init: RequestInit = {}) =>
    web.handler(
      new Request(`http://127.0.0.1:8399${path}`, {
        ...init,
        headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
      }),
    );
  // The routes (and the handle) are built on the first request.
  await request("/health");
  if (handle === undefined) throw new Error("the relay gave the app no handle");
  return { request, handle, stop: () => web.dispose() };
};

const report = (node: string, rev: string) =>
  JSON.stringify({
    node,
    at: 1,
    result: "ok",
    streak: 0,
    message: "synced",
    rev,
    observation: null,
    findings: [],
    applied: [],
    alerts: [],
  });

interface Frame {
  readonly id: number | null;
  readonly event: string;
  readonly data: { readonly type: string; readonly node?: string; readonly rev?: string };
}

/** Read /events until `done` holds for the frames so far (or two seconds pass). */
const readEvents = async (response: Response, done: (frames: ReadonlyArray<Frame>) => boolean) => {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames: Array<Frame> = [];
  let buffer = "";
  const deadline = Date.now() + 2000;
  while (!done(frames) && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    if (chunk === null) continue;
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const text = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const id = /^id: (\d+)$/m.exec(text)?.[1];
      const event = /^event: (\w+)$/m.exec(text)?.[1];
      const data = /^data: (.*)$/m.exec(text)?.[1];
      if (event !== undefined && data !== undefined)
        frames.push({
          id: id === undefined ? null : Number(id),
          event,
          data: JSON.parse(data) as Frame["data"],
        });
    }
  }
  await reader.cancel();
  return frames;
};

describe("relay events", () => {
  it("knows which `since` it can replay exactly", () => {
    const ids = eventIds(1_000);
    const kept = [{ id: ids.first + 3 }, { id: ids.first + 4 }];
    expect(ids.knows(0, kept, ids.first + 5)).toBe(true);
    expect(ids.knows(ids.first + 3, kept, ids.first + 5)).toBe(true);
    expect(ids.knows(ids.first + 2, kept, ids.first + 5)).toBe(true);
    // Events after it were dropped from the buffer.
    expect(ids.knows(ids.first + 1, kept, ids.first + 5)).toBe(false);
    // Another run's: earlier, or ahead of anything this run handed out.
    expect(ids.knows(37, kept, ids.first + 5)).toBe(false);
    expect(ids.knows(ids.first + 5, kept, ids.first + 5)).toBe(false);
    // Nothing happened yet in this run: only its own starting point is known.
    expect(ids.knows(ids.first - 1, [], ids.first)).toBe(true);
    expect(eventIds(1_001).first).toBeGreaterThan(ids.first + 999);
  });

  it("loses no event emitted while a listener's snapshot is read, and sends none twice", async () => {
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<{ readonly id: number }>();
        const snapshot = Effect.gen(function* () {
          // 2 was kept before the snapshot read the events, 3 after: both are published meanwhile.
          yield* PubSub.publish(pubsub, { id: 2 });
          yield* PubSub.publish(pubsub, { id: 3 });
          return { replay: [{ id: 1 }, { id: 2 }], kept: [{ id: 1 }, { id: 2 }] };
        });
        return yield* snapshotThenLive(pubsub, snapshot).pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.timeout("2 seconds"),
        );
      }),
    );
    expect(got.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("replays events to a listener whose `since` is from before a restart, and tells it to pull", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3-fleet-relay-events-"));
    mkdirSync(join(dir, "repo"), { recursive: true });
    execFileSync("git", ["init", "-q", join(dir, "repo")]);
    const identity = await generateX25519Identity();

    const first = await startRelay(dir, identity);
    expect(
      (await first.request("/report", { method: "POST", body: report("hub", "aaaaaaa") })).status,
    ).toBe(204);
    expect(
      (await first.request("/report", { method: "POST", body: report("hub", "bbbbbbb") })).status,
    ).toBe(204);
    const before = await readEvents(await first.request("/events?since=0"), (f) => f.length >= 2);
    const since = before.at(-1)?.id ?? 0;
    expect(since).toBeGreaterThan(0);
    await first.stop();

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await startRelay(dir, identity);
    try {
      expect(
        (await second.request("/report", { method: "POST", body: report("desktop", "ccccccc") }))
          .status,
      ).toBe(204);
      const after = await readEvents(await second.request(`/events?since=${since}`), (f) =>
        f.some((e) => e.event === "pull"),
      );
      expect(after.map((e) => [e.event, e.data.node ?? null])).toEqual([
        ["state", "desktop"],
        ["pull", null],
      ]);
      // Ids rise across the restart, and the listener's next `since` is one this run knows.
      expect(after[0]?.id).toBeGreaterThan(since);
      const resumed = await readEvents(
        await second.request("/events", { headers: { "last-event-id": String(after.at(-1)?.id) } }),
        () => false,
      );
      expect(resumed).toEqual([]);
    } finally {
      await second.stop();
    }
  }, 15_000);
});

describe("fix requests", () => {
  it("announces a request to its node, which claims it once and answers it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3-fleet-relay-fixes-"));
    mkdirSync(join(dir, "repo"), { recursive: true });
    execFileSync("git", ["init", "-q", join(dir, "repo")]);
    const relay = await startRelay(dir, await generateX25519Identity());
    try {
      const body = JSON.stringify({
        node: "laptop",
        fixes: [{ id: "laptop:claude-behind", digest: "d".repeat(64) }],
        acknowledged: ["laptop:claude-behind"],
      });
      // Every member holds the relay token: with it, no one asks a machine to run a fix.
      for (const authorization of [`Bearer ${TOKEN}`, "Bearer wrong"]) {
        const asked = await relay.request("/fixes", {
          method: "POST",
          body,
          headers: { authorization },
        });
        expect(asked.status).toBeGreaterThanOrEqual(400);
      }
      expect(
        (await readEvents(await relay.request("/events?since=0"), () => false)).filter(
          (e) => e.event === "fix",
        ),
      ).toEqual([]);
      // The app beside the relay asks, in this process.
      const { id } = await Effect.runPromise(
        relay.handle.fixes.request({
          node: "laptop",
          fixes: [{ id: "laptop:claude-behind", digest: "d".repeat(64) }],
          acknowledged: [],
        }),
      );
      const events = await readEvents(await relay.request("/events?since=0"), (f) =>
        f.some((e) => e.event === "fix"),
      );
      // Only the node and the request: what it asks for is fetched with the token.
      expect(events.find((e) => e.event === "fix")?.data).toMatchObject({
        type: "fix",
        node: "laptop",
        request: id,
      });
      expect(JSON.stringify(events)).not.toContain("claude-behind");
      const mine = "a".repeat(32);
      const theirs = "b".repeat(32);
      const progress = (state: string, claim = mine) =>
        relay.request(`/fixes/${id}/progress`, {
          method: "POST",
          body: JSON.stringify({ state, step: null, result: null, error: null, claim }),
        });
      // A report without a claim (a listener from before claims) is refused, and runs nothing.
      expect(
        (
          await relay.request(`/fixes/${id}/progress`, {
            method: "POST",
            body: JSON.stringify({ state: "running", step: null, result: null, error: null }),
          })
        ).status,
      ).toBe(400);
      expect((await progress("done")).status).toBe(409);
      expect((await progress("running")).status).toBe(204);
      // Claimed: a second run, with its own claim, is refused, its progress too.
      expect((await progress("running", theirs)).status).toBe(409);
      expect((await progress("done", theirs)).status).toBe(409);
      // The claim is never handed out with the request.
      expect(await (await relay.request(`/fixes/${id}`)).text()).not.toContain(mine);
      expect((await progress("done")).status).toBe(204);
      expect((await progress("running")).status).toBe(409);
      const record = JSON.parse(await (await relay.request(`/fixes/${id}`)).text()) as {
        state: string;
      };
      expect(record.state).toBe("done");
      expect((await relay.request("/fixes/nope")).status).toBe(404);
    } finally {
      await relay.stop();
    }
  }, 15_000);
});

describe("the app beside the relay", () => {
  it("answers only what the relay's own routes do not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3-fleet-relay-app-"));
    mkdirSync(join(dir, "repo"), { recursive: true });
    execFileSync("git", ["init", "-q", join(dir, "repo")]);
    const relay = await startRelay(dir, await generateX25519Identity(), true);
    try {
      expect(await (await relay.request("/health")).text()).toBe("ok");
      expect(await (await relay.request("/fleet")).text()).toBe("[]");
      expect(await (await relay.request("/fixes/nope")).text()).toBe("No such request");
      expect(await (await relay.request("/mcp/linear")).text()).not.toBe("the app");
      expect(await (await relay.request("/hub/servers")).text()).not.toBe("the app");
      expect(await (await relay.request("/")).text()).toBe("the app");
      expect(await (await relay.request("/environments")).text()).toBe("the app");
    } finally {
      await relay.stop();
    }
  }, 15_000);
});
