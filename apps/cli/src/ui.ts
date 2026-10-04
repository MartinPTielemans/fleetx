/**
 * fleetx ui   the local web app: every view the CLI has, live, on 127.0.0.1
 *
 * The app is built into this bundle (see vite.config.ts); run from source it
 * is read from apps/ui/dist instead. The server itself is UiServer.ts; this
 * file wires it to the real fleet.
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
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import type { UiAlert, UiProposal } from "@fleetx/core/Api";
import { checkNodes } from "@fleetx/core/Check";
import { loadConfig, type Config } from "@fleetx/core/Config";
import { exec } from "@fleetx/core/Exec";
import { runFixes } from "@fleetx/core/Fix";
import { git } from "@fleetx/core/Git";
import { fleetFromRelay, RELAY_TOKEN, secretVar } from "@fleetx/core/RelayClient";
import { describeMerged } from "@fleetx/core/Settings";
import { addSkills, keepUpdate, land, listSkills, lookupSource, previewUpdate, removeSkills } from "@fleetx/core/SkillSources";
import { approve, autoApprovable, listProposals, reject, STAGING } from "@fleetx/core/Staging";
import { readStates, underSyncLock } from "@fleetx/core/Sync";
import { uiLayer, type UiAsset } from "@fleetx/core/UiServer";

import packageJson from "../package.json" with { type: "json" };
import { ownBundle, reportUserErrors } from "./shared.ts";

/** The built app, gzipped and base64-encoded per file, put here by `vp pack` (vite.config.ts). */
declare const __FLEETX_UI_ASSETS__: string | undefined;

const EmbeddedAssets = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Struct({ type: Schema.String, gz: Schema.String })));

const gunzip = (bytes: Uint8Array) =>
  Effect.promise(() =>
    new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),
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

