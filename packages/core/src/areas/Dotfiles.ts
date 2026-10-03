/**
 * Dotfiles: files in the config repo's dotfiles/ directory, linked into place
 * on each node.
 *
 *   [[dotfiles]]
 *   src = "zshrc"            # relative to <checkout>/dotfiles
 *   dest = "~/.zshrc"
 *
 * A destination that is a real file with other content is moved aside to
 * <dest>.fleetx-backup.<time> before linking, never overwritten.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { defineArea, shPath } from "../Area.ts";
import { expandHome } from "../Config.ts";
import type { Finding } from "../Diagnose.ts";

const Entry = Schema.Struct({ src: Schema.String, dest: Schema.String });
const Desired = Schema.UndefinedOr(Schema.Array(Entry));

const State = Schema.Literals(["linked", "missing", "elsewhere", "file-same", "file-differs", "no-source"]);
const Observed = Schema.Array(
  Schema.Struct({ src: Schema.String, dest: Schema.String, state: State, target: Schema.NullOr(Schema.String) }),
);

/**
 * An area of files linked from the config repo into place. `base` is the
 * directory inside the repo that `src` is relative to ("" for the root).
 */
const linkArea = (id: string, base: string, description: string) => defineArea({
  id,
  description,
  desired: Desired,
  observed: Observed,
  observe: (entries, ctx) =>
    Effect.forEach(entries ?? [], (entry) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const src = path.resolve(ctx.checkout, base, entry.src);
        const dest = expandHome(entry.dest, ctx.home);
        const fields = { src: entry.src, dest: entry.dest };
        if (!(yield* fs.exists(src).pipe(Effect.orElseSucceed(() => false)))) return { ...fields, state: "no-source" as const, target: null };
        const link = yield* fs.readLink(dest).pipe(Effect.option);
        if (Option.isSome(link)) {
          const real = yield* fs.realPath(dest).pipe(Effect.orElseSucceed(() => ""));
          const want = yield* fs.realPath(src).pipe(Effect.orElseSucceed(() => src));
          return { ...fields, state: real === want ? ("linked" as const) : ("elsewhere" as const), target: link.value };
        }
        if (!(yield* fs.exists(dest).pipe(Effect.orElseSucceed(() => false)))) return { ...fields, state: "missing" as const, target: null };
        const [a, b] = yield* Effect.all([fs.readFile(src).pipe(Effect.option), fs.readFile(dest).pipe(Effect.option)]);
        const same = Option.isSome(a) && Option.isSome(b) && Buffer.compare(a.value, b.value) === 0;
        return { ...fields, state: same ? ("file-same" as const) : ("file-differs" as const), target: null };
      }),
    ),
  diagnose: ({ node, observed }) => {
    const checkout = "$FLEETX_CHECKOUT";
    const out: Array<Finding> = [];
    for (const o of observed) {
      if (o.state === "linked") continue;
      const rel = base === "" ? o.src : `${base}/${o.src}`;
      const src = `${checkout}/${rel}`;
      const link = `mkdir -p "$(dirname ${shPath(o.dest)})" && ln -sfn "${src}" ${shPath(o.dest)}`;
      const backup = `mv ${shPath(o.dest)} ${shPath(o.dest)}.fleetx-backup.$(date +%Y%m%d%H%M%S) && `;
      const key = `${id}-${o.dest.replace(/^~\//, "").replace(/[^A-Za-z0-9]+/g, "-")}`;
      const common = { node, key, area: id };
      switch (o.state) {
        case "no-source":
          out.push({ ...common, severity: "error", title: `${o.dest}: ${rel} is not in the config repo` });
          break;
        case "missing":
          out.push({ ...common, severity: "warn", title: `${o.dest} is missing`, fix: { command: link, safe: true } });
          break;
        case "file-same":
          out.push({ ...common, severity: "info", title: `${o.dest} is a copy, not a link; edits will not reach the repo`, fix: { command: `rm ${shPath(o.dest)} && ${link}`, safe: true } });
          break;
        case "file-differs":
          out.push({
            ...common,
            severity: "warn",
            title: `${o.dest} differs from ${rel}`,
            detail: "the current file is kept as a backup next to it",
            fix: { command: backup + link, safe: true },
          });
          break;
        case "elsewhere":
          out.push({
            ...common,
            severity: "warn",
            title: `${o.dest} links to ${o.target ?? "somewhere else"}, not ${rel}`,
            fix: { command: link, safe: true },
          });
          break;
      }
    }
    return out;
  },
});

export const DotfilesArea = linkArea("dotfiles", "dotfiles", "files from the config repo's dotfiles/ linked into place");

/**
 * Agent instructions and client config from the repo: CLAUDE.md, AGENTS.md,
 * Claude settings, agents and commands. Paths are relative to the repo root.
 *
 *   [[instructions]]
 *   src = "claude/CLAUDE.md"
 *   dest = "~/.claude/CLAUDE.md"
 */
export const InstructionsArea = linkArea("instructions", "", "agent instructions and client config linked from the repo");
