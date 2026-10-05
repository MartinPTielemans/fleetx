/**
 * The app on the hub: the same app and server as `t3-fleet ui`, served by
 * `t3-fleet relay serve` at the relay's tailnet address, and wired to what
 * the relay knows rather than to ssh.
 *
 *   who        Tailscale identity and [ui] allow (core HubUi.ts), not a ticket
 *   machines   as they last reported: to the relay since it started, else on
 *              their state branch in git; each with when it reported
 *   findings   the ones each machine published with its report, fixes
 *              included (format 2); a machine on an older T3 Fleet shows its
 *              findings without fixes, and says so
 *   fixes      sent through the relay to the machine that runs them, which
 *              checks itself again and runs only what it proposes
 *              (core FixRequest.ts)
 *   proposals  shown with their diffs, decided only on an authority
 *   skills     changed in the hub's checkout; an authority commits, the hub's
 *              next sync proposes, as the app says
 *
 * The hub needs no ssh to any other machine.
 */
import type * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import type { UiSession } from "@t3-fleet/core/Api";
import type { CheckReport } from "@t3-fleet/core/Check";
import type { Config } from "@t3-fleet/core/Config";
import type { Finding } from "@t3-fleet/core/Diagnose";
import { forwardFixes } from "@t3-fleet/core/FixRequest";
import { connectionOf, servedByTailscale } from "@t3-fleet/core/HubUi";
import { lookupLatest } from "@t3-fleet/core/Latest";
import type { RelayHandle } from "@t3-fleet/core/Relay";
import type { NodeResult } from "@t3-fleet/core/Remote";
import { describeMerged } from "@t3-fleet/core/Settings";
import { REPORT_FORMAT, type NodeState } from "@t3-fleet/core/State";
import { readStates } from "@t3-fleet/core/Sync";
import { uiLayer, type UiAsset, type UiCheck } from "@t3-fleet/core/UiServer";

import packageJson from "../package.json" with { type: "json" };
import { alertsFrom, failureText, isAuthority, proposalsOf, skillsActions } from "./ui.ts";

/** Each node's newest report, from the relay or its state branch. */
export const newestStates = (
  relayed: ReadonlyArray<NodeState>,
  published: ReadonlyArray<NodeState>,
): ReadonlyArray<NodeState> => {
  const byNode = new Map<string, NodeState>();
  for (const state of [...published, ...relayed]) {
    const kept = byNode.get(state.node);
    if (kept === undefined || state.at >= kept.at) byNode.set(state.node, state);
  }
  return [...byNode.values()];
};

const NO_FIXES_REPORTED =
  "this machine's T3 Fleet does not report its fixes; update it to fix this from the hub";

/**
 * A check made of reports: every node in the fleet, observed as it last
 * reported (or "not reported"), with the findings it published.
 */
export const reportedCheck = (
  config: Config,
  states: ReadonlyArray<NodeState>,
  latest: CheckReport["latest"],
): UiCheck => {
  const names = new Set(config.nodes.map((n) => n.name));
  const results = config.nodes.map((node): NodeResult => {
    const state = states.find((s) => s.node === node.name);
    if (state?.observation != null)
      return { node, ok: true, observation: state.observation, ms: 0 };
    return {
      node,
      ok: false,
      error:
        state === undefined
          ? "not reported: this machine has not reported to the relay or published its state"
          : "not reported: its last sync failed before it could observe the machine",
      ms: 0,
    };
  });
  const findings = states
    .filter((s) => names.has(s.node))
    .flatMap((s) =>
      s.findings.map((f): Finding => {
        const old = (s.format ?? 1) < REPORT_FORMAT;
        const detail =
          old && f.fix === undefined
            ? f.detail === undefined
              ? NO_FIXES_REPORTED
              : `${f.detail} (${NO_FIXES_REPORTED})`
            : f.detail;
        return {
          node: f.node,
          key: f.key,
          severity: f.severity,
          area: f.area,
          title: f.title,
          ...(detail === undefined ? {} : { detail }),
          ...(f.fix === undefined ? {} : { fix: f.fix }),
        };
      }),
    );
  return {
    report: { results, latest, findings, elapsedMs: 0 },
    states,
    accepted: config.settings.accept ?? [],
  };
};

