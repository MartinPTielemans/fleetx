/**
 * T3 Fleet's links into the config repo, turned into real copies of what they
 * point to so the machine keeps working once the checkout is gone: entries of
 * the skills store, client and watched directories, and dotfile and
 * instruction destinations.
 *
 * Links inside a copied directory that point into the repo are copied in too
 * (a skill linking a shared file). A link into the repo whose target is gone
 * is reported and left as it is, never dropped from the plan.
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
  /** Links into the repo pointing at nothing: where, and what they name. */
  readonly broken: ReadonlyArray<{ readonly at: string; readonly target: string }>;
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

/** Where T3 Fleet puts links, from a node's merged settings. */
export const linkCandidates = (table: Record<string, unknown>, home: string) => {
  const skills = isObject(table["skills"]) ? table["skills"] : {};
  const dirs = [
    typeof skills["store"] === "string" ? skills["store"] : "~/.agents/skills",
    ...strings(skills["clients"]),
    ...strings(skills["watch"]),
  ].map((d) => expandHome(d, home));
  const files: Array<string> = [];
  for (const area of ["dotfiles", "instructions"]) {
    const entries = Array.isArray(table[area]) ? (table[area] as Array<unknown>) : [];
    for (const e of entries)
      if (isObject(e) && typeof e["dest"] === "string") files.push(expandHome(e["dest"], home));
  }
  return { dirs: [...new Set(dirs)], files: [...new Set(files)] };
};

/**
 * Walks `dir` (not following links) for links into the repo: `onLink` gets
 * each one with its resolved target, or null when that is gone. Directories
 * already walked (by real path) are skipped, so a cycle ends.
 */
const walkLinks = <E, R>(
  dir: string,
  inRepo: (p: string) => boolean,
  onLink: (at: string, target: string | null) => Effect.Effect<boolean, E, R>,
  seen: Set<string> = new Set(),
): Effect.Effect<void, E, R | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const real = yield* fs.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
    if (seen.has(real) || seen.size > 10_000) return;
    seen.add(real);
    for (const name of yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>))) {
      const at = path.join(dir, name);
      const target = yield* linkTarget(at);
      if (Option.isSome(target)) {
        if (!inRepo(target.value)) continue;
        const resolved = yield* fs.realPath(at).pipe(Effect.option);
        const descend = yield* onLink(at, Option.getOrNull(resolved));
        if (descend && Option.isSome(resolved)) {
          const info = yield* fs.stat(at).pipe(Effect.option);
          if (Option.isSome(info) && info.value.type === "Directory")
            yield* walkLinks(at, inRepo, onLink, seen);
        }
        continue;
      }
      const info = yield* fs.stat(at).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory")
        yield* walkLinks(at, inRepo, onLink, seen);
    }
  });

/** Every link of T3 Fleet's into the repo, the ones that point at nothing, and unfinished replacements. */
export const planLinks = (
  repo: string,
  table: Record<string, unknown>,
  home: string,
  skip: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const roots = yield* repoRoots(repo);
    const inRepo = (p: string) => roots.some((r) => within(p, r));
    const { dirs, files } = linkCandidates(table, home);
    const candidates: Array<string> = [...files];
    for (const dir of dirs)
      for (const name of yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
        candidates.push(path.join(dir, name));

    const conversions: Array<Conversion> = [];
    const broken: Array<{ at: string; target: string }> = [];
    for (const at of new Set(candidates)) {
      if (skip.has(at)) continue;
      const target = yield* linkTarget(at);
      if (Option.isNone(target)) continue;
      // Through another link (a client's link into the store) as much as straight into the repo.
      const resolved = yield* fs.realPath(at).pipe(Effect.option);
      if (Option.isNone(resolved)) {
        if (inRepo(target.value)) broken.push({ at, target: target.value });
        continue;
      }
      if (!inRepo(resolved.value)) continue;
      let nested = 0;
      const brokenInside: Array<string> = [];
      const info = yield* fs.stat(resolved.value).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory")
        yield* walkLinks(resolved.value, inRepo, (inner, innerTarget) =>
          Effect.sync(() => {
            if (innerTarget === null) brokenInside.push(inner);
            else nested++;
            return true;
          }),
        );
      conversions.push({ at, link: target.value, target: resolved.value, nested, brokenInside });
    }
    const unfinished: Array<{ dir: string; marker: Marker }> = [];
    for (const dir of new Set([...dirs, ...files.map((f) => path.dirname(f))]))
      unfinished.push(...(yield* stagingIn(dir)));
    return { conversions, unfinished, broken } satisfies LinksPlan;
  });

/** Copies in, inside `copy`, every link into the repo whose target exists; reports the rest. */
const materialize = (copy: string, roots: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const inRepo = (p: string) => roots.some((r) => within(p, r));
    yield* walkLinks(copy, inRepo, (at, target) =>
      Effect.gen(function* () {
        if (target === null) return false;
        // A file replaces its link in one rename; a directory goes in once the link is gone.
        const tmp = `${at}.t3-fleet-leave-nested`;
        yield* fs.copy(target, tmp);
        const isDir = (yield* fs.stat(tmp)).type === "Directory";
        if (isDir) yield* fs.remove(at);
        yield* fs.rename(tmp, at);
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
      prepare: (copy) =>
        Effect.gen(function* () {
          if ((yield* fs.stat(copy)).type === "Directory") yield* materialize(copy, roots);
        }),
      // The link as planned; what it resolves to may have become a copy already (a client link into the store).
      stillWanted: linkTarget(c.at).pipe(Effect.map((now) => Option.getOrNull(now) === c.link)),
    });
  });

export const finishUnfinished = finishStaging;
