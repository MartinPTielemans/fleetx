/**
 * t3-fleet t3 connect   give T3 Fleet a read-only token for this machine's T3 server,
 *                     so provider logins and health come from T3 itself
 *                     (the fix for t3-access; see T3Access.ts)
 * t3-fleet t3 update [--if-idle]   update this machine's T3 to its channel's newest
 *                     release; with --if-idle only while no thread runs
 *                     (the fix for t3-behind under [t3] update = "when-idle"; see T3Update.ts)
 */
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { exec } from "@t3-fleet/core/Exec";
import {
  mintAccess,
  readProviderSnapshot,
  t3AccessPath,
  t3CliFromCommandLine,
} from "@t3-fleet/core/T3Access";
import { updateT3 } from "@t3-fleet/core/T3Update";

import { reportUserErrors } from "./shared.ts";

const RuntimeFile = Schema.Struct({ pid: Schema.Number, origin: Schema.String });

/** Mint T3 Fleet's read-only token for the T3 server running here; what it did, in two lines. */
export const connectT3 = Effect.gen(function* () {
  const home = process.env["HOME"] ?? "";
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(`${home}/.t3/userdata/server-runtime.json`)
    .pipe(Effect.mapError(() => "no T3 server has run here"));
  const runtime = yield* Schema.decodeEffect(Schema.fromJsonString(RuntimeFile))(text).pipe(
    Effect.mapError(() => "server-runtime.json is unreadable"),
  );
  const ps = yield* exec({
    command: "ps",
    args: ["-ww", "-p", String(runtime.pid), "-o", "command="],
    timeout: Duration.seconds(5),
  });
  if (ps.code !== 0 || ps.stdout.trim() === "")
    return yield* Effect.fail(`the T3 server (pid ${runtime.pid}) is not running`);
  const cli = t3CliFromCommandLine(ps.stdout);
  if (cli === null)
    return yield* Effect.fail("could not find T3's CLI from the running server's command line");
  const access = yield* mintAccess({
    home,
    origin: runtime.origin,
    cli,
    now: yield* Clock.currentTimeMillis,
  }).pipe(Effect.mapError((e) => e.message));
  const check = yield* readProviderSnapshot(access.origin, access.token);
  const days = Math.round((access.expiresAt - (yield* Clock.currentTimeMillis)) / 86_400_000);
  return [
    `wrote ${t3AccessPath(home).replace(home, "~")}: orchestration:read for ${access.origin}, valid ${days} days`,
    check._tag === "ok"
      ? `T3 reports ${check.providers.length} provider instances`
      : `but reading T3 failed: ${check._tag === "rejected" ? "token refused" : check.detail}`,
  ] as const;
});

const connect = Command.make("connect").pipe(
  Command.withDescription(
    "Give T3 Fleet a read-only (orchestration:read) token for this machine's T3 server.",
  ),
  Command.withHandler(() =>
    connectT3.pipe(
      Effect.flatMap((lines) => Effect.forEach(lines, (line) => Console.log(line))),
      reportUserErrors,
    ),
  ),
);

const update = Command.make("update", {
  ifIdle: Flag.Boolean("if-idle").pipe(
    Flag.withDescription("Only while no thread is running here; otherwise say why and wait."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Update this machine's T3 (a CLI install, or the desktop app) to its channel's newest release.",
  ),
  Command.withHandler(({ ifIdle }) =>
    updateT3({ ifIdle }).pipe(
      Effect.flatMap((line) => Console.log(line)),
      reportUserErrors,
    ),
  ),
);

export const t3Command = Command.make("t3").pipe(
  Command.withDescription("T3 Fleet's access to T3 Code on this machine, and keeping it current."),
  Command.withSubcommands([connect, update]),
);