export interface HubUiOptions {
  /** The config as the relay last read it. */
  readonly config: Effect.Effect<Config>;
  readonly port: number;
  readonly relayToken: string;
  readonly assets: ReadonlyMap<string, UiAsset>;
}

/** Who made each open connection, as servedBy answered it (macOS only). */
const answered = new WeakMap<object, string | null>();

const socketOf = (source: unknown): object | null => {
  const socket = (source as { socket?: unknown } | null)?.socket;
  return typeof socket === "object" && socket !== null ? socket : null;
};

/** The app's routes on the relay. */
export const hubUiLayer = (relay: RelayHandle, options: HubUiOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const services = yield* Effect.context<NodeServices.NodeServices | HttpClient.HttpClient>();
      const live = <A, E>(
        action: (
          config: Config,
        ) => Effect.Effect<A, E, NodeServices.NodeServices | HttpClient.HttpClient>,
      ) =>
        options.config.pipe(
          Effect.flatMap(action),
          Effect.provide(services),
          Effect.mapError(failureText),
        );
      const statesNow = (config: Config) =>
        Effect.gen(function* () {
          const published = yield* readStates(config.repo).pipe(Effect.orElseSucceed(() => []));
          return newestStates(yield* relay.states, published);
        });
      const session = options.config.pipe(
        Effect.map((config): UiSession => ({
          version: packageJson.version,
          self: config.self,
          authority: isAuthority(config),
          nodes: config.nodes.map((n) => n.name),
          relay: config.settings.relay?.url?.replace(/\/+$/, "") ?? null,
        })),
      );
      const crypto = yield* Crypto.Crypto;
      return uiLayer({
        // Never traded on the hub; random so it could not be guessed if it were.
        ticket: Encoding.encodeHex(yield* crypto.randomBytes(24).pipe(Effect.orDie)),
        port: options.port,
        assets: options.assets,
        session,
        relay: { url: `http://127.0.0.1:${options.port}`, token: options.relayToken },
        hub: {
          gate: options.config.pipe(
            Effect.map((config) => ({
              url: config.settings.relay?.url ?? "",
              allow: config.settings.ui?.allow ?? [],
            })),
          ),
          approveOn: options.config.pipe(
            Effect.map((config) =>
              config.nodes.filter((n) => n.roles.includes("authority")).map((n) => n.name),
            ),
          ),
          servedBy: (request) => {
            // On macOS a connection is looked up once: a code-signature check takes a
            // tenth of a second, and who made a connection cannot change while it is open.
            const socket = socketOf(request.source);
            const known = socket === null ? undefined : answered.get(socket);
            if (known !== undefined) return Effect.succeed(known);
            return servedByTailscale(connectionOf(request.source)).pipe(
              Effect.tap((answer) =>
                Effect.sync(() => {
                  if (socket !== null && process.platform === "darwin")
                    answered.set(socket, answer);
                }),
              ),
              Effect.provide(services),
            );
          },
        },
        actions: {
          check: live((config) =>
            Effect.gen(function* () {
              const states = yield* statesNow(config);
              const versions = states
                .flatMap((s) =>
                  s.observation === null
                    ? []
                    : [
                        s.observation.t3.descriptor?.serverVersion ??
                          s.observation.t3.installedVersion ??
                          "",
                      ],
                )
                .filter((v) => v !== "");
              return reportedCheck(config, states, yield* lookupLatest(versions));
            }),
          ),
          apply: (fixes, step) => forwardFixes(relay.fixes, fixes, step),
          proposals: live(proposalsOf),
          approve: (node) =>
            Effect.fail(`${node}'s proposal is approved on an authority, not on the hub`),
          reject: (node) =>
            Effect.fail(`${node}'s proposal is rejected on an authority, not on the hub`),
          alerts: live((config) =>
            Effect.gen(function* () {
              return alertsFrom(config, yield* statesNow(config), yield* Clock.currentTimeMillis);
            }),
          ),
          config: (node) =>
            live((config) => {
              const found = config.nodes.find((n) => n.name === node);
              return found === undefined
                ? Effect.fail(`unknown machine: ${node}`)
                : Effect.succeed(describeMerged(found.settings));
            }),
          skills: skillsActions(live),
        },
      });
    }),
  );
