/**
 * Changing the user's files without ever leaving them half-done.
 *
 *   writeAtomically   a whole file replaced by rename from a temporary file of
 *                     our own beside it, with the mode it had (or 600); the
 *                     file is read again just before, and a change since is a
 *                     conflict, not something to overwrite
 *   replaceWith       a link (or a missing path) replaced by a copy of what it
 *                     resolved to, or by a backup moved back, through a staging
 *                     directory beside it that says what it is for, so a run
 *                     that is interrupted is finished by the next one
 *
 * A staging directory is `.<name>.t3-fleet-leave-XXXXXX`, made with mkdtemp,
 * holding `marker.json` ({ path, source, how, ready }) and, as the work goes,
 * `copy` and `link`. Only directories with that name and a marker naming the
 * same path are ever touched again or removed.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON as people and T3 write it: two-space indent. */
export const prettyJson = (value: unknown) => JSON.stringify(value, null, 2);

/** `~/x` for display. */
export const tilde = (p: string, home: string) =>
  p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;

/** Whether `p` is `dir` or inside it, comparing the paths as written. */
export const within = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

const errorText = (e: unknown) =>
  typeof e === "string"
    ? e
    : isObject(e) && typeof e["message"] === "string"
      ? e["message"]
      : String(e);

/** Where a link points, as an absolute path (resolved against its directory); none for a non-link. */
export const linkTarget = (at: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs.readLink(at).pipe(Effect.option);
    return Option.map(raw, (r) => path.resolve(path.dirname(at), r));
  });

/**
 * Replace `file` with `text`: written to a fresh temporary file beside it,
 * given `file`'s mode (or `mode` for a new file), and renamed over it. A link
 * is followed, so the file it points to changes and the link stays. `before`
 * is the content the change was computed from (null: the file did not exist);
 * when the file no longer has it, nothing is written and this fails.
 */
export const writeAtomically = (
  file: string,
  text: string,
  before: string | null,
  options: { readonly mode?: number } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // A link is followed; a link to nothing is refused, never replaced by a file.
    const link = yield* linkTarget(file);
    const resolved = yield* fs.realPath(file).pipe(Effect.option);
    if (Option.isSome(link) && Option.isNone(resolved))
      return yield* Effect.fail(
        `${file} is a link to ${link.value}, which is missing; it was left as it is`,
      );
    const real = Option.getOrElse(resolved, () => file);
    const dir = path.dirname(real);
    yield* fs.makeDirectory(dir, { recursive: true });
    const info = yield* fs.stat(real).pipe(Effect.option);
    const mode = Option.isSome(info) ? info.value.mode & 0o777 : (options.mode ?? 0o600);
    const scratch = yield* fs.makeTempDirectory({
      directory: dir,
      prefix: `.${path.basename(real)}.t3-fleet-leave-`,
    });
    const tmp = path.join(scratch, "new");
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(tmp, text, { mode });
      yield* fs.chmod(tmp, mode);
      // Checked last, right before the rename, so the window for a write to be lost is as small as it can be without a lock.
      const now = yield* fs.readFileString(real).pipe(Effect.option);
      if (Option.getOrNull(now) !== before)
        return yield* Effect.fail(`${file} changed while T3 Fleet was editing it; run leave again`);
      yield* fs.rename(tmp, real);
    }).pipe(
      Effect.ensuring(fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore)),
    );
  }).pipe(Effect.mapError((e) => (typeof e === "string" ? e : `writing ${file}: ${errorText(e)}`)));

/**
 * Edits a file through `edit`, retrying a few times when something else
 * writes it meanwhile (Claude Code rewrites ~/.claude.json often). `edit`
 * gets the current text (null: no file) and returns the new text, or null to
 * leave the file as it is.
 */
export const editFile = <E, R>(
  file: string,
  edit: (text: string | null) => Effect.Effect<string | null, E, R>,
  options: { readonly mode?: number } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (let attempt = 1; ; attempt++) {
      const text = Option.getOrNull(yield* fs.readFileString(file).pipe(Effect.option));
      const next = yield* edit(text);
      if (next === null || next === text) return false;
      const written = yield* writeAtomically(file, next, text, options).pipe(Effect.result);
      if (written._tag === "Success") return true;
      if (attempt >= 3) return yield* Effect.fail(written.failure);
    }
  });

// ---- staging -----------------------------------------------------------------

export const STAGING_INFIX = ".t3-fleet-leave-";

export const Marker = Schema.Struct({
  /** The path being replaced. */
  path: Schema.String,
  /** What goes there: a copy of this ("copy"), or this moved back ("move"). */
  source: Schema.String,
  how: Schema.Literals(["copy", "move"]),
  /** The copy is complete (always true for a move). */
  ready: Schema.Boolean,
  /** Where the link being replaced pointed; null when nothing was there. */
  link: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type Marker = typeof Marker.Type;
const decodeMarker = Schema.decodeUnknownOption(Schema.fromJsonString(Marker));
const encodeMarker = Schema.encodeSync(Schema.fromJsonString(Marker));
/** Staging directories beside `at` that are ours and for `at`. */
export const stagingFor = (at: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.dirname(at);
    const prefix = `.${path.basename(at)}${STAGING_INFIX}`;
    const found: Array<{ readonly dir: string; readonly marker: Marker }> = [];
    for (const name of yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>))) {
      if (!name.startsWith(prefix)) continue;
      const staging = path.join(dir, name);
      const text = yield* fs.readFileString(path.join(staging, "marker.json")).pipe(Effect.option);
      const marker = Option.isSome(text) ? Option.getOrNull(decodeMarker(text.value)) : null;
      if (marker !== null && marker.path === at) found.push({ dir: staging, marker });
    }
    return found;
  });

