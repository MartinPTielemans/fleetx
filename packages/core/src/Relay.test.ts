// @effect-diagnostics nodeBuiltinImport:off globalFetch:off preferSchemaOverJson:off globalTimers:off globalDate:off
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { generateX25519Identity } from "age-encryption";
import { describe, expect, it } from "vite-plus/test";

import { eventIds, relayLayer } from "./Relay.ts";

const TOKEN = "relay-token-for-relay-tests";

/** One run of the relay over `dir`; `stop` is the restart. */
const startRelay = async (dir: string, identity: string, withApp = false) => {
  const repo = join(dir, "repo");
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
    ...(withApp
      ? { extra: () => HttpRouter.add("GET", "/*", HttpServerResponse.text("the app")) }
      : {}),
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)));
  const web = HttpRouter.toWebHandler(app, { disableLogger: true });
  const request = (path: string, init: RequestInit = {}) =>
    web.handler(
      new Request(`http://127.0.0.1:8399${path}`, {
        ...init,
        headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
      }),
    );
  return { request, stop: () => web.dispose() };
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

  it("replays events to a listener whose `since` is from before a restart, and tells it to pull", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3-fleet-relay-events-"));
    mkdirSync(join(dir, "repo"), { recursive: true });
    execFileSync("git", ["init", "-q", join(dir, "repo")]);
    const identity = await generateX25519Identity();

    const first = await startRelay(dir, identity);
    expect(
      (await first.request("/report", { method: "POST", body: report("box", "aaaaaaa") })).status,
    ).toBe(204);
    expect(
      (await first.request("/report", { method: "POST", body: report("box", "bbbbbbb") })).status,
    ).toBe(204);
    const before = await readEvents(await first.request("/events?since=0"), (f) => f.length >= 2);
    const since = before.at(-1)?.id ?? 0;
    expect(since).toBeGreaterThan(0);
    await first.stop();

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await startRelay(dir, identity);
    try {
      expect(
        (await second.request("/report", { method: "POST", body: report("omarchy", "ccccccc") }))
          .status,
      ).toBe(204);
      const after = await readEvents(await second.request(`/events?since=${since}`), (f) =>
        f.some((e) => e.event === "pull"),
      );
      expect(after.map((e) => [e.event, e.data.node ?? null])).toEqual([
        ["state", "omarchy"],
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
        acknowledged: [],
      });
      expect(
        (
          await relay.request("/fixes", {
            method: "POST",
            body,
            headers: { authorization: "Bearer wrong" },
          })
        ).status,
      ).toBe(401);
      const created = await relay.request("/fixes", { method: "POST", body });
      expect(created.status).toBe(202);
      const { id } = JSON.parse(await created.text()) as { id: string };
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
      const progress = (state: string) =>
        relay.request(`/fixes/${id}/progress`, {
          method: "POST",
          body: JSON.stringify({ state, step: null, result: null, error: null }),
        });
      expect((await progress("done")).status).toBe(409);
      expect((await progress("running")).status).toBe(204);
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
