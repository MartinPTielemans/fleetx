/**
 * Skills vendored from git repositories, with provenance in
 * skills/SOURCES.json so they can be updated later:
 *
 *   { "sources": { "<source>": { "type": "github", "url": "…", "skills": [names],
 *                                "paths": { name: "path/in/repo" },
 *                                "renamed": { localName: upstreamName } } } }
 *
 * Skills are copied, not referenced, so every node works offline and gets
 * exactly what was reviewed. Everything here that writes to the checkout
 * holds the sync lock, so no sync commits or proposes half a change.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { Config } from "./Config.ts";
import { exec } from "./Exec.ts";
import {
  allowedAt,
  changedFiles,
  commitAndPush,
  git,
  literal,
  nulList,
  ok,
  restorePaths,
  scanEdits,
  why,
} from "./Git.ts";
import { readAllowed, refusal } from "./SecretScan.ts";
import { sha256 } from "./Hash.ts";
import { stateDir } from "./Names.ts";
import { underSyncLock } from "./SyncLock.ts";

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
    return yield* Schema.decodeEffect(Schema.fromJsonString(SourcesFile))(text.value).pipe(
      Effect.mapError(() => "skills/SOURCES.json is not valid"),
    );
  });

/**
 * Each skill's entry in a SOURCES.json text: its source (or "local") and
 * where it comes from in it; none when the text is not a SOURCES.json.
 */
const entriesOf = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(SourcesFile))(text).pipe(
    Effect.map((file) => {
      const entries = new Map<string, string>();
      for (const [key, s] of Object.entries(file.sources ?? {}))
        for (const skill of s.skills)
          entries.set(
            skill,
            `${key}\0${s.url}\0${s.paths?.[skill] ?? ""}\0${s.renamed?.[skill] ?? ""}`,
          );
      for (const skill of file.local ?? []) entries.set(skill, "local");
      return entries;
    }),
    Effect.option,
  );

/**
 * The skills whose SOURCES.json entry the checkout's copy adds, removes or
 * changes against `base`: what goes with that file wherever it goes. Null
 * when the checkout's copy cannot be read, and so could name any skill.
 */
export const sourcesEntriesChanged = (repo: string, base = "HEAD") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const before = yield* git(repo, ["show", `${base}:skills/SOURCES.json`]);
    const now = yield* fs.readFileString(sourcesPath(repo)).pipe(Effect.orElseSucceed(() => ""));
    const was = yield* entriesOf(ok(before) ? before.stdout : '{"sources": {}}');
    const is = yield* entriesOf(now);
    // Unreadable (conflict markers, say): it could name any skill.
    if (Option.isNone(is)) return null;
    const a = Option.getOrElse(was, () => new Map<string, string>());
    const b = is.value;
    return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();
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
    if (url.startsWith("-")) return yield* Effect.fail(`not a git URL: ${url}`);
    const clone = yield* git(
      process.env["HOME"] ?? "/",
      ["clone", "-q", "--depth", "1", "--", url, scratch],
      { timeout: Duration.minutes(3) },
    );
    if (!ok(clone)) return yield* Effect.fail(`cloning ${url}: ${why(clone)}`);
    const found = yield* exec({
      command: "find",
      args: [
        scratch,
        "-name",
        "SKILL.md",
        "-not",
        "-path",
        "*/.git/*",
        "-not",
        "-path",
        "*/node_modules/*",
      ],
      timeout: Duration.seconds(30),
    });
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
    const cp = yield* exec({
      command: "cp",
      args: ["-R", from, to],
      timeout: Duration.seconds(60),
    });
    if (cp.code !== 0) return yield* Effect.fail(`copying into ${to}: ${cp.stderr.trim()}`);
    yield* exec({ command: "rm", args: ["-rf", `${to}/.git`], timeout: Duration.seconds(10) });
  });

/**
 * Vendor skills from `spec` into the repo. `names` empty takes the only
 * skill (or fails listing the choices); `as` renames one on a clash.
 * Returns the repo paths changed.
 */
