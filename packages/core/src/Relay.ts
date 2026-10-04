/**
 * The relay: an optional always-on service, on the node with the relay role,
 * that makes a git-only fleet fast. Losing it costs speed, never correctness:
 * every node still syncs on its timer and publishes state to git.
 *
 *   POST /report        a node's state after its sync
 *   GET  /fleet         every node's latest reported state
 *   GET  /events        server-sent events: "pull" when the branch moves,
 *                       "state" when a node reports, "hub" when a hosted MCP
 *                       server changes state; replays what a client missed
 *                       (Last-Event-ID or ?since=) so a laptop that slept
 *                       catches up
 *   *    /mcp/<name>    the MCP hub's gateway: every hosted server behind one
 *                       endpoint and one token (see hub/Hub.ts)
 *        /hub/*, /oauth/callback
 *                       managing the hub and signing in (see hub/Routes.ts)
 *   *    /egress/…      model traffic from nodes with [models] egress = "relay"
 *                       (models/Egress.ts; token in x-t3-fleet-relay-token)
 *   GET  /health
 *
 * Everything but /health and /oauth/callback needs `Authorization: Bearer
 * $FLEETX_RELAY_TOKEN` (the gateway also takes per-client tokens).
 * It listens on 127.0.0.1; publish it to the tailnet (tailscale serve), never
 * to the internet.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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

import { git, out } from "./Git.ts";
import { egressLayer } from "./models/Egress.ts";
import { makeHub, type HubConfig } from "./hub/Hub.ts";
import { bearerMatches } from "./hub/Policy.ts";
import { hubRoutes } from "./hub/Routes.ts";
import { NodeState } from "./State.ts";

export interface RelayEvent {
  readonly id: number;
  readonly at: number;
  readonly type: "pull" | "state" | "hub";
  readonly node?: string;
  readonly rev?: string;
  /** hub: the server, its new state, and why. */
  readonly server?: string;
  readonly state?: string;
  readonly detail?: string | null;
}

export interface RelayOptions {
  readonly token: string;
  /** The config repo on this node, watched for new commits. */
  readonly repo: string;
  readonly branch: string;
  /** The MCP hub behind /mcp/<name> and /hub/*. */
  readonly hub: Omit<HubConfig, "relayToken">;
  /** How often to look for new commits. */
  readonly pollEvery?: Duration.Input;
}

const MAX_EVENTS = 500;

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(NodeState));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const unauthorized = HttpServerResponse.text("Unauthorized", { status: 401 });

/** The relay's routes and its background watcher, as one layer. */
export const relayLayer = (options: RelayOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<RelayEvent>>([]);
      const states = yield* Ref.make<ReadonlyMap<string, NodeState>>(new Map());
      const nextId = yield* Ref.make(1);
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
        const remote = yield* git(options.repo, ["ls-remote", "origin", `refs/heads/${options.branch}`]);
        const rev = out(remote).split(/\s+/)[0] ?? "";
        if (rev === "") return;
        const previous = yield* Ref.getAndSet(lastRev, rev);
        if (previous !== "" && previous !== rev) yield* emit({ type: "pull", rev: rev.slice(0, 7) });
      }).pipe(Effect.repeat(Schedule.spaced(options.pollEvery ?? Duration.seconds(20))), Effect.forkDetach);

      const authorized = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* bearerMatches(request.headers["authorization"], options.token);
      });

      const hubService = yield* makeHub({ ...options.hub, relayToken: options.token }, (e) =>
        emit({ type: "hub", server: e.server, state: e.state, detail: e.detail }),
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
          if (Option.isNone(state)) return HttpServerResponse.text("Not a node state", { status: 400 });
          yield* Ref.update(states, (m) => new Map(m).set(state.value.node, state.value));
          yield* emit({ type: "state", node: state.value.node, rev: state.value.rev });
          return HttpServerResponse.empty({ status: 204 });
        }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("Bad Request", { status: 400 }))),
      );

      const fleet = HttpRouter.add(
        "GET",
        "/fleet",
        Effect.gen(function* () {
          if (!(yield* authorized)) return unauthorized;
          const all = [...(yield* Ref.get(states)).values()];
          return HttpServerResponse.text(yield* encodeJson(all), { contentType: "application/json" });
        }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 }))),
      );

      const eventStream = HttpRouter.add(
        "GET",
        "/events",
        Effect.gen(function* () {
          if (!(yield* authorized)) return unauthorized;
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, "http://relay");
          const since = Number(request.headers["last-event-id"] ?? url.searchParams.get("since") ?? "0") || 0;
          const missed = (yield* Ref.get(events)).filter((e) => e.id > since);
          const frame = (e: RelayEvent) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
          const live = Stream.fromPubSub(hub);
          const keepalive = Stream.tick(Duration.seconds(25)).pipe(Stream.map(() => ": keepalive\n\n"));
          const body = Stream.make(...missed.map(frame)).pipe(
            Stream.concat(Stream.merge(live.pipe(Stream.map(frame)), keepalive)),
            Stream.encodeText,
          );
          return HttpServerResponse.stream(body, {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-cache", connection: "keep-alive" },
          });
        }),
      );

      return Layer.mergeAll(health, report, fleet, eventStream, hubRoutes(hubService, options.token), egressLayer(options.token));
    }),
  );
