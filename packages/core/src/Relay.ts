/**
 * The relay: an optional always-on service, on the node with the relay role,
 * that makes a git-only fleet fast. Losing it costs speed, never correctness:
 * every node still syncs on its timer and publishes state to git.
 *
 *   POST /report        a node's state after its sync
 *   GET  /fleet         every node's latest reported state
 *   GET  /events        server-sent events: "pull" when the branch moves,
 *                       "state" when a node reports, "hub" when a hosted MCP
 *                       server changes state, "fix" when the app on the hub
 *                       asks a node for fixes; replays what a client missed
 *                       (Last-Event-ID or ?since=) so a laptop that slept
 *                       catches up, and adds a "pull" when it cannot know
 *                       what was missed (see eventIds)
 *   *    /mcp/<name>    the MCP hub's gateway: every hosted server behind one
 *                       endpoint and one token (see hub/Hub.ts)
 *        /hub/*, /oauth/callback
 *                       managing the hub and signing in (see hub/Routes.ts)
 *   POST /fixes, GET /fixes/<id>, POST /fixes/<id>/progress
 *                       fix requests from the app on the hub, claimed and
 *                       answered by the node they name (FixRequest.ts)
 *   GET  /, /api/*      the app, when this relay hosts it (HubUi.ts): its own
 *                       guard, Tailscale identity, instead of the relay token
 *   *    /egress/…      model traffic from nodes with [models] egress = "relay"
 *                       (models/Egress.ts; token in x-t3-fleet-relay-token)
 *   GET  /health
 *
 * Everything but /health and /oauth/callback needs `Authorization: Bearer
 * $T3_FLEET_RELAY_TOKEN` (the gateway also takes per-client tokens).
 * It listens on 127.0.0.1; publish it to the tailnet (tailscale serve), never
 * to the internet.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import type * as FileSystem from "effect/FileSystem";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { loadConfigFrom } from "./Config.ts";
import { deliverAlerts } from "./Notify.ts";
import { readStates } from "./Sync.ts";
import {
  advance,
  FixProgress,
  FixRequestBody,
  FixRequestRecord,
  publicRecord,
  type FixRelay,
} from "./FixRequest.ts";
import { git, out } from "./Git.ts";
import { egressLayer } from "./models/Egress.ts";
import { makeHub, type HubConfig } from "./hub/Hub.ts";
import { bearerMatches } from "./hub/Policy.ts";
import { hubRoutes } from "./hub/Routes.ts";
import { NodeState } from "./State.ts";

export interface RelayEvent {
  readonly id: number;
  readonly at: number;
  readonly type: "pull" | "state" | "hub" | "fix";
  readonly node?: string;
  readonly rev?: string;
  /** fix: the request's id; what it asks for is fetched from /fixes/<id>. */
  readonly request?: string;
  /** hub: the server, its new state, and why. */
  readonly server?: string;
  readonly state?: string;
  readonly detail?: string | null;
}

export interface RelayOptions<R = never> {
  readonly token: string;
  /** This relay node, enabling deterministic delivery. Omitted by embedders without notifications. */
  readonly node?: string;
  /** The config repo on this node, watched for new commits. */
  readonly repo: string;
  readonly branch: string;
  /** The MCP hub behind /mcp/<name> and /hub/*. */
  readonly hub: Omit<HubConfig, "relayToken">;
  /** How often to look for new commits. */
  readonly pollEvery?: Duration.Input;
  /** The upstream bases /egress may forward to (models/Egress.ts); the built-in ones when absent. */
  readonly egressBases?: () => ReadonlyArray<string>;
  /** More routes on the same port, given the relay's state: the app (HubUi.ts). */
  readonly extra?: (relay: RelayHandle) => Layer.Layer<never, never, R>;
}

/** What the relay keeps, for routes served beside it. */
export interface RelayHandle {
  /** Every node's latest report since the relay started. */
  readonly states: Effect.Effect<ReadonlyArray<NodeState>>;
  readonly fixes: FixRelay;
}

