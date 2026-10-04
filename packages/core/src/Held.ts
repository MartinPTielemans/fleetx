/**
 * Units of edits that sync holds back, because they add what looks like a
 * secret, and what is done with them. Shared by sync and approvals.
 */
import * as Effect from "effect/Effect";

import { git, literal, ok, out } from "./Git.ts";
import type { SecretHit } from "./SecretScan.ts";

/**
 * What sync holds back together: a whole skill directory (skills/<name>), or
 * a single file anywhere else. Half a skill is no skill.
 */
export const unitOf = (file: string) => {
  const parts = file.split("/");
  return parts[0] === "skills" && parts.length > 2 ? `skills/${parts[1]}` : file;
};

export const SOURCES = "skills/SOURCES.json";

/**
 * The files of `changed` sync holds back for `hits`, by unit: every file in a
 * unit with a hit. SOURCES.json is one unit with every skill whose entry it
 * changes (`entries`, from sourcesEntriesChanged): a skill without its
 * entry, or an entry without its skill, is no use to the other machines.
 * When it cannot be read (`entries` null) it is held alone.
 */
export const heldBack = (
  changed: ReadonlyArray<string>,
  hits: ReadonlyArray<SecretHit>,
  entries: ReadonlyArray<string> | null = [],
) => {
  const grouped = changed.includes(SOURCES)
    ? new Set([SOURCES, ...(entries ?? []).map((name) => `skills/${name}`)])
    : new Set<string>();
  const unit = (file: string) => (grouped.has(unitOf(file)) ? SOURCES : unitOf(file));
  const units = new Set(hits.map((h) => unit(h.file)));
  // An unreadable one (mid-edit, say) is held on its own: it says nothing about which skills go with it.
  if (entries === null && changed.includes(SOURCES)) units.add(SOURCES);
  const held = new Map<string, Array<string>>();
  for (const file of changed) {
    const u = unit(file);
    if (units.has(u)) held.set(u, [...(held.get(u) ?? []), file]);
  }
  return held;
};

/** A unit for a person: SOURCES.json names the skills that go with it. */
export const unitLabel = (unit: string, files: ReadonlyArray<string> = []) => {
  if (unit !== SOURCES) return unit;
  const skills = [...new Set(files.map(unitOf))].filter((u) => u !== SOURCES).sort();
  return skills.length === 0 ? unit : `${unit} with ${skills.join(", ")}`;
};

export const SET_ASIDE = "T3 Fleet: held back ";

/** Units sync set aside in git stash because they were in the way, by unit. */
export const setAside = (repo: string) =>
  Effect.gen(function* () {
    const list = yield* git(repo, ["stash", "list", "--format=%gs"]);
    return new Set(
      out(list)
        .split("\n")
        .flatMap((l) => {
          const at = l.indexOf(SET_ASIDE);
          return at < 0 ? [] : [l.slice(at + SET_ASIDE.length)];
        }),
    );
  });

/**
 * Set `units` aside in git stash, each in one entry named for it, where the
 * edits stay until someone applies them. The units set aside.
 */
export const setAsideUnits = (repo: string, units: ReadonlyMap<string, ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const aside = new Set<string>();
    for (const [unit, files] of units) {
      const stash = yield* git(
        repo,
        ["stash", "push", "-q", "--include-untracked", "-m", `${SET_ASIDE}${unit}`, "--", ...files],
        { env: literal },
      );
      if (ok(stash)) aside.add(unit);
    }
    return aside;
  });
