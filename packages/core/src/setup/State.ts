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
import { decryptWith, encryptFor, ensureIdentity } from "../Secrets.ts";

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

/**
 * Take the snapshot, unless an earlier setup on this machine already did.
 * Then a later run adds the client entries it hands to the fleet (`handed`)
 * that the snapshot does not have yet; what is there is never changed.
 */
export const takeSnapshot = (
  home: string,
  now: number,
  raw: {
    readonly claude: Readonly<Record<string, unknown>> | null;
    readonly codex: Readonly<Record<string, unknown>> | null;
  },
  handed: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const existing = yield* readSnapshot(home);
    if (Option.isSome(existing)) {
      const add = (have: Readonly<Record<string, unknown>>, found: typeof raw.claude) =>
        Object.fromEntries(
          Object.entries(found ?? {}).filter(([n]) => handed.includes(n) && !(n in have)),
        );
      const claude = add(existing.value.claude.mcpServers, raw.claude);
      const codex = add(existing.value.codex.mcp_servers, raw.codex);
      if (Object.keys(claude).length + Object.keys(codex).length === 0) return existing.value;
      const grown: Snapshot = {
        ...existing.value,
        claude: { mcpServers: { ...existing.value.claude.mcpServers, ...claude } },
        codex: { mcp_servers: { ...existing.value.codex.mcp_servers, ...codex } },
      };
      yield* writePrivate(snapshotPath(home), grown);
      return grown;
    }
    const snapshot: Snapshot = {
      takenAt: now,
      claude: { mcpServers: { ...raw.claude } },
      codex: { mcp_servers: { ...raw.codex } },
      moved: [],
    };
    yield* writePrivate(snapshotPath(home), snapshot);
    return snapshot;
  });

/** Record one path setup moves aside, before it moves: a run that stops between the two still lists it. */
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
 * A run of setup, decided in full before its first step: `input` is what
 * Apply.ts needs (SetupInput), with every secret value removed. The values
 * are in setup/secrets.age, encrypted to this machine's key, so a resume
 * never plans again: it does exactly what was decided.
 */
export const Progress = Schema.Struct({
  startedAt: Schema.Number,
  mode: Schema.Literals(["first", "join", "again"]),
  node: Schema.String,
  checkout: Schema.String,
  /** The fleet's URL, any credential in it removed. */
  url: Schema.NullOr(Schema.String),
  input: Schema.Unknown,
  /** Steps finished, in order. */
  done: Schema.Array(Schema.String),
  /** The step that failed last, and why. */
  failed: Schema.NullOr(Schema.Struct({ step: Schema.String, why: Schema.String })),
  finishedAt: Schema.NullOr(Schema.Number),
});
export type Progress = typeof Progress.Type;

const decodeProgress = Schema.decodeEffect(Schema.fromJsonString(Progress));

export const runSecretsPath = (home: string) => `${stateDir(home)}/setup/secrets.age`;

export const readProgress = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(setupStatePath(home)).pipe(Effect.option);
    if (Option.isNone(text)) return Option.none<Progress>();
    return yield* decodeProgress(text.value).pipe(Effect.option);
  });

export const writeProgress = (home: string, progress: Progress) =>
  writePrivate(setupStatePath(home), progress);

/** The run's secret values (NAME=value lines), encrypted to this machine's own key. */
/** The run's secret values (NAME=value lines), encrypted to this machine's own key, marked with the run. */
export const saveRunSecrets = (home: string, startedAt: number, plaintext: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { recipient } = yield* ensureIdentity;
    const armored = yield* encryptFor([recipient], `# run ${startedAt}\n${plaintext}`);
    yield* fs.makeDirectory(`${stateDir(home)}/setup`, { recursive: true });
    yield* fs.writeFileString(runSecretsPath(home), armored, { mode: 0o600 });
    yield* fs.chmod(runSecretsPath(home), 0o600);
  });

/**
 * The secret values of the run started at `startedAt`: missing, unreadable,
 * or another run's, the resume stops rather than write empty values.
 */
export const loadRunSecrets = (home: string, startedAt: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stop = (why: string) =>
      Effect.fail(
        `${why}; this run cannot resume without them. \`t3-fleet setup --abandon\` drops it (what it did stays), then run setup again`,
      );
    const armored = yield* fs.readFileString(runSecretsPath(home)).pipe(Effect.option);
    if (Option.isNone(armored)) return yield* stop(`${runSecretsPath(home)} is missing`);
    const { identity } = yield* ensureIdentity;
    const text = yield* decryptWith(identity, armored.value).pipe(Effect.option);
    if (Option.isNone(text))
      return yield* stop(`${runSecretsPath(home)} does not decrypt with this machine's key`);
    if (!text.value.startsWith(`# run ${startedAt}\n`))
      return yield* stop(`${runSecretsPath(home)} belongs to another run`);
    return text.value;
  });

/** Forget an unfinished run: its progress and its secret values. What it changed stays. */
export const dropRun = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(setupStatePath(home), { force: true });
    yield* fs.remove(runSecretsPath(home), { force: true });
  });

/**
 * Paths setup wrote into the checkout on a member: sync proposes them
 * whatever [fleet] auto_commit says, until none of them differs any more.
 */
export const setupProposedPath = (home: string) => `${stateDir(home)}/setup/proposed.json`;

const ProposedPaths = Schema.Struct({ paths: Schema.Array(Schema.String) });

export const setupProposed = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(setupProposedPath(home)).pipe(Effect.option);
    if (Option.isNone(text)) return [] as ReadonlyArray<string>;
    return Option.match(Schema.decodeOption(Schema.fromJsonString(ProposedPaths))(text.value), {
      onNone: () => [] as ReadonlyArray<string>,
      onSome: (p) => p.paths,
    });
  });

export const addSetupProposed = (home: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const have = yield* setupProposed(home);
    yield* writePrivate(setupProposedPath(home), {
      paths: [...new Set([...have, ...paths])].sort(),
    });
  });

export const clearSetupProposed = (home: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.remove(setupProposedPath(home), { force: true })),
    Effect.ignore,
  );
