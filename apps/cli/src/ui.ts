/**
 * t3-fleet ui   the local web app: every view the CLI has, live, on 127.0.0.1
 *
 * The app is built into this bundle (see vite.config.ts); run from source it
 * is read from apps/ui/dist instead. The server itself is UiServer.ts; this
 * file wires it to the real fleet.
 *
 * On a machine with no fleet yet, or whose setup stopped part-way, it starts
 * anyway and serves the setup wizard (setup/Wizard.ts); `t3-fleet setup --ui`
 * opens it the same way. Once setup is done the same server is the fleet's:
 * the session, the relay and the checks are read as they are now.
 */
// The HTTP server itself has no Effect equivalent; T3 Code builds its server the same way.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import type { UiAlert, UiProposal, UiSession } from "@t3-fleet/core/Api";
import type { NodeState } from "@t3-fleet/core/State";
import { checkNodes } from "@t3-fleet/core/Check";
import { readHub } from "@t3-fleet/core/setup/Hub";
import { loadConfig, type Config } from "@t3-fleet/core/Config";
import { exec } from "@t3-fleet/core/Exec";
import { git, snapshot } from "@t3-fleet/core/Git";
import { fleetFromRelay, RELAY_TOKEN, secretVar } from "@t3-fleet/core/RelayClient";
import { describeMerged } from "@t3-fleet/core/Settings";
import {
  addSkills,
  keepUpdate,
  land,
  listSkills,
  lookupSource,
  previewUpdate,
  removeSkills,
} from "@t3-fleet/core/SkillSources";
import { sha256 } from "@t3-fleet/core/Hash";
import {
  approve,
  autoApproves,
  listProposals,
  reject,
  type Proposal,
} from "@t3-fleet/core/Staging";
import { readStates, underSyncLock } from "@t3-fleet/core/Sync";
import { nodeName } from "@t3-fleet/core/setup/Discover";
import { unfinishedRun } from "@t3-fleet/core/setup/Session";
import * as Wizard from "@t3-fleet/core/setup/Wizard";
import {
  uiLayer,
  type UiActions,
  type UiAsset,
  type UiRelay,
  type UiServerOptions,
} from "@t3-fleet/core/UiServer";

import packageJson from "../package.json" with { type: "json" };
import { applyLive, liveController, reportUserErrors, withoutStaleInstalls } from "./shared.ts";
import { connectT3 } from "./t3.ts";

/** The built app, gzipped and base64-encoded per file, put here by `vp pack` (vite.config.ts). */
declare const __T3_FLEET_UI_ASSETS__: string | undefined;

const EmbeddedAssets = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ type: Schema.String, gz: Schema.String })),
);

const gunzip = (bytes: Uint8Array) =>
  Effect.promise(() =>
    new Response(
      new Blob([bytes as Uint8Array<ArrayBuffer>])
        .stream()
        .pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer(),
  ).pipe(Effect.map((buffer) => new Uint8Array(buffer)));

const MIME: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  json: "application/json",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};

