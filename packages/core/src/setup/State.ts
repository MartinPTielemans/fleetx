/**
 * What setup leaves on the machine for itself and for `t3-fleet leave`:
 *
 *   ~/.local/state/t3-fleet/setup.json          progress, so a failed run resumes
 *   ~/.local/state/t3-fleet/setup/before.json   the snapshot, taken before setup
 *                                               changes anything (mode 600)
 *   ~/.local/state/t3-fleet/setup/backup/…      what setup moved aside
 *
 * The snapshot is a contract with `leave`:
 *
 *   { "takenAt": <ms>,
 *     "claude": { "mcpServers": <user-scope entries as found> },
 *     "codex":  { "mcp_servers": <entries as found> },
 *     "moved":  [ { "path": "<original path>", "backup": "<where setup moved it>" } ] }
 *
 * `moved` covers every skill, instruction or dotfile path setup replaced with
 * a link. It is written once, by the first setup on a machine; later runs
 * only add to `moved`. Neither file ever goes into the config repo.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { stateDir } from "../Names.ts";

export const setupStatePath = (home: string) => `${stateDir(home)}/setup.json`;
export const snapshotPath = (home: string) => `${stateDir(home)}/setup/before.json`;
export const backupDir = (home: string) => `${stateDir(home)}/setup/backup`;

const Json = Schema.Record(Schema.String, Schema.Unknown);

export const Snapshot = Schema.Struct({
  takenAt: Schema.Number,
  claude: Schema.Struct({ mcpServers: Json }),
  codex: Schema.Struct({ mcp_servers: Json }),
  moved: Schema.Array(Schema.Struct({ path: Schema.String, backup: Schema.String })),
});
export type Snapshot = typeof Snapshot.Type;

const decodeSnapshot = Schema.decodeEffect(Schema.fromJsonString(Snapshot));

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const writePrivate = (file: string, value: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    yield* fs.writeFileString(file, pretty(value), { mode: 0o600 });
    yield* fs.chmod(file, 0o600);
  });

export const readSnapshot = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(snapshotPath(home)).pipe(Effect.option);
    if (Option.isNone(text)) return Option.none<Snapshot>();
    return yield* decodeSnapshot(text.value).pipe(
      Effect.asSome,
      Effect.mapError(
        () => `${snapshotPath(home)} is not readable; move it aside to take a new one`,
      ),
    );
  });

/** Take the snapshot, unless an earlier setup on this machine already did. */
export const takeSnapshot = (
  home: string,
  now: number,
  raw: {
    readonly claude: Readonly<Record<string, unknown>> | null;
    readonly codex: Readonly<Record<string, unknown>> | null;
  },
) =>
  Effect.gen(function* () {
    const existing = yield* readSnapshot(home);
    if (Option.isSome(existing)) return existing.value;
    const snapshot: Snapshot = {
      takenAt: now,
      claude: { mcpServers: { ...raw.claude } },
      codex: { mcp_servers: { ...raw.codex } },
      moved: [],
    };
    yield* writePrivate(snapshotPath(home), snapshot);
    return snapshot;
  });

/** Record one path setup moved aside, as soon as it has moved. */
export const recordMoved = (home: string, path: string, backup: string) =>
  Effect.gen(function* () {
    const current = yield* readSnapshot(home);
    if (Option.isNone(current))
      return yield* Effect.fail("setup moved a path before taking its snapshot");
    if (current.value.moved.some((m) => m.path === path && m.backup === backup)) return;
    yield* writePrivate(snapshotPath(home), {
      ...current.value,
      moved: [...current.value.moved, { path, backup }],
    });
  });

/**
 * Progress of a run. Holds the choices made and, once secrets are stored,
 * the decided actions with every secret value removed: a resume after that
 * must not depend on what the machine looks like now, since setup has
 * started changing it.
 */
export const Progress = Schema.Struct({
  startedAt: Schema.Number,
  mode: Schema.Literals(["first", "join", "again"]),
  node: Schema.String,
  checkout: Schema.String,
  url: Schema.NullOr(Schema.String),
  choices: Schema.Record(Schema.String, Schema.String),
  extras: Schema.Record(Schema.String, Schema.Boolean),
  /** Steps finished, in order. */
  done: Schema.Array(Schema.String),
  /** The step that failed last, and why. */
  failed: Schema.NullOr(Schema.Struct({ step: Schema.String, why: Schema.String })),
  /** Actions (Plan.ts), secret values removed; present once secrets are stored. */
  actions: Schema.optionalKey(Schema.Unknown),
  finishedAt: Schema.NullOr(Schema.Number),
});
export type Progress = typeof Progress.Type;

const decodeProgress = Schema.decodeEffect(Schema.fromJsonString(Progress));

export const readProgress = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(setupStatePath(home)).pipe(Effect.option);
    if (Option.isNone(text)) return Option.none<Progress>();
    return yield* decodeProgress(text.value).pipe(Effect.option);
  });

export const writeProgress = (home: string, progress: Progress) =>
  writePrivate(setupStatePath(home), progress);
