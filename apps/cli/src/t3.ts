/**
 * fleetx t3 connect   give fleetx a read-only token for this machine's T3 server,
 *                     so provider logins and health come from T3 itself
 *                     (the fix for t3-access; see T3Access.ts)
 */
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command } from "effect/unstable/cli";

import { exec } from "@fleetx/core/Exec";
import { mintAccess, readProviderSnapshot, t3AccessPath, t3CliFromCommandLine } from "@fleetx/core/T3Access";

import { reportUserErrors } from "./shared.ts";

const RuntimeFile = Schema.Struct({ pid: Schema.Number, origin: Schema.String });

const connect = Command.make("connect").pipe(
  Command.withDescription("Give fleetx a read-only (orchestration:read) token for this machine's T3 server."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const home = process.env["HOME"] ?? "";
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(`${home}/.t3/userdata/server-runtime.json`).pipe(Effect.mapError(() => "no T3 server has run here"));
      const runtime = yield* Schema.decodeEffect(Schema.fromJsonString(RuntimeFile))(text).pipe(Effect.mapError(() => "server-runtime.json is unreadable"));
      const ps = yield* exec({ command: "ps", args: ["-ww", "-p", String(runtime.pid), "-o", "command="], timeout: Duration.seconds(5) });
      if (ps.code !== 0 || ps.stdout.trim() === "") return yield* Effect.fail(`the T3 server (pid ${runtime.pid}) is not running`);
      const cli = t3CliFromCommandLine(ps.stdout);
      if (cli === null) return yield* Effect.fail("could not find T3's CLI from the running server's command line");
      const access = yield* mintAccess({ home, origin: runtime.origin, cli, now: yield* Clock.currentTimeMillis }).pipe(Effect.mapError((e) => e.message));
      const check = yield* readProviderSnapshot(access.origin, access.token);
      yield* Console.log(`wrote ${t3AccessPath(home).replace(home, "~")}: orchestration:read for ${access.origin}, valid ${Math.round((access.expiresAt - (yield* Clock.currentTimeMillis)) / 86_400_000)} days`);
      yield* Console.log(check._tag === "ok" ? `T3 reports ${check.providers.length} provider instances` : `but reading T3 failed: ${check._tag === "rejected" ? "token refused" : check.detail}`);
    }).pipe(reportUserErrors),
  ),
);

export const t3Command = Command.make("t3").pipe(
  Command.withDescription("fleetx's access to T3 Code on this machine."),
  Command.withSubcommands([connect]),
);