/** How long a fix request is kept, answered or not. */
const FIX_REQUESTS_KEPT_MS = 60 * 60 * 1000;

const MAX_EVENTS = 500;

/**
 * Event ids go on rising across restarts: the time this run started, in
 * milliseconds times 1000, plus a counter. A listener's `since` from an earlier run is
 * below every id of this one, and one this run did not hand out (a later
 * one, or one older than the events kept) cannot be trusted either: such a
 * listener gets every kept event and a "pull" after them, so it syncs rather
 * than miss a branch move the relay forgot when it restarted. 0 is a listener
 * connecting for the first time: it gets the kept events.
 */
export const eventIds = (startedAt: number) => {
  const first = startedAt * 1000 + 1;
  return {
    first,
    /** Whether the kept events are exactly what a listener at `since` missed. */
    knows: (since: number, kept: ReadonlyArray<{ readonly id: number }>, next: number) => {
      const oldest = kept[0]?.id ?? next;
      return since === 0 || (since >= first - 1 && since >= oldest - 1 && since < next);
    },
  };
};

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(NodeState));
const decodeFixBody = Schema.decodeUnknownEffect(Schema.fromJsonString(FixRequestBody));
const decodeProgress = Schema.decodeUnknownEffect(Schema.fromJsonString(FixProgress));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(FixRequestRecord));
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const unauthorized = HttpServerResponse.text("Unauthorized", { status: 401 });