export const addSkills = (repo: string, spec: string, names: ReadonlyArray<string>, as?: string) =>
  underSyncLock(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const { url, name: sourceName } = parseSource(spec);
      const scratch = path.join(stateDir(process.env["HOME"] ?? "/tmp"), "skill-source");
      const available = yield* fetchSource(url, scratch);
      if (available.size === 0) return yield* Effect.fail(`${url} has no SKILL.md`);
      const wanted = names.length > 0 ? names : available.size === 1 ? [...available.keys()] : [];
      if (wanted.length === 0)
        return yield* Effect.fail(
          `${url} has several skills; name the ones to add: ${[...available.keys()].sort().join(", ")}`,
        );
      if (as !== undefined && wanted.length !== 1)
        return yield* Effect.fail("--as renames exactly one skill");
      const sources = yield* readSources(repo);
      const entry = { ...(sources.sources?.[sourceName] ?? { type: "github", url, skills: [] }) };
      const paths: Record<string, string> = { ...entry.paths };
      const renamed: Record<string, string> = { ...entry.renamed };
      const changed: Array<string> = [];
      for (const upstream of wanted) {
        const rel = available.get(upstream);
        if (rel === undefined)
          return yield* Effect.fail(
            `${url} has no skill ${upstream} (it has: ${[...available.keys()].sort().join(", ")})`,
          );
        const local = as ?? upstream;
        const dest = path.join(repo, "skills", local);
        const owned =
          Object.values(sources.sources ?? {}).some((s) => s.skills.includes(local)) ||
          (sources.local ?? []).includes(local);
        if ((yield* fs.exists(dest).pipe(Effect.orElseSucceed(() => false))) && !owned) {
          return yield* Effect.fail(
            `skills/${local} already exists and came from elsewhere; use --as <name>`,
          );
        }
        yield* copyDir(path.join(scratch, rel), dest);
        paths[local] = rel;
        if (local !== upstream) renamed[local] = upstream;
        changed.push(`skills/${local}`);
      }
      const skills = [...new Set([...entry.skills, ...wanted.map((w) => as ?? w)])].sort();
      yield* writeSources(repo, {
        ...sources,
        sources: {
          ...sources.sources,
          [sourceName]: {
            ...entry,
            url,
            skills,
            paths,
            ...(Object.keys(renamed).length > 0 ? { renamed } : {}),
          },
        },
      });
      return [...changed, "skills/SOURCES.json"];
    }),
  );

const stagePath = () => `${stateDir(process.env["HOME"] ?? "/tmp")}/skill-update`;

/**
 * Pull `only` (all when empty) from upstream into a scratch directory, never
 * the checkout, and compare that with the checkout's last commit: what
 * keeping the update would change. The digest names exactly this change.
 */
const stageUpdate = (repo: string, only: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const sources = yield* readSources(repo);
    const stage = stagePath();
    yield* exec({ command: "rm", args: ["-rf", stage], timeout: Duration.seconds(30) });
    yield* fs.makeDirectory(path.join(stage, "skills"), { recursive: true });
    // The same ignore rules as the checkout, so the comparison sees what git would.
    for (const ignore of [".gitignore", "skills/.gitignore"])
      yield* fs.copyFile(path.join(repo, ignore), path.join(stage, ignore)).pipe(Effect.ignore);
    const touched: Array<string> = [];
    for (const [, source] of Object.entries(sources.sources ?? {})) {
      const mine = source.skills.filter((s) => only.length === 0 || only.includes(s));
      if (mine.length === 0) continue;
      const scratch = path.join(stateDir(process.env["HOME"] ?? "/tmp"), "skill-source");
      const available = yield* fetchSource(source.url, scratch);
      for (const local of mine) {
        const upstream = source.renamed?.[local] ?? local;
        const rel = source.paths?.[local] ?? available.get(upstream);
        if (rel === undefined) continue;
        yield* copyDir(path.join(scratch, rel), path.join(stage, "skills", local));
        touched.push(`skills/${local}`);
      }
    }
    return { stage, ...(yield* compareStaged(repo, stage, touched)) };
  });

/**
 * `touched` in the stage against the checkout's HEAD, through a scratch
 * index so the checkout's own index stays as it is.
 */
const compareStaged = (repo: string, stage: string, touched: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (touched.length === 0) return { files: [], stat: "", diff: "", digest: "" };
    const env = { GIT_INDEX_FILE: `${repo}/.git/t3-fleet-update-index`, ...literal };
    const read = yield* git(repo, ["read-tree", "HEAD"], { env });
    if (!ok(read)) return yield* Effect.fail(`reading the branch: ${why(read)}`);
    const add = yield* git(repo, ["--work-tree", stage, "add", "-A", "--", ...touched], { env });
    if (!ok(add)) return yield* Effect.fail(`git add failed: ${why(add)}`);
    const files = nulList(
      (yield* git(repo, ["diff", "--cached", "--name-only", "-z", "HEAD", "--", ...touched], {
        env,
      })).stdout,
    );
    if (files.length === 0) return { files: [], stat: "", diff: "", digest: "" };
    const stat = yield* git(repo, ["diff", "--cached", "--stat", "HEAD", "--", ...touched], {
      env,
    });
    const diff = yield* git(repo, ["diff", "--cached", "HEAD", "--", ...touched], { env });
    const digest = yield* Effect.promise(() => sha256(diff.stdout));
    return {
      files: [...new Set(files.map((f) => f.split("/").slice(0, 2).join("/")))],
      stat: stat.stdout.trimEnd(),
      diff: diff.stdout,
      digest,
    };
  });

