/**
 * The area interface. An area is one kind of thing fleetx keeps equivalent
 * across machines: dotfiles, skills, MCP servers.
 *
 *   desired   what the node's merged settings say (decoded from its section)
 *   observe   runs on the node itself, read-only, and reports facts
 *   diagnose  runs on the controller, with every node's facts in hand, and
 *             turns differences into findings, each with the command that
 *             fixes it when there is one
 *
 * Applying is running those commands on the node (see Fix.ts), so `status` is
 * the plan, `fix --dry-run` shows it, and nothing changes a machine without
 * appearing in a plan first.
 *
 * Areas are registered in Areas.ts. A new area is one module implementing
 * this interface; nothing else in the engine changes.
 */
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Schema from "effect/Schema";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { Finding } from "./Diagnose.ts";

/** Services an area's observe step may use on the node. */
export type ProbeServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient;

export interface ObserveContext {
  readonly home: string;
  /** This node's clone of the config repo, ~ expanded. */
  readonly checkout: string;
  /** The login environment the probe runs in. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** SHA-256 of the controller's fleetx build; null when not given. */
  readonly engine: string | null;
  /** This node's name in the fleet; null when not given. */
  readonly node: string | null;
  /** This node's roles. */
  readonly roles: ReadonlyArray<string>;
  /** The fleet's relay, when it has one. */
  readonly relay: { readonly url: string | null; readonly port: number } | null;
}

export interface DiagnoseContext<D, O> {
  readonly node: string;
  readonly desired: D;
  readonly observed: O;
  /** Every node's facts for this area, for cross-machine rules. */
  readonly fleet: ReadonlyArray<{ readonly node: string; readonly desired: D; readonly observed: O }>;
  /** The node with the authority role, which fixes that change the repo run on; null if none. */
  readonly authority: string | null;
}

export interface Area<D, O> {
  readonly id: string;
  readonly description: string;
  /** Decodes the node's settings section; must accept `undefined` (area not configured). */
  readonly desired: Schema.Codec<D, unknown>;
  readonly observed: Schema.Codec<O, unknown>;
  readonly observe: (desired: D, ctx: ObserveContext) => Effect.Effect<O, never, ProbeServices>;
  readonly diagnose: (ctx: DiagnoseContext<D, O>) => ReadonlyArray<Finding>;
}

/** Erases an area's types for the registry; each area checks its own. */
export type AnyArea = Area<any, any>;

export const defineArea = <D, O>(area: Area<D, O>): AnyArea => area;

/** Shell-quote one argument for a fix command. */
export const sh = (s: string) => (/^[A-Za-z0-9_./~:@%+=,-]+$/.test(s) && !s.startsWith("~") ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** A path for a fix command: `~/x` becomes `"$HOME"/x` so the node's own home is used. */
export const shPath = (p: string) => (p === "~" ? '"$HOME"' : p.startsWith("~/") ? `"$HOME"/${sh(p.slice(2))}` : sh(p));