/** The relay's routes and its background watcher, as one layer. */
export const relayLayer = <R = never>(options: RelayOptions<R>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<RelayEvent>>([]);
      const states = yield* Ref.make<ReadonlyMap<string, NodeState>>(new Map());
      const ids = eventIds(yield* Clock.currentTimeMillis);
      const nextId = yield* Ref.make(ids.first);
      const hub = yield* PubSub.unbounded<RelayEvent>();

      const emit = (event: Omit<RelayEvent, "id" | "at">) =>
        Effect.gen(function* () {
          const id = yield* Ref.getAndUpdate(nextId, (n) => n + 1);
          const full: RelayEvent = { ...event, id, at: yield* Clock.currentTimeMillis };
          yield* Ref.update(events, (all) => [...all, full].slice(-MAX_EVENTS));
          yield* PubSub.publish(hub, full);
        });

      // Watch the branch on the remote; emit "pull" when it moves.
      const lastRev = yield* Ref.make("");
      yield* Effect.gen(function* () {
        const remote = yield* git(options.repo, [
          "ls-remote",
          "origin",
          `refs/heads/${options.branch}`,
        ]);
        const rev = out(remote).split(/\s+/)[0] ?? "";
        if (rev === "") return;
        const previous = yield* Ref.getAndSet(lastRev, rev);
        if (previous !== "" && previous !== rev)
          yield* emit({ type: "pull", rev: rev.slice(0, 7) });
      }).pipe(
        Effect.repeat(Schedule.spaced(options.pollEvery ?? Duration.seconds(20))),
        Effect.forkDetach,
      );

      const notifyServices = yield* Effect.context<
        | Path.Path
        | FileSystem.FileSystem
        | HttpClient.HttpClient
        | ChildProcessSpawner.ChildProcessSpawner
      >();
      const notify = (catchUp: boolean) =>
        Effect.gen(function* () {
          if (options.node === undefined) return;
          const config = yield* loadConfigFrom(options.repo, options.node);
          yield* deliverAlerts(config, [...(yield* Ref.get(states)).values()], "relay", {
            catchUp,
          });
        }).pipe(Effect.ignore, Effect.provide(notifyServices));
      if (options.node !== undefined) {
        // Rehydrate from git after restart; polling also covers reports lost while the relay was down.
        yield* Effect.gen(function* () {
          for (const state of yield* readStates(options.repo)) {
            const current = (yield* Ref.get(states)).get(state.node);
            if (current === undefined || current.at < state.at) {
              yield* Ref.update(states, (m) => new Map(m).set(state.node, state));
              yield* emit({ type: "state", node: state.node, rev: state.rev });
            }
          }
          yield* notify(true);
        }).pipe(
          Effect.ignore,
          Effect.repeat(Schedule.spaced(Duration.seconds(30))),
          Effect.forkDetach,
        );
      }

      const authorized = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* bearerMatches(request.headers["authorization"], options.token);
      });

      const hubService = yield* makeHub({ ...options.hub, relayToken: options.token }, (e) =>
        emit({ type: "hub", server: e.server, state: e.state, detail: e.detail }),
      );

      // ── fix requests (FixRequest.ts) ──
      const requests = yield* Ref.make<ReadonlyMap<string, FixRequestRecord>>(new Map());
      const fixRelay: FixRelay = {
        request: (body) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;
            const id = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), (b) =>
              b.toString(16).padStart(2, "0"),
            ).join("");
            const record: FixRequestRecord = {
              id,
              node: body.node,
              at,
              fixes: body.fixes,
              acknowledged: body.acknowledged,
              state: "waiting",
              step: null,
              result: null,
              error: null,
            };
            yield* Ref.update(
              requests,
              (all) =>
                new Map(
                  [...all, [id, record] as const].filter(
                    ([, r]) => at - r.at < FIX_REQUESTS_KEPT_MS,
                  ),
                ),
            );
            yield* emit({ type: "fix", node: body.node, request: id });
            return record;
          }),
        get: (id) => Ref.get(requests).pipe(Effect.map((all) => all.get(id) ?? null)),
        expire: (id) =>
          Ref.modify(requests, (all): [boolean, ReadonlyMap<string, FixRequestRecord>] => {
            const record = all.get(id);
            if (record?.state !== "waiting") return [false, all];
            return [true, new Map(all).set(id, { ...record, state: "expired" })];
          }),
      };

      const json = (body: string, status = 200) =>
        HttpServerResponse.text(body, { status, contentType: "application/json" });

      const askFixes = HttpRouter.add(
        "POST",
        "/fixes",
        Effect.gen(function* () {
          if (!(yield* authorized)) return unauthorized;
          const request = yield* HttpServerRequest.HttpServerRequest;
          const body = yield* decodeFixBody(yield* request.text).pipe(Effect.option);
          if (Option.isNone(body) || !NODE_NAME.test(body.value.node))
            return HttpServerResponse.text("Not a fix request", { status: 400 });
          return json(yield* encodeRecord(publicRecord(yield* fixRelay.request(body.value))), 202);
        }).pipe(
          Effect.orElseSucceed(() => HttpServerResponse.text("Bad Request", { status: 400 })),
        ),
      );

      const fixRequest = HttpRouter.add(
        "GET",
        "/fixes/:id",
        Effect.gen(function* () {
          if (!(yield* authorized)) return unauthorized;
          const record = yield* fixRelay.get((yield* HttpRouter.params)["id"] ?? "");
          if (record === null) return HttpServerResponse.text("No such request", { status: 404 });
          return json(yield* encodeRecord(publicRecord(record)));
        }).pipe(
          Effect.orElseSucceed(() =>
            HttpServerResponse.text("Internal Server Error", { status: 500 }),
          ),
        ),
      );

      const fixProgress = HttpRouter.add(
        "POST",
        "/fixes/:id/progress",
        Effect.gen(function* () {
          if (!(yield* authorized)) return unauthorized;
          const id = (yield* HttpRouter.params)["id"] ?? "";
          const request = yield* HttpServerRequest.HttpServerRequest;
          const progress = yield* decodeProgress(yield* request.text).pipe(Effect.option);
          if (Option.isNone(progress))
            return HttpServerResponse.text("Not a fix progress", { status: 400 });
          const refused = yield* Ref.modify(
            requests,
            (all): [string | null, ReadonlyMap<string, FixRequestRecord>] => {
              const record = all.get(id);
              if (record === undefined) return ["No such request", all];
              const next = advance(record, progress.value);
              return typeof next === "string" ? [next, all] : [null, new Map(all).set(id, next)];
            },
          );
          return refused === null
            ? HttpServerResponse.empty({ status: 204 })
            : HttpServerResponse.text(refused, { status: 409 });
        }).pipe(
          Effect.orElseSucceed(() => HttpServerResponse.text("Bad Request", { status: 400 })),
        ),
      );

      const health = HttpRouter.add("GET", "/health", HttpServerResponse.text("ok"));

      const report = HttpRouter.add(
        "POST",
        "/report",
        Effect.gen(function* () {
          if (!(yield* authorized)) return unauthorized;
          const request = yield* HttpServerRequest.HttpServerRequest;
          const body = yield* request.text;
          const state = yield* decodeState(body).pipe(Effect.option);
          if (Option.isNone(state))
            return HttpServerResponse.text("Not a node state", { status: 400 });
          yield* Ref.update(states, (m) => new Map(m).set(state.value.node, state.value));
          yield* emit({ type: "state", node: state.value.node, rev: state.value.rev });
          yield* notify(false);
          return HttpServerResponse.empty({ status: 204 });
        }).pipe(
          Effect.orElseSucceed(() => HttpServerResponse.text("Bad Request", { status: 400 })),
        ),
      );

      const fleet = HttpRouter.add(
        "GET",
        "/fleet",
        Effect.gen(function* () {
          if (!(yield* authorized)) return unauthorized;
          const all = [...(yield* Ref.get(states)).values()];
          return HttpServerResponse.text(yield* encodeJson(all), {
            contentType: "application/json",
          });
        }).pipe(
          Effect.orElseSucceed(() =>
            HttpServerResponse.text("Internal Server Error", { status: 500 }),
          ),
        ),
      );

      const eventStream = HttpRouter.add(
        "GET",
        "/events",
        Effect.gen(function* () {
          if (!(yield* authorized)) return unauthorized;
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, "http://relay");
          const since =
            Number(request.headers["last-event-id"] ?? url.searchParams.get("since") ?? "0") || 0;
          const kept = yield* Ref.get(events);
          const next = yield* Ref.get(nextId);
          const known = ids.knows(since, kept, next);
          const missed = known ? kept.filter((e) => e.id > since) : kept;
          // With the newest id handed out, so the listener's next `since` is one of this run's.
          const pull: ReadonlyArray<RelayEvent> = known
            ? []
            : [
                {
                  id: next - 1,
                  at: yield* Clock.currentTimeMillis,
                  type: "pull",
                  rev: (yield* Ref.get(lastRev)).slice(0, 7),
                },
              ];
          const frame = (e: RelayEvent) =>
            `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
          const live = Stream.fromPubSub(hub);
          const keepalive = Stream.tick(Duration.seconds(25)).pipe(
            Stream.map(() => ": keepalive\n\n"),
          );
          const body = Stream.make(...[...missed, ...pull].map(frame)).pipe(
            Stream.concat(Stream.merge(live.pipe(Stream.map(frame)), keepalive)),
            Stream.encodeText,
          );
          return HttpServerResponse.stream(body, {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-cache", connection: "keep-alive" },
          });
        }),
      );

      const handle: RelayHandle = {
        states: Ref.get(states).pipe(Effect.map((m) => [...m.values()])),
        fixes: fixRelay,
      };

      return Layer.mergeAll(
        health,
        report,
        fleet,
        eventStream,
        askFixes,
        fixRequest,
        fixProgress,
        options.extra === undefined ? Layer.empty : options.extra(handle),
        hubRoutes(hubService, options.token),
        egressLayer(
          options.token,
          options.egressBases === undefined ? {} : { bases: options.egressBases },
        ),
      );
    }),
  );