/**
 * The checkout must be able to take an update: no edits of the skills' own,
 * which it would overwrite, and nothing git ignores in them, which git could
 * not put back.
 */
const readyForUpdate = (repo: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (paths.length === 0) return;
    const status = yield* git(
      repo,
      ["status", "--porcelain", "--ignored", "--untracked-files=all", "--", ...paths],
      { env: literal },
    );
    const lines = status.stdout.split("\n").filter(Boolean);
    const lost = lines.filter((l) => l.startsWith("!! ")).map((l) => l.slice(3));
    if (lost.length > 0)
      return yield* Effect.fail(
        `updating would delete files git ignores; move them out of the skill first: ${lost.join(", ")}`,
      );
    const dirty = lines.filter((l) => !l.startsWith("!! "));
    const held = yield* heldSkills(repo, paths);
    if (held.length > 0)
      return yield* Effect.fail(
        `sync holds back ${held.join(", ")}: an edit there looks like a secret, and no sync commits or proposes it. Take it out (\`t3-fleet secrets scan\` shows where), or have an authority allow the line, then update again.`,
      );
    if (dirty.length > 0)
      return yield* Effect.fail(
        `these skills have changes not yet committed or proposed; the next sync takes care of them, then try again:\n${dirty.join("\n")}`,
      );
  });

/** The skill directories among `paths` whose uncommitted edits sync holds back: they look like a secret. */
const heldSkills = (repo: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const edited = yield* changedFiles(repo, paths);
    const hits = yield* scanEdits(repo, edited);
    return [...new Set(hits.map((h) => h.file.split("/").slice(0, 2).join("/")))].sort();
  });

/** Drop vendored skills and their provenance. Returns the repo paths changed. */
export const removeSkills = (repo: string, names: ReadonlyArray<string>) =>
  underSyncLock(
    Effect.gen(function* () {
      const sources = yield* readSources(repo);
      const next: Record<string, typeof Source.Type> = {};
      for (const [key, s] of Object.entries(sources.sources ?? {})) {
        const skills = s.skills.filter((x) => !names.includes(x));
        if (skills.length > 0) next[key] = { ...s, skills };
      }
      yield* writeSources(repo, {
        ...sources,
        sources: next,
        ...(sources.local ? { local: sources.local.filter((x) => !names.includes(x)) } : {}),
      });
      for (const name of names) {
        const rm = yield* git(repo, ["rm", "-rq", "--ignore-unmatch", "--", `skills/${name}`]);
        if (!ok(rm)) return yield* Effect.fail(`removing skills/${name}: ${why(rm)}`);
      }
      return [...names.map((n) => `skills/${n}`), "skills/SOURCES.json"];
    }),
  );

/**
 * An authority commits and pushes; any other node leaves the change for its
 * next sync to propose. `paths` are what the command just wrote: when they
 * add what looks like a secret, they are put back as `before` (a snapshot
 * taken before the command wrote) has them, on any node, so no later sync
 * commits or proposes part of them and edits waiting there stay. What was
 * fetched can be fetched again once the line is allowed.
 */
export const land = (
  config: Config,
  paths: ReadonlyArray<string>,
  message: string,
  before?: string,
) =>
  underSyncLock(
    Effect.gen(function* () {
      const authority =
        config.nodes.find((n) => n.name === config.self)?.roles.includes("authority") === true;
      const hits = yield* scanEdits(config.repo, paths, {
        allowed: authority
          ? yield* readAllowed(config.repo)
          : yield* allowedAt(config.repo, `origin/${config.branch}`),
      });
      if (hits.length > 0) {
        yield* restorePaths(config.repo, paths, before);
        return yield* Effect.fail(`${refusal(hits)}\nNothing was changed.`);
      }
      if (authority) {
        const rev = yield* commitAndPush(config.repo, paths, message);
        return `committed and pushed (${rev})`;
      }
      return "the next sync proposes it for an authority's approval";
    }),
  );

