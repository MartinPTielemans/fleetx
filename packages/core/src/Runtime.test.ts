// A plain test writing temp files; the effect under test runs with Node's services.
// @effect-diagnostics globalTimers:off
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vite-plus/test";

import { launchdReload, newBuild, untilReplaced } from "./Runtime.ts";

describe("untilReplaced", () => {
  // A service whose stop takes a while, like the relay's server waiting out its graceful shutdown.
  const slowToStop = (events: Array<string>) =>
    Effect.never.pipe(
      Effect.onInterrupt(() =>
        Effect.sleep(Duration.millis(150)).pipe(
          Effect.andThen(Effect.sync(() => events.push("stopped"))),
        ),
      ),
    );

  it("without drain, exits as soon as the new build is seen, not after the service has stopped", async () => {
    const events: Array<string> = [];
    const replaced = Deferred.makeUnsafe<void>();
    const fiber = Effect.runFork(
      untilReplaced(slowToStop(events), Deferred.await(replaced), {
        exit: () => events.push("exit"),
      }),
    );
    Effect.runSync(Deferred.succeed(replaced, undefined));
    await Effect.runPromise(Fiber.await(fiber));
    expect(events).toEqual(["exit", "stopped"]);
  });

  it("with drain, keeps the service running until the drain is done, and exits once it has stopped", async () => {
    const events: Array<string> = [];
    const replaced = Deferred.makeUnsafe<void>();
    const drained = Deferred.makeUnsafe<void>();
    const fiber = Effect.runFork(
      untilReplaced(slowToStop(events), Deferred.await(replaced), {
        drain: Deferred.await(drained).pipe(
          Effect.andThen(Effect.sync(() => events.push("drained"))),
        ),
        exit: () => events.push("exit"),
      }),
    );
    Effect.runSync(Deferred.succeed(replaced, undefined));
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([]);
    Effect.runSync(Deferred.succeed(drained, undefined));
    await Effect.runPromise(Fiber.await(fiber));
    expect(events).toEqual(["drained", "stopped", "exit"]);
  });

  it("exits the same way for a restart, saying its reason (the relay's settings changed)", async () => {
    const events: Array<string> = [];
    const restart = Deferred.makeUnsafe<string>();
    const logged: Array<string> = [];
    const log = console.log;
    console.log = (line: string) => void logged.push(line);
    try {
      const fiber = Effect.runFork(
        untilReplaced(slowToStop(events), Effect.never, {
          restart: Deferred.await(restart),
          exit: () => events.push("exit"),
        }),
      );
      Effect.runSync(Deferred.succeed(restart, "its settings changed"));
      await Effect.runPromise(Fiber.await(fiber));
    } finally {
      console.log = log;
    }
    expect(events).toEqual(["exit", "stopped"]);
    expect(logged).toContain("its settings changed");
  });

  it("never exits when the service stops on its own", async () => {
    const events: Array<string> = [];
    await Effect.runPromise(
      untilReplaced(Effect.void, Effect.never, { exit: () => events.push("exit") }),
    );
    expect(events).toEqual([]);
  });
});

describe("launchdReload", () => {
  /**
   * A fake launchctl that behaves like the real one: after bootout the old job stays
   * listed while it exits (for `exiting` more prints), and a bootstrap meanwhile fails.
   */
  const fakeLaunchctl = (exiting: number) => {
    const dir = mkdtempSync(join(tmpdir(), "t3-fleet-launchctl-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "left"), "loaded");
    writeFileSync(
      join(dir, "bin", "launchctl"),
      `#!/bin/sh
state="${dir}/left"; log="${dir}/log"
echo "$1" >> "$log"
case "$1" in
  bootout) echo ${exiting} > "$state" ;;
  print) n=$(cat "$state"); [ "$n" = loaded ] && exit 0; [ "$n" -gt 0 ] || exit 113; echo $((n - 1)) > "$state" ;;
  bootstrap) n=$(cat "$state"); if [ "$n" = 0 ]; then echo bootstrapped >> "$log"; else echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi ;;
esac
`,
    );
    writeFileSync(join(dir, "bin", "sleep"), "#!/bin/sh\n");
    chmodSync(join(dir, "bin", "launchctl"), 0o755);
    chmodSync(join(dir, "bin", "sleep"), 0o755);
    const run = (script: string) => {
      try {
        execFileSync("/bin/sh", ["-c", script], {
          env: { PATH: `${dir}/bin:/usr/bin:/bin` },
          stdio: "pipe",
        });
        return 0;
      } catch {
        return 1;
      }
    };
    return { run, log: () => readFileSync(join(dir, "log"), "utf8").trim().split("\n") };
  };

  it("bootstraps only once the old job is gone", () => {
    const launchctl = fakeLaunchctl(3);
    expect(launchctl.run(launchdReload("dev.t3-fleet.models", '"/tmp/x.plist"', 75))).toBe(0);
    expect(launchctl.log()).toEqual([
      "bootout",
      "print",
      "print",
      "print",
      "print",
      "bootstrap",
      "bootstrapped",
    ]);
  });

  it("gives up waiting after the old job's ExitTimeOut and a margin", () => {
    const launchctl = fakeLaunchctl(1000);
    expect(launchctl.run(launchdReload("dev.t3-fleet.relay", '"/tmp/x.plist"', 2))).toBe(1);
    // ExitTimeOut 2 plus a 10s margin: 12 one-second waits, so 13 looks.
    expect(launchctl.log().filter((l) => l === "print").length).toBe(13);
    expect(launchctl.log().at(-1)).toBe("bootstrap");
  });
});

describe("newBuild", () => {
  it("completes once the bundle holds a different build, and not before", async () => {
    const bundle = join(mkdtempSync(join(tmpdir(), "t3-fleet-build-")), "t3-fleet.mjs");
    writeFileSync(bundle, "old build");
    const watch = newBuild(bundle, Duration.millis(20)).pipe(Effect.provide(NodeServices.layer));
    const unchanged = await Effect.runPromise(
      watch.pipe(Effect.timeout(Duration.millis(200)), Effect.option),
    );
    expect(unchanged._tag).toBe("None");
    const replace = Effect.sleep(Duration.millis(60)).pipe(
      Effect.flatMap(() => Effect.sync(() => writeFileSync(bundle, "new build"))),
    );
    const [digest] = await Effect.runPromise(Effect.all([watch, replace], { concurrency: 2 }));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  }, 15_000);
});
