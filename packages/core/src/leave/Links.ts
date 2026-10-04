/**
 * T3 Fleet's links into the config repo, turned into real copies of what they
 * point to so the machine keeps working once the checkout is gone.
 *
 * A link counts as T3 Fleet's only when it points exactly where T3 Fleet
 * installs it (installedTargets): a skill in the store at the repo's
 * skills/<name>, a client's skill at the store's (or, as older versions did,
 * the repo's), a dotfile or instruction at its `src`. A link of the user's to
 * some other file, in the repo or not, is theirs and is left alone.
 *
 * Links inside a copied directory that point into the repo are copied in too
 * (a skill linking a shared file). One pointing back at a directory the copy
 * is already inside would copy forever: that link is refused, and left as a
 * link. A link into the repo whose target is gone is reported and left as it
 * is, never dropped from the plan.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { expandHome } from "../Config.ts";
import {
  finishStaging,
  isObject,
  linkTarget,
  replaceWith,
  stagingIn,
  within,
  type Marker,
} from "./Files.ts";

export interface Conversion {
  readonly at: string;
  /** Where the link points, as planned; a link changed since is left alone. */
  readonly link: string;
  /** The real path it resolves to now. */
  readonly target: string;
  /** Links into the repo inside it that are copied in as well. */
  readonly nested: number;
  /** Links into the repo inside it whose target is gone; kept as links. */
  readonly brokenInside: ReadonlyArray<string>;
}

export interface LinksPlan {
  readonly conversions: ReadonlyArray<Conversion>;
  /** Replacements an interrupted run left half-done. */
  readonly unfinished: ReadonlyArray<{ readonly dir: string; readonly marker: Marker }>;
  /** T3 Fleet's links pointing at nothing: where, and what they name. */
  readonly broken: ReadonlyArray<{ readonly at: string; readonly target: string }>;
  /** Links that would copy themselves forever: where, and the link inside that loops. */
  readonly cycles: ReadonlyArray<{ readonly at: string; readonly loop: string }>;
}

const strings = (v: unknown): Array<string> =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

/** The repo as written and as resolved, so links through either count. */
export const repoRoots = (repo: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.realPath(repo)),
    Effect.map((real) => [...new Set([repo, real])]),
    Effect.orElseSucceed(() => [repo]),
  );

/**
 * Where T3 Fleet installs a link, from a node's merged settings: each path,
 * and the targets it may point to. A directory entry is matched by name
 * (`dir/*`), with `*` standing for that name in its targets.
 */
export const installedTargets = (
  table: Record<string, unknown>,
  home: string,
  roots: ReadonlyArray<string>,
) => {
  const skills = isObject(table["skills"]) ? table["skills"] : {};
  const store = expandHome(
    typeof skills["store"] === "string" ? skills["store"] : "~/.agents/skills",
    home,
  );
  const dirs = new Map<string, Array<string>>();
  dirs.set(
    store,
    roots.map((r) => `${r}/skills/*`),
  );
  for (const client of strings(skills["clients"]).map((c) => expandHome(c, home)))
    if (!dirs.has(client)) dirs.set(client, [`${store}/*`, ...roots.map((r) => `${r}/skills/*`)]);
  const files = new Map<string, Array<string>>();
  for (const [area, base] of [
    ["dotfiles", "dotfiles/"],
    ["instructions", ""],
  ] as const) {
    const entries = Array.isArray(table[area]) ? (table[area] as Array<unknown>) : [];
    for (const e of entries)
      if (isObject(e) && typeof e["dest"] === "string" && typeof e["src"] === "string")
        files.set(
          expandHome(e["dest"], home),
          roots.map((r) => `${r}/${base}${e["src"] as string}`.replace(/\/\.\//g, "/")),
        );
  }
  return { dirs, files };
};

/** The targets T3 Fleet would have given the link at `at`, or none when it puts no link there. */
export const expectedTargets = (
  installed: ReturnType<typeof installedTargets>,
  at: string,
): ReadonlyArray<string> => {
  const direct = installed.files.get(at);
  if (direct !== undefined) return direct;
  const slash = at.lastIndexOf("/");
  const name = at.slice(slash + 1);
  return (installed.dirs.get(at.slice(0, slash)) ?? []).map((t) => t.replace(/\*$/, name));
};

/**
 * Walks `dir` (not following links) for links into the repo. `source` is the
 * real directory `dir` was copied from, and `ancestors` the real directories
 * the walk is inside of, so a link back up to one of them is a loop.
 * `onLink` gets each link, its resolved target (null when gone), and whether
 * it loops; it says whether to walk into the target.
 */
const walkLinks = <E, R>(
  dir: string,
  ancestors: ReadonlyArray<string>,
  inRepo: (p: string) => boolean,
  onLink: (
    at: string,
    target: string | null,
    loops: boolean,
  ) => Effect.Effect<boolean, E, R | FileSystem.FileSystem | Path.Path>,
): Effect.Effect<void, E, R | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const name of yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>))) {
      const at = path.join(dir, name);
      const target = yield* linkTarget(at);
      if (Option.isSome(target)) {
        if (!inRepo(target.value)) continue;
        const resolved = Option.getOrNull(yield* fs.realPath(at).pipe(Effect.option));
        const loops = resolved !== null && ancestors.some((a) => within(a, resolved));
        if (!(yield* onLink(at, resolved, loops)) || resolved === null || loops) continue;
        const info = yield* fs.stat(at).pipe(Effect.option);
        if (Option.isSome(info) && info.value.type === "Directory")
          yield* walkLinks(at, [...ancestors, resolved], inRepo, onLink);
        continue;
      }
      const info = yield* fs.stat(at).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory") {
        const real = yield* fs.realPath(at).pipe(Effect.orElseSucceed(() => at));
        yield* walkLinks(at, [...ancestors, real], inRepo, onLink);
      }
    }
  });