/** The one-line `description:` in a SKILL.md's front matter, or null. */
export const skillDescription = (text: string) => {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const line =
    front === undefined ? undefined : /^description:[ \t]*(.*)$/m.exec(front)?.[1]?.trim();
  if (
    line === undefined ||
    line === "" ||
    line === "|" ||
    line === ">" ||
    line.startsWith("|") ||
    line.startsWith(">")
  )
    return null;
  return line.replace(/^(["'])(.*)\1$/, "$2");
};

/** Every skill in the repo's skills/, with its description and where it came from. */
export const listSkills = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sources = yield* readSources(repo).pipe(
      Effect.orElseSucceed((): SourcesFile => ({ sources: {} })),
    );
    const dir = path.join(repo, "skills");
    const names = (yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
      .filter((n) => !n.startsWith("."))
      .sort();
    const out: Array<{
      name: string;
      description: string | null;
      source: { name: string; url: string } | null;
    }> = [];
    for (const name of names) {
      const text = yield* fs.readFileString(path.join(dir, name, "SKILL.md")).pipe(Effect.option);
      if (Option.isNone(text)) continue;
      const source = Object.entries(sources.sources ?? {}).find(([, s]) => s.skills.includes(name));
      out.push({
        name,
        description: skillDescription(text.value),
        source: source === undefined ? null : { name: source[0], url: source[1].url },
      });
    }
    return out;
  });

/** The skills `spec` offers, and which of them the repo already has under that name. */
export const lookupSource = (repo: string, spec: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const { url } = parseSource(spec);
    const scratch = path.join(stateDir(process.env["HOME"] ?? "/tmp"), "skill-source");
    const available = yield* fetchSource(url, scratch);
    if (available.size === 0) return yield* Effect.fail(`${url} has no SKILL.md`);
    const skills: Array<{ name: string; exists: boolean }> = [];
    for (const name of [...available.keys()].sort()) {
      skills.push({
        name,
        exists: yield* fs
          .exists(path.join(repo, "skills", name))
          .pipe(Effect.orElseSucceed(() => false)),
      });
    }
    return { url, skills };
  });

/** The vendored skills `only` names (all of them when empty) that have a source to update from. */
const sourced = (repo: string, only: ReadonlyArray<string>) =>
  readSources(repo).pipe(
    Effect.map((sources) =>
      Object.values(sources.sources ?? {})
        .flatMap((s) => s.skills)
        .filter((s) => only.length === 0 || only.includes(s)),
    ),
  );

/**
 * Pull `only` from upstream and show what keeping it would change; the
 * checkout is not touched. Refuses when those skills have edits of their
 * own, which keeping would overwrite. The digest names exactly this change,
 * for keepUpdate.
 */
export const previewUpdate = (repo: string, only: ReadonlyArray<string>) =>
  underSyncLock(
    Effect.gen(function* () {
      const { names, skipped } = yield* updatable(repo, only);
      if (names.length === 0) return { files: [], stat: "", diff: "", digest: "", skipped };
      yield* readyForUpdate(
        repo,
        names.map((n) => `skills/${n}`),
      );
      const { files, stat, diff, digest } = yield* stageUpdate(repo, names);
      return { files, stat, diff, digest, skipped };
    }),
  );

/**
 * The skills an update covers: those `only` names, or every sourced one but
 * those sync holds back, which a bare update skips (`skipped`) rather than
 * let one held skill block the rest.
 */
const updatable = (repo: string, only: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const names = yield* sourced(repo, only);
    if (only.length > 0) return { names, skipped: [] as Array<string> };
    const held = yield* heldSkills(
      repo,
      names.map((n) => `skills/${n}`),
    );
    return {
      names: names.filter((n) => !held.includes(`skills/${n}`)),
      skipped: held,
    };
  });

/**
 * Pull `only` again and, if it is still the change `digest` names, copy it
 * into the checkout. Returns the paths to land.
 */
export const keepUpdate = (repo: string, only: ReadonlyArray<string>, digest: string) =>
  underSyncLock(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { names } = yield* updatable(repo, only);
      if (names.length === 0)
        return yield* Effect.fail("these skills changed since the preview; preview again");
      yield* readyForUpdate(
        repo,
        names.map((n) => `skills/${n}`),
      ).pipe(Effect.mapError(() => "these skills changed since the preview; preview again"));
      const now = yield* stageUpdate(repo, names);
      if (now.digest === "" || now.digest !== digest) {
        return yield* Effect.fail(
          now.digest === ""
            ? "nothing to update any more"
            : "upstream changed since the preview; preview again",
        );
      }
      for (const file of now.files)
        yield* copyDir(path.join(now.stage, file), path.join(repo, file));
      return now.files;
    }),
  );
