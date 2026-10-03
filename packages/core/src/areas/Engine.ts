/**
 * fleetx itself, installed on each node, so timers and fixes there can run
 * it. The node's copy must be the controller's exact build; the fix streams
 * that build over the same ssh connection, so no release has to exist.
 *
 *   ~/.local/share/fleetx/fleetx.mjs   the bundle
 *   ~/.local/bin/fleetx                link to it
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { defineArea, sh } from "../Area.ts";
import type { Finding } from "../Diagnose.ts";
import { sha256 } from "../Hash.ts";

const Observed = Schema.Struct({
  /** SHA-256 of the controller's build; null when not told (a local probe). */
  wanted: Schema.NullOr(Schema.String),
  installed: Schema.NullOr(Schema.String),
  /** What ~/.config/fleetx/config.toml should say, and whether it does. */
  local: Schema.NullOr(Schema.Struct({ want: Schema.String, matches: Schema.Boolean })),
});

export const ENGINE_INSTALL = "fleetx:install-self";

export const EngineArea = defineArea({
  id: "engine",
  description: "this build of fleetx installed on every node",
  desired: Schema.Unknown,
  observed: Observed,
  observe: (_desired, ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const at = yield* fs.realPath(`${ctx.home}/.local/bin/fleetx`).pipe(Effect.option);
      const bytes = Option.isSome(at) ? yield* fs.readFile(at.value).pipe(Effect.option) : Option.none();
      const installed = Option.isSome(bytes) ? yield* Effect.promise(() => sha256(bytes.value)) : null;
      let local: typeof Observed.Type["local"] = null;
      if (ctx.node !== null) {
        const checkout = ctx.checkout.startsWith(`${ctx.home}/`) ? `~${ctx.checkout.slice(ctx.home.length)}` : ctx.checkout;
        const want = `repo = "${checkout}"\nnode = "${ctx.node}"\n`;
        const have = yield* fs.readFileString(`${ctx.home}/.config/fleetx/config.toml`).pipe(Effect.orElseSucceed(() => ""));
        const parsed = (key: string, text: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1];
        const expand = (p: string | undefined) => (p === undefined ? undefined : p.replace(/^~(?=\/|$)/, ctx.home));
        const matches = expand(parsed("repo", have)) === ctx.checkout && parsed("node", have) === ctx.node;
        local = { want, matches };
      }
      return { wanted: ctx.engine, installed, local };
    }),
  diagnose: ({ node, observed }) => {
    const out: Array<Finding> = [];
    if (observed.local !== null && !observed.local.matches) {
      out.push({
        node,
        key: "fleetx-local-config",
        severity: "warn",
        area: "engine",
        title: "~/.config/fleetx/config.toml does not name this machine and its config repo",
        fix: { command: `mkdir -p ~/.config/fleetx && printf '%s' ${sh(observed.local.want)} > ~/.config/fleetx/config.toml`, safe: true },
      });
    }
    if (observed.wanted === null || observed.installed === observed.wanted) return out;
    out.push({
      node,
      key: "fleetx-outdated",
      severity: "warn",
      area: "engine",
      title: observed.installed === null ? "fleetx is not installed here" : "fleetx here is a different build than the controller's",
      detail: "timers and fixes on this machine run its own copy",
      fix: { command: ENGINE_INSTALL, safe: true },
    });
    return out;
  },
});
