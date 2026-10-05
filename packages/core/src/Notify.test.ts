// Real filesystem persistence and a throwaway HTTP sink; desktop transports are always fake.
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off preferSchemaOverJson:off
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadConfigFrom, type Config } from "./Config.ts";
import {
  alertIdentity,
  deliverAlerts,
  deliveryChannels,
  desktopCommand,
  notificationStatus,
  ntfySend,
  testNotification,
  type Notification,
  NotifyError,
} from "./Notify.ts";
import type { Alert, NodeState } from "./State.ts";

const layer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
const run = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices | HttpClient.HttpClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
const dirs: Array<string> = [];
const originalHome = process.env["HOME"];
afterEach(() => {
  process.env["HOME"] = originalHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const home = () => {
  const dir = mkdtempSync("/var/tmp/wiznot-unit-");
  dirs.push(dir);
  return dir;
};
const config = (relay = true, self = "laptop"): Config => ({
  repo: "/var/tmp/wiznot-fleet",
  self,
  checkout: "~/fleet",
  branch: "main",
  interval: 900,
  alertAfter: 3,
  nodes: [
    {
      name: "laptop",
      ssh: null,
      roles: ["member"],
      profiles: [],
      tailnet: null,
      settings: { table: {}, provenance: new Map() },
    },
    {
      name: "hub",
      ssh: "hub",
      roles: ["relay"],
      profiles: [],
      tailnet: null,
      settings: { table: {}, provenance: new Map() },
    },
  ],
  settings: {
    notify: { desktop: ["laptop"], ntfy: "PUSH_URL" },
    ...(relay ? { relay: { url: "http://hub.tailnet.ts.net" } } : {}),
  },
});
const alert = (
  node = "laptop",
  at = 1_000,
  message = "provider unhealthy",
  kind: Alert["kind"] = "problem",
): Alert => ({ node, at, message, kind });
const state = (...alerts: Array<Alert>): NodeState => ({
  node: alerts[0]?.node ?? "laptop",
  at: 1_000,
  rev: "abc",
  result: "ok",
  streak: 0,
  message: "synced",
  observation: null,
  findings: [],
  applied: [],
  alerts,
});
const fake =
  (received: Array<{ channel: string; n: Notification }>) => (channel: string, n: Notification) =>
    Effect.sync(() => {
      received.push({ channel, n });
      return "delivered";
    });
/** A relay or listener that has run before: its first catch-up, with nothing published yet, is behind it. */
const started = (dir: string, c: Config = config(), source: "relay" | "listen" = "listen") =>
  run(deliverAlerts(c, [], source, { home: dir, now: 0, catchUp: true, send: fake([]) }));

it("decodes the agreed optional notify schema", async () => {
  const dir = home();
  mkdirSync(join(dir, "nodes"));
  writeFileSync(join(dir, "nodes/laptop.toml"), 'roles = ["authority"]');
  writeFileSync(
    join(dir, "t3-fleet.toml"),
    '[notify]\ndesktop = ["laptop"]\nntfy = "T3_FLEET_NTFY_URL"',
  );
  expect((await run(loadConfigFrom(dir, "laptop"))).settings.notify).toEqual({
    desktop: ["laptop"],
    ntfy: "T3_FLEET_NTFY_URL",
  });
});

describe("routing", () => {
  it("only the relay pushes for the fleet, selected desktops listen", () => {
    expect(deliveryChannels(config(), "sync")).toEqual([]);
    expect(deliveryChannels(config(), "listen")).toEqual(["desktop"]);
    expect(deliveryChannels(config(true, "hub"), "relay")).toEqual(["ntfy"]);
    expect(deliveryChannels(config(), "relay")).toEqual([]);
    expect(deliveryChannels({ ...config(), settings: {} }, "sync")).toEqual([]);
  });
  it("without a relay, sync delivers only this node's own alerts", async () => {
    const received: Array<{ channel: string; n: Notification }> = [];
    await run(
      deliverAlerts(config(false), [state(alert()), state(alert("other"))], "sync", {
        home: home(),
        now: 1_001,
        send: fake(received),
      }),
    );
    expect(received.map((r) => r.channel)).toEqual(["ntfy", "desktop"]);
    expect(received.every((r) => r.n.title.includes("laptop"))).toBe(true);
    expect(deliveryChannels(config(false, "hub"), "sync")).toEqual(["ntfy"]);
  });
});

it("dedupes resync, two concurrent listeners, and restart with a fresh caller", async () => {
  const dir = home();
  await started(dir);
  const received: Array<{ channel: string; n: Notification }> = [];
  const deliver = () =>
    deliverAlerts(config(), [state(alert())], "listen", {
      home: dir,
      now: 1_001,
      send: fake(received),
    });
  await run(Effect.all([deliver(), deliver()], { concurrency: "unbounded" }));
  await run(deliver()); // new invocation, no process-local dedupe state
  expect(received).toHaveLength(1);
  await run(
    deliverAlerts(config(), [state(alert("laptop", 1_000, "another problem"))], "listen", {
      home: dir,
      now: 1_001,
      send: fake(received),
    }),
  );
  expect(received).toHaveLength(2); // same timestamp, different identity
  await run(
    deliverAlerts(config(), [state(alert())], "listen", {
      home: dir,
      now: 1_001,
      send: fake(received),
    }),
  );
  expect(received).toHaveLength(2); // previously delivered old state never replays
  await run(
    deliverAlerts(config(), [state(alert("laptop", 999, "new after clock correction"))], "listen", {
      home: dir,
      now: 1_001,
      send: fake(received),
    }),
  );
  expect(received).toHaveLength(3);
});

it("sends one catch-up summary after sleep and does not replay event frames", async () => {
  const dir = home();
  await started(dir);
  const received: Array<{ channel: string; n: Notification }> = [];
  const states = [
    state(alert(), alert("laptop", 2_000, "provider healthy", "resolved")),
    state(alert("other", 3_000)),
  ];
  await run(
    deliverAlerts(config(), states, "listen", {
      home: dir,
      now: 4_000,
      catchUp: true,
      send: fake(received),
    }),
  );
  await run(
    deliverAlerts(config(), states, "listen", { home: dir, now: 4_000, send: fake(received) }),
  );
  expect(received).toHaveLength(1);
  expect(received[0]?.n.title).toContain("3 alerts since last delivery");
  expect(received[0]?.n.body).toContain("2 problems, 1 resolved");
});

it("summarizes old backlog even after a cold start", async () => {
  const received: Array<{ channel: string; n: Notification }> = [];
  const dir = home();
  await started(dir);
  await run(
    deliverAlerts(config(), [state(alert(), alert("laptop", 2_000))], "listen", {
      home: dir,
      now: 200_000,
      send: fake(received),
    }),
  );
  expect(received).toHaveLength(1);
  expect(received[0]?.n.title).toContain("2 alerts since last delivery");
});

it("keeps a failed delivery eligible and surfaces failure without secret transport details", async () => {
  const dir = home();
  process.env["HOME"] = dir;
  const c = { ...config(), settings: { notify: { desktop: ["laptop"] }, relay: {} } };
  await started(dir, c);
  const lines = await run(
    deliverAlerts(c, [state(alert())], "listen", {
      home: dir,
      now: 1_001,
      send: () =>
        Effect.fail(new NotifyError({ message: "desktop notifier failed", retryable: false })),
    }),
  );
  expect(lines).toContain("desktop: desktop notifier failed");
  expect(await run(notificationStatus(c))).toContain("notify desktop: desktop notifier failed");
  const received: Array<{ channel: string; n: Notification }> = [];
  await run(
    deliverAlerts(c, [state(alert())], "listen", { home: dir, now: 1_001, send: fake(received) }),
  );
  expect(received).toHaveLength(1);
});

it("never resets a corrupt ledger and retains an interrupted claim", async () => {
  const dir = home();
  process.env["HOME"] = dir;
  await started(dir);
  const received: Array<{ channel: string; n: Notification }> = [];
  await run(
    deliverAlerts(config(), [state(alert())], "listen", {
      home: dir,
      now: 1_001,
      send: fake(received),
    }),
  );
  const { readdirSync } = await import("node:fs");
  const path = join(
    dir,
    ".local/state/t3-fleet",
    readdirSync(join(dir, ".local/state/t3-fleet")).find((f) => f.endsWith(".json"))!,
  );
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  ledger.desktop.status = "delivery interrupted or in progress; receipt unconfirmed";
  writeFileSync(path, JSON.stringify(ledger));
  await run(
    deliverAlerts(config(), [state(alert())], "listen", {
      home: dir,
      now: 1_001,
      send: fake(received),
    }),
  );
  expect(received).toHaveLength(1);
  expect(await run(notificationStatus(config()))).toContain(
    "notify desktop: delivery interrupted or in progress; receipt unconfirmed",
  );
  writeFileSync(path, "corrupt");
  expect(
    await run(
      deliverAlerts(config(), [state(alert())], "listen", { home: dir, send: fake(received) }),
    ),
  ).toEqual(["notifications: cannot read or persist delivery ledger"]);
  expect(received).toHaveLength(1);
});

it("takes what was published before a relay or listener first ran as seen, then delivers what comes", async () => {
  const dir = home();
  const received: Array<{ channel: string; n: Notification }> = [];
  // Before the relay: laptop delivered its own; hub's waited for nobody.
  const before = [state(alert(), alert("laptop", 2_000)), state(alert("hub", 3_000))];
  const first = await run(
    deliverAlerts(config(true, "hub"), before, "relay", {
      home: dir,
      now: 4_000,
      catchUp: true,
      send: fake(received),
    }),
  );
  expect(received).toEqual([]);
  expect(first).toEqual(["ntfy: 3 earlier alerts taken as seen (t3-fleet alerts lists them)"]);
  // From then on, exactly what is new, once.
  const later = [...before, state(alert("laptop", 5_000, "relay listener stopped"))];
  for (const _ of [1, 2])
    await run(
      deliverAlerts(config(true, "hub"), later, "relay", {
        home: dir,
        now: 5_001,
        send: fake(received),
      }),
    );
  expect(received.map((r) => r.n.body)).toEqual(["relay listener stopped"]);
});

it("delivers a live report that reaches a new relay before its first catch-up", async () => {
  const dir = home();
  const received: Array<{ channel: string; n: Notification }> = [];
  const live = [state(alert("laptop", 1_000))];
  await run(
    deliverAlerts(config(true, "hub"), live, "relay", {
      home: dir,
      now: 1_001,
      send: fake(received),
    }),
  );
  await run(
    deliverAlerts(config(true, "hub"), live, "relay", {
      home: dir,
      now: 1_002,
      catchUp: true,
      send: fake(received),
    }),
  );
  expect(received).toHaveLength(1);
});

it("keeps malicious desktop text out of executable source and option parsing", () => {
  const hostile =
    '" & do shell script "touch /var/tmp/wiznot-injected" & " $(id)\n--urgency=critical';
  const n = { title: hostile, body: hostile, problem: true };
  const mac = desktopCommand("darwin", n);
  expect(mac.command).toBe("osascript");
  expect(mac.args?.[1]).not.toContain(hostile);
  expect(mac.args?.slice(-2)).toEqual([hostile, hostile]);
  expect(desktopCommand("linux", n).args).toEqual(["--app-name=T3 Fleet", "--", hostile, hostile]);
  expect(alertIdentity(alert("laptop", 1, hostile))).not.toBe(
    alertIdentity(alert("laptop", 2, hostile)),
  );
});

it("maps ntfy metadata, retries rejection with backoff, reads rotated secrets and exposes sanitized failures", async () => {
  const dir = home();
  process.env["HOME"] = dir;
  mkdirSync(join(dir, ".config/t3-fleet"), { recursive: true });
  const requests: Array<{
    path: string;
    title: string;
    priority: string;
    tags: string;
    body: string;
  }> = [];
  let reject = true;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({
        path: req.url ?? "",
        title: String(req.headers.title),
        priority: String(req.headers.priority),
        tags: String(req.headers.tags),
        body,
      });
      res.writeHead(reject ? 503 : 200);
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const secrets = join(dir, ".config/t3-fleet/secrets.env");
  const topic = `http://127.0.0.1:${address.port}/private-topic`;
  writeFileSync(secrets, `PUSH_URL=${topic}`);
  try {
    const c = config(true, "hub");
    await started(dir, c, "relay");
    expect(
      await run(deliverAlerts(c, [state(alert())], "relay", { home: dir, now: 1_001 })),
    ).toContain("ntfy: ntfy rejected notification (HTTP 503)");
    expect(requests).toHaveLength(3);
    expect(await run(notificationStatus(c))).toContain(
      "notify ntfy: ntfy rejected notification (HTTP 503)",
    );
    expect(JSON.stringify(await run(notificationStatus(c)))).not.toContain(topic);
    reject = false;
    writeFileSync(secrets, `PUSH_URL=http://127.0.0.1:${address.port}/rotated`);
    await run(deliverAlerts(c, [state(alert())], "relay", { home: dir, now: 1_001 }));
    expect(requests.at(-1)?.path).toBe("/rotated");
    expect(requests.at(-1)).toMatchObject({
      priority: "4",
      tags: "warning",
      body: "provider unhealthy",
    });
    await run(ntfySend("PUSH_URL", dir, { title: "recovered", body: "healthy", problem: false }));
    expect(requests.at(-1)).toMatchObject({ priority: "2", tags: "white_check_mark" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("the explicit test sends one per configured path, persists failure, and leaves real-alert dedupe alone", async () => {
  const dir = home();
  process.env["HOME"] = dir;
  const received: Array<{ channel: string; n: Notification }> = [];
  const c = config(false);
  const result = await run(
    testNotification(c, {
      home: dir,
      send: (channel, n) =>
        channel === "ntfy"
          ? Effect.fail(
              new NotifyError({
                message: "ntfy rejected notification (HTTP 403)",
                retryable: false,
              }),
            )
          : fake(received)(channel, n),
    }),
  );
  expect(result.failed).toBe(true);
  expect(result.lines).toContain("ntfy: ntfy rejected notification (HTTP 403)");
  expect(received).toHaveLength(1);
  expect(received[0]?.n.title).toBe("T3 Fleet: notification test");
  expect(await run(notificationStatus(c))).toContain(
    "notify ntfy: ntfy rejected notification (HTTP 403)",
  );
  const sent: Array<{ channel: string; n: Notification }> = [];
  expect((await run(testNotification(c, { home: dir, send: fake(sent) }))).failed).toBe(false);
  expect(sent.map((s) => s.channel)).toEqual(["desktop", "ntfy"]);
  await run(
    deliverAlerts(c, [state(alert())], "sync", { home: dir, now: 1_001, send: fake(sent) }),
  );
  expect(sent).toHaveLength(4);
});