export const mimeOf = (file: string) => MIME[file.slice(file.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

/** The app this build carries, or the last `vp build` of apps/ui when running from source. */
const loadAssets = Effect.gen(function* () {
  const assets = new Map<string, UiAsset>();
  if (typeof __FLEETX_UI_ASSETS__ === "string") {
    const files = yield* Schema.decodeEffect(EmbeddedAssets)(__FLEETX_UI_ASSETS__);
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
  const files = yield* fs.readDirectory(dist, { recursive: true }).pipe(Effect.orElseSucceed(() => []));
  for (const file of files) {
    const full = path.join(dist, file);
    if ((yield* fs.stat(full)).type !== "File") continue;
    assets.set(`/${file.split(path.sep).join("/")}`, { type: mimeOf(file), body: yield* fs.readFile(full) });
  }
  return assets;
});

const isAuthority = (config: Config) => config.nodes.find((n) => n.name === config.self)?.roles.includes("authority") === true;

/** Every node's published state: the relay's when it answers, else the config repo's. */
const statesOf = (config: Config) =>
  Effect.gen(function* () {
    const relayed = yield* fleetFromRelay(config);
    if (relayed !== null) return relayed;
    return yield* readStates(config.repo).pipe(Effect.orElseSucceed(() => []));
  });

const proposalsOf = (config: Config) =>
  Effect.gen(function* () {
    const proposals = yield* listProposals(config.repo, config.branch);
    const prefixes = config.settings.fleet?.auto_approve ?? [];
    return yield* Effect.forEach(proposals, (p) =>
      Effect.gen(function* () {
        const diff = yield* git(config.repo, ["diff", `origin/${config.branch}`, p.commit, "--", ...p.files]);
        return {
          node: p.node,
          branch: `${STAGING}${p.node}`,
          summary: p.stat.split("\n").pop()?.trim() ?? "",
          files: p.files,
          diff: diff.stdout,
          autoApprovable: autoApprovable(p, prefixes),
        } satisfies UiProposal;
      }),
    );
  });

const proposalFrom = (config: Config, node: string) =>
  Effect.gen(function* () {
    if (!isAuthority(config)) return yield* Effect.fail(`${config.self} is not an authority; review proposals on a node with the authority role`);
    const proposal = (yield* listProposals(config.repo, config.branch)).find((p) => p.node === node);
    if (proposal === undefined) return yield* Effect.fail(`no proposal from ${node}`);
    return proposal;
  });

/** Every alert the nodes published, newest first, plus nodes that stopped reporting. */
const alertsOf = (config: Config) =>
  Effect.gen(function* () {
    const states = yield* statesOf(config);
    const now = yield* Clock.currentTimeMillis;
    const alerts: Array<typeof UiAlert.Type> = states.flatMap((s) => s.alerts);
    for (const node of config.nodes) {
      const state = states.find((s) => s.node === node.name);
      if (state === undefined) continue;
      const age = (now - state.at) / 1000;
      if (age > config.interval * config.alertAfter) {
        alerts.push({ at: now, node: node.name, kind: "failing", message: `last reported ${Math.round(age / 60)} minutes ago; is its timer running?` });
      }
    }
    return alerts.sort((a, b) => b.at - a.at);
  });

const openBrowser = (url: string) =>
  exec(
    process.platform === "darwin"
      ? { command: "open", args: [url], timeout: Duration.seconds(10) }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url], timeout: Duration.seconds(10) }
        : { command: "xdg-open", args: [url], timeout: Duration.seconds(10) },
  );

export const uiCommand = Command.make("ui", {
  port: Flag.Int("port").pipe(Flag.withDescription("Port on 127.0.0.1."), Flag.withDefault(8397)),
  noOpen: Flag.Boolean("no-open").pipe(Flag.withDescription("Print the address instead of opening a browser."), Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Open fleetx in the browser: environments, findings and fixes, proposals, alerts, skills, MCP, models, config."),
  Command.withHandler(({ port, noOpen }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const bundle = config.nodes.some((n) => n.ssh !== null) ? yield* ownBundle : "";
      const assets = yield* loadAssets.pipe(Effect.mapError(() => "the UI bundled in this build could not be read"));
      if (assets.size === 0) yield* Console.error("fleetx: this build has no UI; run `pnpm --filter fleetx build` (the API still works)");
      const crypto = yield* Crypto.Crypto;
      const token = Encoding.encodeHex(yield* crypto.randomBytes(24));
      const relayUrl = config.settings.relay?.url?.replace(/\/+$/, "") ?? null;
      const relayToken = relayUrl === null ? "" : yield* secretVar(RELAY_TOKEN);
      const services = yield* Effect.context<NodeServices.NodeServices | HttpClient.HttpClient>();
      const closed = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | HttpClient.HttpClient>) =>
        effect.pipe(
          Effect.provide(services),
          Effect.mapError((e) => (typeof e === "string" ? e : typeof e === "object" && e !== null && "message" in e ? String(e.message) : String(e))),
        );

      const routes = uiLayer({
        token,
        port,
        assets,
        session: {
          version: packageJson.version,
          self: config.self,
          authority: isAuthority(config),
          nodes: config.nodes.map((n) => n.name),
          relay: relayUrl,
        },
        relay: relayUrl !== null && relayToken !== "" ? { url: relayUrl, token: relayToken } : null,
        actions: {
          check: closed(
            Effect.gen(function* () {
              const [report, states] = yield* Effect.all([checkNodes(config, bundle), statesOf(config)], { concurrency: "unbounded" });
              return { report, states, accepted: config.settings.accept ?? [] };
            }),
          ),
          apply: (fixes) => runFixes(config.nodes, fixes, config.checkout, bundle).pipe(Effect.provide(services)),
          proposals: closed(proposalsOf(config)),
          approve: (node) => closed(proposalFrom(config, node).pipe(Effect.flatMap((p) => approve(config.repo, config.branch, p, config.self)), Effect.asVoid)),
          reject: (node) => closed(proposalFrom(config, node).pipe(Effect.flatMap((p) => reject(config.repo, p)))),
          alerts: closed(alertsOf(config)),
          config: (node) => {
            const found = config.nodes.find((n) => n.name === node);
            return found === undefined ? Effect.fail(`unknown machine: ${node}`) : Effect.succeed(describeMerged(found.settings));
          },
          skills: {
            list: closed(listSkills(config.repo)),
            lookup: (source) => closed(lookupSource(config.repo, source)),
            add: (source, names, as) =>
              closed(
                underSyncLock(
                  Effect.gen(function* () {
                    const paths = yield* addSkills(config.repo, source, names, as);
                    const added = paths.filter((p) => p !== "skills/SOURCES.json").map((p) => p.slice("skills/".length));
                    return { paths, landed: yield* land(config, paths, `Add skill${added.length === 1 ? "" : "s"} ${added.join(", ")} from ${source}`) };
                  }),
                ),
              ),
            preview: (names) => closed(underSyncLock(previewUpdate(config.repo, names))),
            update: (names, digest) =>
              closed(
                underSyncLock(
                  Effect.gen(function* () {
                    const paths = yield* keepUpdate(config.repo, names, digest);
                    return { paths, landed: yield* land(config, paths, `Update skill${paths.length === 1 ? "" : "s"} from upstream`) };
                  }),
                ),
              ),
            remove: (names) =>
              closed(
                underSyncLock(
                  Effect.gen(function* () {
                    const paths = yield* removeSkills(config.repo, names);
                    return { paths, landed: yield* land(config, paths, `Remove skill${names.length === 1 ? "" : "s"} ${names.join(", ")}`) };
                  }),
                ),
              ),
          },
        },
      });

      yield* Layer.build(
        HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port })),
        ),
      ).pipe(Effect.mapError(() => `could not listen on 127.0.0.1:${port}; is another fleetx ui running? (--port picks another)`));

      // The token travels in the fragment, which browsers never send to a server.
      const url = `http://127.0.0.1:${port}/#token=${token}`;
      yield* Console.log(`fleetx ui on ${url}\nchecks every minute while a browser is open; Ctrl-C stops it`);
      if (!noOpen) {
        const opened = yield* openBrowser(url);
        if (opened.code !== 0) yield* Console.log("could not open a browser; open the address above");
      }
      return yield* Effect.never;
    }).pipe(reportUserErrors),
  ),
);