/** T3 Fleet's links into the repo, the ones that point at nothing, loops, and unfinished replacements. */
export const planLinks = (
  repo: string,
  table: Record<string, unknown>,
  home: string,
  skip: ReadonlySet<string>,
  /** More directories where an interrupted run may have left staging (setup's backups' places). */
  more: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const roots = yield* repoRoots(repo);
    const inRepo = (p: string) => roots.some((r) => within(p, r));
    const installed = installedTargets(table, home, roots);
    const candidates: Array<string> = [...installed.files.keys()];
    for (const dir of installed.dirs.keys())
      for (const name of yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
        candidates.push(path.join(dir, name));

    const conversions: Array<Conversion> = [];
    const broken: Array<{ at: string; target: string }> = [];
    const cycles: Array<{ at: string; loop: string }> = [];
    for (const at of new Set(candidates)) {
      if (skip.has(at)) continue;
      const target = yield* linkTarget(at);
      if (Option.isNone(target) || !expectedTargets(installed, at).includes(target.value)) continue;
      const resolved = yield* fs.realPath(at).pipe(Effect.option);
      if (Option.isNone(resolved)) {
        broken.push({ at, target: target.value });
        continue;
      }
      if (!inRepo(resolved.value)) continue;
      let nested = 0;
      let loop: string | null = null;
      const brokenInside: Array<string> = [];
      const info = yield* fs.stat(resolved.value).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory")
        yield* walkLinks(resolved.value, [resolved.value], inRepo, (inner, innerTarget, loops) =>
          Effect.sync(() => {
            if (loops) loop ??= inner;
            else if (innerTarget === null) brokenInside.push(inner);
            else nested++;
            return true;
          }),
        );
      if (loop !== null) cycles.push({ at, loop });
      else
        conversions.push({ at, link: target.value, target: resolved.value, nested, brokenInside });
    }
    const unfinished: Array<{ dir: string; marker: Marker }> = [];
    const dirs = [
      ...installed.dirs.keys(),
      ...[...installed.files.keys(), ...more].map((f) => path.dirname(f)),
    ];
    for (const dir of new Set(dirs)) unfinished.push(...(yield* stagingIn(dir)));
    return { conversions, unfinished, broken, cycles } satisfies LinksPlan;
  });

/**
 * Copies in, inside `copy`, every link into the repo whose target exists,
 * each staged in `scratch` (outside the copy, so nothing in it is ever in
 * the way); a link back up to a directory it is inside fails it.
 */
const materialize = (copy: string, source: string, scratch: string, roots: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const inRepo = (p: string) => roots.some((r) => within(p, r));
    yield* walkLinks(copy, [source], inRepo, (at, target, loops) =>
      Effect.gen(function* () {
        if (loops) return yield* Effect.fail(`${at} links back to a directory it is inside`);
        if (target === null) return false;
        const tmp = yield* fs.makeTempDirectory({ directory: scratch });
        yield* fs.copy(target, path.join(tmp, "item"));
        // A file replaces its link in one rename; a directory goes in once the link is gone.
        if ((yield* fs.stat(path.join(tmp, "item"))).type === "Directory") yield* fs.remove(at);
        yield* fs.rename(path.join(tmp, "item"), at);
        yield* fs.remove(tmp, { recursive: true });
        return true;
      }),
    );
  });

/** Turns one link into a copy; false when it changed since the plan (and was left alone). */
export const convert = (c: Conversion, repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const roots = yield* repoRoots(repo);
    return yield* replaceWith({
      at: c.at,
      source: c.target,
      how: "copy",
      prepare: (copy, scratch) =>
        Effect.gen(function* () {
          if ((yield* fs.stat(copy)).type === "Directory")
            yield* materialize(copy, c.target, scratch, roots);
        }),
      // The link as planned; what it resolves to may have become a copy already (a client link into the store).
      stillWanted: linkTarget(c.at).pipe(Effect.map((now) => Option.getOrNull(now) === c.link)),
    });
  });

export const finishUnfinished = finishStaging;