/** Every staging directory of ours in `dir`, whatever path it is for (a run that died mid-way). */
export const stagingIn = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const found: Array<{ readonly dir: string; readonly marker: Marker }> = [];
    for (const name of yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>))) {
      if (!name.startsWith(".") || !name.includes(STAGING_INFIX)) continue;
      const text = yield* fs
        .readFileString(path.join(dir, name, "marker.json"))
        .pipe(Effect.option);
      const marker = Option.isSome(text) ? Option.getOrNull(decodeMarker(text.value)) : null;
      if (marker !== null && path.dirname(marker.path) === dir)
        found.push({ dir: path.join(dir, name), marker });
    }
    return found;
  });

const exists = (p: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.access(p)),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
/** Something is at `p`, even a link to nothing. */
const present = (p: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (Option.isSome(yield* fs.readLink(p).pipe(Effect.option))) return true;
    return yield* exists(p);
  });

/**
 * Finishes what a staging directory was for, from wherever the run that made
 * it stopped, then removes it; returns why it was left instead, if it was.
 * Its `link` is the link that was at the path, moved aside: it goes back
 * when the replacement is not ready. The directory is removed only when
 * nothing in it is needed any more: its replacement went into place, or the
 * path still has the very link it was made to replace (a copy of the repo
 * is made again from the repo). Anything else at the path is someone's, and
 * the staging directory, with whatever it holds, stays.
 */
export const finishStaging = (staging: string, marker: Marker) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const at = marker.path;
    const copy = path.join(staging, "copy");
    const link = path.join(staging, "link");
    const replacement =
      marker.how === "copy"
        ? marker.ready && (yield* present(copy))
          ? copy
          : null
        : (yield* present(marker.source))
          ? marker.source
          : null;
    if (!(yield* present(at))) {
      if (replacement !== null) yield* fs.rename(replacement, at);
      else if (yield* present(link)) yield* fs.rename(link, at);
      else return `${at} is missing, and ${staging} has nothing to put there; it is left as it is`;
    } else {
      const now = yield* linkTarget(at);
      const unchanged =
        Option.isSome(now) && marker.link !== undefined && now.value === marker.link;
      if (!unchanged || (yield* present(link)))
        return `${at} has something new in it, so ${staging} and what it holds are left as they are`;
    }
    yield* fs.remove(staging, { recursive: true, force: true });
    return null;
  }).pipe(Effect.mapError((e) => (typeof e === "string" ? e : errorText(e))));

/**
 * Replaces `at`, a link or nothing, with `source`: a copy of it (`how` copy;
 * `prepare` then edits the copy in place, with a scratch directory of its
 * own outside the copy, before it goes in) or `source` itself, moved (`how`
 * move). `stillWanted` is asked right before the link goes, so a change made
 * meanwhile is never overwritten.
 *
 * A file replaces the link in one rename. A directory cannot replace a link
 * atomically on POSIX: the link is moved into the staging directory and the
 * directory renamed into its place right after, so the path is missing only
 * between those two renames; a run interrupted there is finished by the next
 * (finishStaging).
 */
export const replaceWith = <E = never, R = never, E2 = never, R2 = never>(input: {
  readonly at: string;
  readonly source: string;
  readonly how: "copy" | "move";
  readonly prepare?: (copy: string, scratch: string) => Effect.Effect<void, E, R>;
  readonly stillWanted: Effect.Effect<boolean, E2, R2>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { at } = input;
    const original = Option.getOrNull(yield* linkTarget(at));
    const staging = yield* fs.makeTempDirectory({
      directory: path.dirname(at),
      prefix: `.${path.basename(at)}${STAGING_INFIX}`,
    });
    const marker = (ready: boolean): Marker => ({
      path: at,
      source: input.source,
      how: input.how,
      ready,
      link: original,
    });
    const writeMarker = (ready: boolean) =>
      fs.writeFileString(path.join(staging, "marker.json"), encodeMarker(marker(ready)));
    const copy = path.join(staging, "copy");
    const work = Effect.gen(function* () {
      yield* writeMarker(input.how === "move");
      if (input.how === "copy") {
        yield* fs.copy(input.source, copy);
        if (input.prepare !== undefined) {
          const scratch = path.join(staging, "scratch");
          yield* fs.makeDirectory(scratch);
          yield* input.prepare(copy, scratch);
          yield* fs.remove(scratch, { recursive: true });
        }
        yield* writeMarker(true);
      }
      if (!(yield* input.stillWanted)) return false;
      const replacement = input.how === "copy" ? copy : input.source;
      const isDir = (yield* fs.stat(replacement)).type === "Directory";
      if (isDir && (yield* present(at))) yield* fs.rename(at, path.join(staging, "link"));
      yield* fs.rename(replacement, at);
      return true;
    });
    // On failure, put things back as far as they got (finishStaging knows how), never lose the link.
    const done = yield* work.pipe(
      Effect.mapError(errorText),
      Effect.tapError(() =>
        Effect.gen(function* () {
          if (input.how === "copy") yield* fs.remove(copy, { recursive: true, force: true });
          yield* finishStaging(staging, marker(false));
        }).pipe(Effect.ignore),
      ),
    );
    yield* fs.remove(staging, { recursive: true, force: true });
    return done;
  }).pipe(Effect.mapError(errorText));