export const mimeOf = (file: string) =>
  MIME[file.slice(file.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

/** The app this build carries, or the last `vp build` of apps/ui when running from source. */
export const loadAssets = Effect.gen(function* () {
  const assets = new Map<string, UiAsset>();
  if (typeof __T3_FLEET_UI_ASSETS__ === "string") {
    const files = yield* Schema.decodeEffect(EmbeddedAssets)(__T3_FLEET_UI_ASSETS__);
    for (const [path, file] of Object.entries(files)) {
      const gz = yield* Effect.fromResult(Encoding.decodeBase64(file.gz));
      assets.set(path, { type: file.type, body: yield* gunzip(gz) });
    }
    return assets;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const self = yield* path.fromFileUrl(new URL(import.meta.url));
  const dist = path.join(path.dirname(self), "../../ui/dist");
  const files = yield* fs
    .readDirectory(dist, { recursive: true })
    .pipe(Effect.orElseSucceed(() => []));
  for (const file of files) {
    const full = path.join(dist, file);
    if ((yield* fs.stat(full)).type !== "File") continue;
    assets.set(`/${file.split(path.sep).join("/")}`, {
      type: mimeOf(file),
      body: yield* fs.readFile(full),
    });
  }
  return assets;
});

export const isAuthority = (config: Config) =>
  config.nodes.find((n) => n.name === config.self)?.roles.includes("authority") === true;

/** Every node's published state: the relay's when it answers, else the config repo's. */
const statesOf = (config: Config) =>
  Effect.gen(function* () {
    const relayed = yield* fleetFromRelay(config);
    if (relayed !== null) return relayed;
    return yield* readStates(config.repo).pipe(Effect.orElseSucceed(() => []));
  });

/**
 * What approving `proposal` would do, as a digest: each proposed file's blob
 * on the branch now and in the proposal. A sync re-creates the staging commit
 * (a new SHA for the same change), so the commit cannot say whether what is
 * there now is what was reviewed; this can, and it also changes when the
 * branch moves under one of the files.
 */
export const proposalChange = (
  repo: string,
  branch: string,
  proposal: Pick<Proposal, "commit" | "files">,
) =>
  Effect.gen(function* () {
    const blobs = (ref: string) =>
      git(repo, ["ls-tree", "-r", ref, "--", ...proposal.files]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
    const before = yield* blobs(`origin/${branch}`);
    const after = yield* blobs(proposal.commit);
    return yield* Effect.promise(() =>
      sha256([proposal.files.join("\n"), before, after].join("\n\n")),
    );
  });

export const proposalsOf = (config: Config) =>
  Effect.gen(function* () {
    const proposals = yield* listProposals(config.repo, config.branch);
    const prefixes = config.settings.fleet?.auto_approve ?? [];
    return yield* Effect.forEach(proposals, (p) =>
      Effect.gen(function* () {
        const diff = yield* git(config.repo, [
          "diff",
          `origin/${config.branch}`,
          p.commit,
          "--",
          ...p.files,
        ]);
        return {
          node: p.node,
          branch: p.branch,
          commit: p.commit,
          change: yield* proposalChange(config.repo, config.branch, p),
          summary: p.stat.split("\n").pop()?.trim() ?? "",
          files: p.files,
          diff: diff.stdout,
          autoApprovable: yield* autoApproves(config.repo, p, prefixes),
        } satisfies UiProposal;
      }),
    );
  });

/**
 * `node`'s proposal, if it still makes the change that was reviewed (see
 * proposalChange). Each sync force-pushes the staging branch, so what is
 * there now may be a diff nobody saw.
 */
export const proposalFrom = (config: Config, node: string, reviewed: string) =>
  Effect.gen(function* () {
    if (!isAuthority(config))
      return yield* Effect.fail(
        `${config.self} is not an authority; review proposals on a node with the authority role`,
      );
    const proposal = (yield* listProposals(config.repo, config.branch)).find(
      (p) => p.node === node,
    );
    if (proposal === undefined) return yield* Effect.fail(`no proposal from ${node}`);
    if ((yield* proposalChange(config.repo, config.branch, proposal)) !== reviewed) {
      return yield* Effect.fail(
        `${node}'s proposal changed since you reviewed it; review it again`,
      );
    }
    return proposal;
  });

/** Every alert in `states`, newest first, plus nodes that stopped reporting. */
export const alertsFrom = (config: Config, states: ReadonlyArray<NodeState>, now: number) => {
  const alerts: Array<typeof UiAlert.Type> = states.flatMap((s) => s.alerts);
  for (const node of config.nodes) {
    const state = states.find((s) => s.node === node.name);
    if (state === undefined) continue;
    const age = (now - state.at) / 1000;
    if (age > config.interval * config.alertAfter) {
      alerts.push({
        at: now,
        node: node.name,
        kind: "failing",
        message: `last reported ${Math.round(age / 60)} minutes ago; is its timer running?`,
      });
    }
  }
  return alerts.sort((a, b) => b.at - a.at);
};

/** Every alert the nodes published, newest first, plus nodes that stopped reporting. */
const alertsOf = (config: Config) =>
  Effect.gen(function* () {
    return alertsFrom(config, yield* statesOf(config), yield* Clock.currentTimeMillis);
  });

type Live = <A, E>(
  action: (
    config: Config,
  ) => Effect.Effect<A, E, NodeServices.NodeServices | HttpClient.HttpClient>,
) => Effect.Effect<A, string>;

/**
 * Skill changes, as `t3-fleet skills` makes them: an authority commits them,
 * any other machine's next sync proposes them (SkillSources.land).
 */
export const skillsActions = (live: Live): UiActions["skills"] => ({
  list: live((config) => listSkills(config.repo)),
  lookup: (source) => live((config) => lookupSource(config.repo, source)),
  add: (source, names, as) =>
    live((config) =>
      underSyncLock(
        Effect.gen(function* () {
          // What is there now, edits waiting to be proposed too, for putting back on a refusal.
          const before = yield* snapshot(config.repo, ["skills"]);
          const paths = yield* addSkills(config.repo, source, names, as);
          const added = paths
            .filter((p) => p !== "skills/SOURCES.json")
            .map((p) => p.slice("skills/".length));
          return {
            paths,
            landed: yield* land(
              config,
              paths,
              `Add skill${added.length === 1 ? "" : "s"} ${added.join(", ")} from ${source}`,
              before,
            ),
          };
        }),
      ),
    ),
  preview: (names) => live((config) => underSyncLock(previewUpdate(config.repo, names))),
  update: (names, digest) =>
    live((config) =>
      underSyncLock(
        Effect.gen(function* () {
          // What is there now, edits waiting to be proposed too, for putting back on a refusal.
          const before = yield* snapshot(config.repo, ["skills"]);
          const paths = yield* keepUpdate(config.repo, names, digest);
          return {
            paths,
            landed: yield* land(
              config,
              paths,
              `Update skill${paths.length === 1 ? "" : "s"} from upstream`,
              before,
            ),
          };
        }),
      ),
    ),
  remove: (names) =>
    live((config) =>
      underSyncLock(
        Effect.gen(function* () {
          // What is there now, edits waiting to be proposed too, for putting back on a refusal.
          const before = yield* snapshot(config.repo, ["skills"]);
          const paths = yield* removeSkills(config.repo, names);
          return {
            paths,
            landed: yield* land(
              config,
              paths,
              `Remove skill${names.length === 1 ? "" : "s"} ${names.join(", ")}`,
              before,
            ),
          };
        }),
      ),
    ),
});

/** Plain words for whatever an action failed with. */
export const failureText = (e: unknown) =>
  typeof e === "string"
    ? e
    : typeof e === "object" && e !== null && "message" in e
      ? String(e.message)
      : String(e);

const openBrowser = (url: string) =>
  exec(
    process.platform === "darwin"
      ? { command: "open", args: [url], timeout: Duration.seconds(10) }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url], timeout: Duration.seconds(10) }
        : { command: "xdg-open", args: [url], timeout: Duration.seconds(10) },
  );

/**
 * Ports to pick from when none is given: a new one each run, so a page or
 * service worker someone else left on an earlier run's port is not this one's.
 */
const RANDOM_PORTS = { from: 49152, count: 16384 };

/**
 * Where the fleet's app is hosted, when it has a hub: the relay's tailnet
 * address, with who may open it. None when the fleet has no relay URL, this
 * machine is not in a fleet (or its setup stopped part-way), or the hub's
 * bring-up from here has not finished: the app here offers to try it again.
 */
export const hostedApp = Effect.gen(function* () {
  const config = yield* loadConfig.pipe(Effect.option);
  if (Option.isNone(config)) return Option.none();
  const home = process.env["HOME"] ?? "";
  if (Option.isSome(yield* unfinishedRun(home))) return Option.none();
  if (Option.isSome(yield* readHub(home))) return Option.none();
  const url = config.value.settings.relay?.url?.replace(/\/+$/, "");
  if (url === undefined || url === "") return Option.none();
  return Option.some({ url: `${url}/`, allow: config.value.settings.ui?.allow ?? [] });
});

export const uiCommand = Command.make("ui", {
  port: Flag.Int("port").pipe(
    Flag.withDescription("Port on 127.0.0.1 with --local; a random one when not given."),
    Flag.optional,
  ),
  noOpen: Flag.Boolean("no-open").pipe(
    Flag.withDescription("Print the address instead of opening a browser."),
    Flag.withDefault(false),
  ),
  local: Flag.Boolean("local").pipe(
    Flag.withDescription(
      "Serve the app on this machine's 127.0.0.1, even when the fleet's hub hosts it. Setup always runs here.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Open T3 Fleet in the browser: environments, findings and fixes, proposals, alerts, skills, MCP, models, config. On a fleet with a hub, the hub hosts it on the tailnet.",
  ),
  Command.withHandler(({ port, noOpen, local }) =>
    Effect.gen(function* () {
      const hosted = local || Option.isSome(port) ? Option.none() : yield* hostedApp;
      if (Option.isNone(hosted))
        return yield* serveUi({ port: Option.getOrNull(port), open: !noOpen });
      const { url, allow } = hosted.value;
      yield* Console.log(
        [
          `T3 Fleet is on your hub: ${url}`,
          allow.length === 0
            ? "no Tailscale login may open it yet: add yours to [ui] allow in t3-fleet.toml (an authority commits it)"
            : `it opens for ${allow.join(", ")}, from any device on the tailnet signed in as one of them`,
          "proposals are decided on an authority (t3-fleet approve, or t3-fleet ui --local there); --local serves the app on this machine",
        ].join("\n"),
      );
      if (!noOpen) {
        const opened = yield* openBrowser(url);
        if (opened.code !== 0)
          yield* Console.log("could not open a browser; open the address above");
      }
    }).pipe(reportUserErrors),
  ),
);

/** Serve the app until stopped: the fleet's views, or setup's on a machine with no fleet yet. */
export const serveUi = ({
  port: askedPort,
  open,
}: {
  readonly port: number | null;
  readonly open: boolean;
}) =>
  Effect.gen(function* () {
    const asked = Option.fromNullishOr(askedPort);
    const noOpen = !open;
    const home = process.env["HOME"] ?? "";
    const fleetNow = Effect.gen(function* () {
      const config = yield* loadConfig.pipe(Effect.option);
      const unfinished = yield* unfinishedRun(home);
      return Option.isSome(unfinished) ? Option.none<Config>() : config;
    });
    const started = yield* fleetNow;
    // Every action reads the config again, and checks and fixes notice a newer build installed meanwhile.
    const current = yield* liveController;
    const assets = yield* loadAssets.pipe(
      Effect.mapError(() => "the UI bundled in this build could not be read"),
    );
    if (assets.size === 0)
      yield* Console.error(
        "T3 Fleet: this build has no UI; run `pnpm --filter t3-fleet build` (the API still works)",
      );
    const crypto = yield* Crypto.Crypto;
    const ticket = Encoding.encodeHex(yield* crypto.randomBytes(24));
    const relayOf = (config: Config) =>
      Effect.gen(function* () {
        const url = config.settings.relay?.url?.replace(/\/+$/, "") ?? null;
        const token = url === null ? "" : yield* secretVar(RELAY_TOKEN);
        return url !== null && token !== "" ? ({ url, token } satisfies UiRelay) : null;
      });
    const hostname = (yield* exec({
      command: "hostname",
      timeout: Duration.seconds(5),
    })).stdout.trim();
    const sessionOf = (config: Option.Option<Config>): UiSession =>
      Option.match(config, {
        // Not in a fleet yet: the machine setup would make, alone.
        onNone: () => ({
          version: packageJson.version,
          self: nodeName(hostname),
          authority: false,
          nodes: [],
          relay: null,
        }),
        onSome: (config) => ({
          version: packageJson.version,
          self: config.self,
          authority: isAuthority(config),
          nodes: config.nodes.map((n) => n.name),
          relay: config.settings.relay?.url?.replace(/\/+$/, "") ?? null,
        }),
      });
    const services = yield* Effect.context<NodeServices.NodeServices | HttpClient.HttpClient>();
    const closed = <A, E>(
      effect: Effect.Effect<A, E, NodeServices.NodeServices | HttpClient.HttpClient>,
    ) => effect.pipe(Effect.provide(services), Effect.mapError(failureText));
    /** An action run against the config as it is now, not as it was at start. */
    const live = <A, E>(
      action: (
        config: Config,
      ) => Effect.Effect<A, E, NodeServices.NodeServices | HttpClient.HttpClient>,
    ) => closed(current.pipe(Effect.flatMap(({ config }) => action(config))));

    const setup = yield* Wizard.make({
      t3Connect: connectT3.pipe(Effect.map((lines) => lines.join("; "))),
    });
    const options = {
      ticket,
      assets,
      setup,
      // A fleet's server keeps what it started with; setup's reads it again until there is one.
      ...(Option.isSome(started)
        ? {
            session: sessionOf(started),
            relay: yield* relayOf(started.value),
          }
        : {
            session: fleetNow.pipe(
              Effect.map(sessionOf),
              Effect.orElseSucceed(() => sessionOf(Option.none())),
              Effect.provide(services),
            ),
            relay: fleetNow.pipe(
              Effect.flatMap(Option.match({ onNone: () => Effect.succeed(null), onSome: relayOf })),
              Effect.orElseSucceed(() => null),
              Effect.provide(services),
            ),
            inFleet: fleetNow.pipe(
              Effect.map(Option.isSome),
              Effect.orElseSucceed(() => false),
              Effect.provide(services),
            ),
          }),
      actions: {
        check: closed(
          Effect.gen(function* () {
            const { config, bundle, stale } = yield* current;
            const [report, states] = yield* Effect.all(
              [checkNodes(config, bundle), statesOf(config)],
              { concurrency: "unbounded" },
            );
            return {
              report: withoutStaleInstalls(report, stale, "ui"),
              states,
              accepted: config.settings.accept ?? [],
            };
          }),
        ),
        apply: (fixes) => applyLive(current, fixes, "ui").pipe(Effect.provide(services)),
        proposals: live(proposalsOf),
        approve: (node, change) =>
          live((config) =>
            proposalFrom(config, node, change).pipe(
              Effect.flatMap((p) => approve(config.repo, config.branch, p, config.self)),
              Effect.map((approved) => approved.notes),
            ),
          ),
        reject: (node, change) =>
          live((config) =>
            proposalFrom(config, node, change).pipe(Effect.flatMap((p) => reject(config.repo, p))),
          ),
        alerts: live(alertsOf),
        config: (node) =>
          live((config) => {
            const found = config.nodes.find((n) => n.name === node);
            return found === undefined
              ? Effect.fail(`unknown machine: ${node}`)
              : Effect.succeed(describeMerged(found.settings));
          }),
        skills: skillsActions(live),
      },
    } satisfies Omit<UiServerOptions, "port">;

    const link = (port: number, ticket: string) => `http://127.0.0.1:${port}/#ticket=${ticket}`;
    // The link works once; whoever opens it next needs the next one.
    const onTicketUsed = (port: number) => (next: string) =>
      Console.log(`a browser opened the link; another tab can use ${link(port, next)}`);
    // Ctrl-C waits for running jobs, so no machine is left half-fixed; a second one stops them anyway.
    const onDrain = (running: ReadonlyArray<string>) =>
      Effect.sync(() => process.once("SIGINT", () => process.exit(130))).pipe(
        Effect.andThen(
          Console.log(
            `waiting for ${running.length === 1 ? "a job" : `${running.length} jobs`} to finish (${running.join("; ")}); Ctrl-C again stops ${running.length === 1 ? "it" : "them"} now`,
          ),
        ),
      );

    const listen = (port: number) =>
      Layer.build(
        HttpRouter.serve(uiLayer({ ...options, port, onTicketUsed: onTicketUsed(port), onDrain }), {
          disableLogger: true,
          disableListenLog: true,
        }).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(
            NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port }),
          ),
        ),
      ).pipe(Effect.as(port));
    const randomPort = crypto
      .randomBytes(2)
      .pipe(
        Effect.map(
          ([hi = 0, lo = 0]) => RANDOM_PORTS.from + (((hi << 8) | lo) % RANDOM_PORTS.count),
        ),
      );
    const port = Option.isSome(asked)
      ? yield* listen(asked.value).pipe(
          Effect.mapError(
            () =>
              `could not listen on 127.0.0.1:${asked.value}; is another t3-fleet ui running? (--port picks another)`,
          ),
        )
      : yield* randomPort.pipe(
          Effect.flatMap(listen),
          Effect.retry({ times: 9 }),
          Effect.mapError(() => "could not find a free port on 127.0.0.1; pick one with --port"),
        );

    // The ticket travels in the fragment, which browsers never send to a server, and works once.
    const url = link(port, ticket);
    const stoppedRun = Option.isNone(started) && Option.isSome(yield* unfinishedRun(home));
    yield* Console.log(
      Option.isSome(started)
        ? `t3-fleet ui on ${url}\nthe link works once; checks every minute while a tab is open; Ctrl-C stops it`
        : stoppedRun
          ? `t3-fleet ui on ${url}\na setup stopped part-way on this machine: the link opens it, to continue or abandon. It works once; Ctrl-C stops it`
          : `t3-fleet ui on ${url}\nthis machine is not in a fleet yet: the link opens setup. It works once; Ctrl-C stops it`,
    );
    if (!noOpen) {
      const opened = yield* openBrowser(url);
      if (opened.code !== 0) yield* Console.log("could not open a browser; open the address above");
    }
    return yield* Effect.never;
  });
