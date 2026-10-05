// install.sh against stubs: curl hands out a fake t3-fleet.mjs that records how it was run,
// and uname says which desktop there is. What a first install opens, and what a command reads.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync, spawn, spawnSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

const INSTALL = join(import.meta.dirname, "../../../install.sh");

/** The t3-fleet the stub curl downloads: it writes its arguments, and whether its input is a terminal. */
const FAKE = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("0.0.0-test"); process.exit(0); }
writeFileSync(process.env.HOME + "/ran.json",
  JSON.stringify({ args: process.argv.slice(2), tty: process.stdin.isTTY === true }));
`;

const stub = (dir: string, name: string, body: string) => {
  fs.writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  fs.chmodSync(join(dir, name), 0o755);
};

/** A home with stubs on PATH: no SHA256SUMS, no gh signed in, and `uname -s` saying `os`. */
const machine = (os: "Linux" | "Darwin") => {
  const home = fs.mkdtempSync(join(tmpdir(), "t3-fleet-install-"));
  const stubs = join(home, "stubs");
  fs.mkdirSync(stubs);
  fs.writeFileSync(join(stubs, "fake.mjs"), FAKE);
  stub(
    stubs,
    "curl",
    `out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
case "$url" in *t3-fleet.mjs) cp "${stubs}/fake.mjs" "$out";; *) exit 22;; esac`,
  );
  stub(stubs, "gh", "exit 1");
  stub(stubs, "uname", `echo ${os}`);
  return { home, stubs };
};

const PATH = (stubs: string) => [stubs, dirname(process.execPath), "/usr/bin", "/bin"].join(":");

/** `curl … | sh -s -- args`, as the README has it: the script's input is the pipe. */
const install = (
  m: { home: string; stubs: string },
  args: ReadonlyArray<string> = [],
  env: Readonly<Record<string, string>> = {},
) => {
  const out = execFileSync(
    "/bin/sh",
    ["-c", `cat "${INSTALL}" | sh -s -- ${args.map((a) => `'${a}'`).join(" ")}`],
    { encoding: "utf8", env: { HOME: m.home, PATH: PATH(m.stubs), ...env } },
  );
  const ran = join(m.home, "ran.json");
  const record = fs.existsSync(ran)
    ? (JSON.parse(fs.readFileSync(ran, "utf8")) as { args: Array<string>; tty: boolean })
    : null;
  return { out, ran: record };
};

describe("install.sh", () => {
  it("opens setup in the browser on a first install with a desktop: a Mac, or DISPLAY/WAYLAND_DISPLAY", () => {
    expect(install(machine("Darwin")).ran?.args).toEqual(["ui"]);
    expect(install(machine("Linux"), [], { DISPLAY: ":0" }).ran?.args).toEqual(["ui"]);
    expect(install(machine("Linux"), [], { WAYLAND_DISPLAY: "wayland-0" }).ran?.args).toEqual([
      "ui",
    ]);
  });

  it("prints the next command without a desktop, and says nothing more on an update", () => {
    const m = machine("Linux");
    const first = install(m);
    expect(first.ran).toBeNull();
    expect(first.out).toContain("next: run `t3-fleet setup`");
    const again = install(m, [], { DISPLAY: ":0" });
    expect(again.ran).toBeNull();
    expect(again.out).not.toContain("next:");
  });

  it("runs a command it is given, as it was given", () => {
    const m = machine("Darwin");
    expect(install(m, ["setup", "git@github.com:o/fleet.git", "desk"]).ran?.args).toEqual([
      "setup",
      "git@github.com:o/fleet.git",
      "desk",
    ]);
  });

  // A pseudo-terminal (python's pty, which makes it the controlling terminal) gives the
  // pipeline a terminal, as a person running the invite line has.
  const PTY = "import pty, sys; pty.spawn(['/bin/sh', '-c', sys.argv[1]])";
  const hasPty =
    spawnSync("python3", ["-c", PTY, "true"], { stdio: "ignore", timeout: 5000 }).status === 0;
  it.skipIf(!hasPty)(
    "gives the command the terminal, not the pipe, so setup can ask",
    async () => {
      const m = machine("Linux");
      const line = `cat "${INSTALL}" | sh -s -- setup git@github.com:o/fleet.git desk`;
      // pty.spawn can outlive its child on macOS: wait for the record, then stop it.
      const pty = spawn("python3", ["-c", PTY, line], {
        stdio: "ignore",
        env: { HOME: m.home, PATH: PATH(m.stubs) },
      });
      const ran = join(m.home, "ran.json");
      for (let i = 0; i < 100 && !fs.existsSync(ran); i++)
        await Effect.runPromise(Effect.sleep(100));
      pty.kill();
      expect(JSON.parse(fs.readFileSync(ran, "utf8"))).toEqual({
        args: ["setup", "git@github.com:o/fleet.git", "desk"],
        tty: true,
      });
    },
    15_000,
  );
});
