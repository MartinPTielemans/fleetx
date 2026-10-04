/**
 * Running a command and collecting its output, with a timeout that leaves a
 * result instead of an error: T3 Fleet probes machines it does not control, and
 * "this binary hangs" is a finding, not a crash.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export interface ExecInput {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  /** Replaces the inherited environment entirely unless `extendEnv` is set. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly extendEnv?: boolean;
  readonly stdin?: string;
  readonly timeout?: Duration.Input;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Null when the process could not be spawned or timed out. */
  readonly code: number | null;
  readonly timedOut: boolean;
  /** Set when the process could not be spawned at all. */
  readonly spawnError?: string;
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

export const exec = (
  input: ExecInput,
): Effect.Effect<ExecResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(input.command, [...(input.args ?? [])], {
      ...(input.env === undefined ? {} : { env: input.env, extendEnv: input.extendEnv ?? false }),
      stdin: input.stdin === undefined ? "ignore" : "pipe",
    });
    const run = Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(command);
        if (input.stdin !== undefined) {
          yield* Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin);
        }
        const [stdout, stderr, code] = yield* Effect.all(
          [collect(child.stdout), collect(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, code: Number(code), timedOut: false } satisfies ExecResult;
      }),
    );
    const timed = yield* run.pipe(
      Effect.timeoutOption(input.timeout ?? Duration.seconds(30)),
      Effect.result,
    );
    if (timed._tag === "Failure") {
      return {
        stdout: "",
        stderr: "",
        code: null,
        timedOut: false,
        spawnError: String(timed.failure),
      };
    }
    return Option.getOrElse(timed.success, (): ExecResult => ({
      stdout: "",
      stderr: "",
      code: null,
      timedOut: true,
    }));
  });

/** First dotted version in a `--version` line: "2.1.288 (Claude Code)", "codex-cli 0.160.0". */
export const parseVersion = (text: string): string | undefined =>
  /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/.exec(text)?.[0];
