/**
 * Skills vendored from git repositories, with provenance in
 * skills/SOURCES.json so they can be updated later:
 *
 *   { "sources": { "<source>": { "type": "github", "url": "…", "skills": [names],
 *                                "paths": { name: "path/in/repo" },
 *                                "renamed": { localName: upstreamName } } } }
 *
 * Skills are copied, not referenced, so every node works offline and gets
 * exactly what was reviewed.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { exec } from "./Exec.ts";
import { git, ok, why } from "./Git.ts";

const Source = Schema.Struct({
  type: Schema.String,
  url: Schema.String,
  skills: Schema.Array(Schema.String),
  paths: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  renamed: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const SourcesFile = Schema.Struct({
  _comment: Schema.optionalKey(Schema.String),
  sources: Schema.optionalKey(Schema.Record(Schema.String, Source)),
  local: Schema.optionalKey(Schema.Array(Schema.String)),
});
type SourcesFile = typeof SourcesFile.Type;

const sourcesPath = (repo: string) => `${repo}/skills/SOURCES.json`;

const readSources = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(sourcesPath(repo)).pipe(Effect.option);
    if (Option.isNone(text)) return { sources: {} } as SourcesFile;
    return yield* Schema.decodeEffect(Schema.fromJsonString(SourcesFile))(text.value).pipe(Effect.mapError(() => "skills/SOURCES.json is not valid"));
  });

const prettyJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const writeSources = (repo: string, sources: SourcesFile) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(sourcesPath(repo), prettyJson(sources));
  });

/** owner/repo or a full URL → clone URL and a short source name. */
export const parseSource = (spec: string) => {
  const url = /^[\w.-]+\/[\w.-]+$/.test(spec) ? `https://github.com/${spec}.git` : spec;
  const name = (/([^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? "source").toLowerCase();
  return { url, name };
};

/** Shallow-clone a source and find its skills: directories holding a SKILL.md. */
const fetchSource = (url: string, scratch: string) =>
  Effect.gen(function* () {
    yield* exec({ command: "rm", args: ["-rf", scratch], timeout: Duration.seconds(30) });
    const clone = yield* git(process.env["HOME"] ?? "/", ["clone", "-q", "--depth", "1", url, scratch], { timeout: Duration.minutes(3) });
    if (!ok(clone)) return yield* Effect.fail(`cloning ${url}: ${why(clone)}`);
    const found = yield* exec({ command: "find", args: [scratch, "-name", "SKILL.md", "-not", "-path", "*/.git/*", "-not", "-path", "*/node_modules/*"], timeout: Duration.seconds(30) });
    const path = yield* Path.Path;
    const skills = new Map<string, string>();
    for (const file of found.stdout.split("\n").filter(Boolean)) {
      const dir = path.dirname(file);
      const rel = path.relative(scratch, dir);
      const name = path.basename(dir === scratch ? scratch.replace(/\/$/, "") : dir);
      if (!skills.has(name)) skills.set(name, rel === "" ? "." : rel);
    }
    return skills;
  });

const copyDir = (from: string, to: string) =>
  Effect.gen(function* () {
    yield* exec({ command: "rm", args: ["-rf", to], timeout: Duration.seconds(30) });
    const cp = yield* exec({ command: "cp", args: ["-R", from, to], timeout: Duration.seconds(60) });
    if (cp.code !== 0) return yield* Effect.fail(`copying into ${to}: ${cp.stderr.trim()}`);
    yield* exec({ command: "rm", args: ["-rf", `${to}/.git`], timeout: Duration.seconds(10) });
  });

/**
 * Vendor skills from `spec` into the repo. `names` empty takes the only
 * skill (or fails listing the choices); `as` renames one on a clash.
 * Returns the repo paths changed.
 */
export const addSkills = (repo: string, spec: string, names: ReadonlyArray<string>, as?: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const { url, name: sourceName } = parseSource(spec);
    const scratch = path.join(process.env["HOME"] ?? "/tmp", ".local/state/fleetx/skill-source");
    const available = yield* fetchSource(url, scratch);
    if (available.size === 0) return yield* Effect.fail(`${url} has no SKILL.md`);
    const wanted = names.length > 0 ? names : available.size === 1 ? [...available.keys()] : [];
    if (wanted.length === 0) return yield* Effect.fail(`${url} has several skills; name the ones to add: ${[...available.keys()].sort().join(", ")}`);
    if (as !== undefined && wanted.length !== 1) return yield* Effect.fail("--as renames exactly one skill");
    const sources = yield* readSources(repo);
    const entry = { ...(sources.sources?.[sourceName] ?? { type: "github", url, skills: [] }) };
    const paths: Record<string, string> = { ...(entry.paths ?? {}) };
    const renamed: Record<string, string> = { ...(entry.renamed ?? {}) };
    const changed: Array<string> = [];
    for (const upstream of wanted) {
      const rel = available.get(upstream);
      if (rel === undefined) return yield* Effect.fail(`${url} has no skill ${upstream} (it has: ${[...available.keys()].sort().join(", ")})`);
      const local = as ?? upstream;
      const dest = path.join(repo, "skills", local);
      const owned = Object.values(sources.sources ?? {}).some((s) => s.skills.includes(local)) || (sources.local ?? []).includes(local);
      if ((yield* fs.exists(dest).pipe(Effect.orElseSucceed(() => false))) && !owned) {
        return yield* Effect.fail(`skills/${local} already exists and came from elsewhere; use --as <name>`);
      }
      yield* copyDir(path.join(scratch, rel), dest);
      paths[local] = rel;
      if (local !== upstream) renamed[local] = upstream;
      changed.push(`skills/${local}`);
    }
    const skills = [...new Set([...entry.skills, ...wanted.map((w) => as ?? w)])].sort();
    yield* writeSources(repo, {
      ...sources,
      sources: { ...(sources.sources ?? {}), [sourceName]: { ...entry, url, skills, paths, ...(Object.keys(renamed).length > 0 ? { renamed } : {}) } },
    });
    return [...changed, "skills/SOURCES.json"];
  });

/** Re-pull vendored skills from their sources; `only` limits which. Returns the paths that changed on disk. */
export const updateSkills = (repo: string, only: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const sources = yield* readSources(repo);
    const touched: Array<string> = [];
    for (const [, source] of Object.entries(sources.sources ?? {})) {
      const mine = source.skills.filter((s) => only.length === 0 || only.includes(s));
      if (mine.length === 0) continue;
      const scratch = path.join(process.env["HOME"] ?? "/tmp", ".local/state/fleetx/skill-source");
      const available = yield* fetchSource(source.url, scratch);
      for (const local of mine) {
        const upstream = source.renamed?.[local] ?? local;
        const rel = source.paths?.[local] ?? available.get(upstream);
        if (rel === undefined) continue;
        yield* copyDir(path.join(scratch, rel), path.join(repo, "skills", local));
        touched.push(`skills/${local}`);
      }
    }
    return touched;
  });

/** Drop vendored skills and their provenance. Returns the repo paths changed. */
export const removeSkills = (repo: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sources = yield* readSources(repo);
    const next: Record<string, typeof Source.Type> = {};
    for (const [key, s] of Object.entries(sources.sources ?? {})) {
      const skills = s.skills.filter((x) => !names.includes(x));
      if (skills.length > 0) next[key] = { ...s, skills };
    }
    yield* writeSources(repo, { ...sources, sources: next, ...(sources.local ? { local: sources.local.filter((x) => !names.includes(x)) } : {}) });
    for (const name of names) {
      const rm = yield* git(repo, ["rm", "-rq", "--ignore-unmatch", "--", `skills/${name}`]);
      if (!ok(rm)) return yield* Effect.fail(`removing skills/${name}: ${why(rm)}`);
    }
    return [...names.map((n) => `skills/${n}`), "skills/SOURCES.json"];
  });
