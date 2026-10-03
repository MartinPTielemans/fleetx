/**
 * A stdio server as a `StdioProcess`: lines written to its stdin, lines read
 * from its stdout. Stderr is kept as a short tail for error details, never
 * logged in full (a server may print whatever it likes there).
 *
 * The process belongs to the scope it was spawned in: closing the scope
 * kills it, which is how the bridge's supervisor restarts or stops it.
 */
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { StdioProcess } from "./Bridge.ts";

export interface SpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Added to the hub's own environment. */
  readonly env: Readonly<Record<string, string>>;
}

export const spawnStdio = (input: SpawnInput): Effect.Effect<StdioProcess, string, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner
      .spawn(ChildProcess.make(input.command, [...input.args], { env: { ...input.env }, extendEnv: true, stdin: "pipe", forceKillAfter: "3 seconds" }))
      .pipe(Effect.mapError((e) => `cannot start ${input.command}: ${e.message}`));
    const stdin = yield* Queue.make<string, Cause.Done>();
    yield* Stream.fromQueue(stdin).pipe(Stream.encodeText, Stream.run(child.stdin), Effect.ignore, Effect.forkScoped);
    let tail: Array<string> = [];
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          tail = [...tail, line.slice(0, 300)].slice(-5);
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const exited = yield* Deferred.make<string>();
    yield* child.exitCode.pipe(
      Effect.map((code) => `code ${Number(code)}`),
      Effect.orElseSucceed(() => "unknown exit"),
      Effect.flatMap((why) => Deferred.succeed(exited, tail.length === 0 ? why : `${why}: ${tail.join(" | ")}`)),
      Effect.forkScoped,
    );
    const process: StdioProcess = {
      write: (line) => Queue.offer(stdin, `${line}\n`).pipe(Effect.asVoid),
      lines: child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.ignore({ log: false })),
      exited: Deferred.await(exited),
    };
    return process;
  });
