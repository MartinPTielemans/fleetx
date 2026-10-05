/**
 * Keeping T3 itself current: `t3-fleet t3 update`, the fix for t3-behind when
 * a node's `[t3] update = "when-idle"`.
 *
 * Updating restarts T3's server, and on a Mac the desktop app around it, so a
 * thread running there stops. With `--if-idle` the update waits for a moment
 * when no thread on this machine is preparing, starting, running or waiting,
 * as T3 reports them to T3 Fleet's read-only token (GET /api/orchestration/shell).
 * Busy is not a failure: the next sync asks again. Before restarting, T3's
 * own `continueThreadsAfterServerUpdate` is turned on, so a thread that starts
 * in between resumes after the restart instead of stopping.
 *
 * A CLI install updates with its own `t3 update`. The desktop app downloads
 * and installs only when asked in its UI, so T3 Fleet installs it: the release's
 * <channel>-mac.yml names the app zip and its sha512, the unpacked app must be
 * signed by the installed app's team, and the old bundle is kept beside the new
 * one until the new one is in place.
 */
import { createHash } from "node:crypto";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { exec } from "./Exec.ts";
import { lookupLatest } from "./Latest.ts";
import { stateDir } from "./Names.ts";
import { readAccess, t3CliFromCommandLine } from "./T3Access.ts";
import { t3SettingsPath } from "./T3Settings.ts";
import { cliReleaseChannelOf } from "./vendor/t3/cliRelease.ts";

const RELEASES = "https://github.com/pingdotgg/t3code/releases/download";

const RuntimeFile = Schema.Struct({ pid: Schema.Number, origin: Schema.String });
const Descriptor = Schema.Struct({ serverVersion: Schema.String });

const ShellThread = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  activeRunId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  activityRunStatus: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Shell = Schema.Struct({ threads: Schema.Array(ShellThread) });

/** Titles of the threads T3 reports as doing something: a run that is preparing, starting, running or waiting. */
export const busyThreads = (shell: typeof Shell.Type): ReadonlyArray<string> =>
  shell.threads
    .filter((t) => (t.activeRunId ?? null) !== null || (t.activityRunStatus ?? null) !== null)
    .map((t) => t.title ?? "untitled");

/** What T3 on this machine is doing, from T3 Fleet's read-only token. */
export const activeThreads = (origin: string, token: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(new URL("/api/orchestration/shell", origin).toString()).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeader("x-t3-orchestration-protocol", "2"),
        ),
      )
      .pipe(
        Effect.timeout(Duration.seconds(15)),
        Effect.mapError(() => `T3 at ${origin} did not answer`),
      );
    if (response.status === 401 || response.status === 403)
      return yield* Effect.fail("T3 refused T3 Fleet's token: run t3-fleet t3 connect");
    if (response.status !== 200)
      return yield* Effect.fail(`T3 answered HTTP ${response.status} for its threads`);
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const shell = yield* Schema.decodeEffect(Schema.fromJsonString(Shell))(text).pipe(
      Effect.mapError(() => "T3's thread list was not understood"),
    );
    return busyThreads(shell);
  });

/** settings.json with continueThreadsAfterServerUpdate on; null when it already is. Pure, for tests. */
export const withContinuation = (text: string): string | null => {
  const settings = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
      text,
    ),
  );
  if (settings === undefined) return null;
  if (settings["continueThreadsAfterServerUpdate"] === true) return null;
  return `${JSON.stringify({ ...settings, continueThreadsAfterServerUpdate: true }, null, 2)}\n`;
};

/** Turn on T3's resuming of interrupted threads; T3 watches settings.json and picks it up. */
const enableContinuation = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = t3SettingsPath(home);
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => "{}"));
    const edited = withContinuation(text);
    if (edited === null) return false;
    const tmp = `${file}.t3-fleet-tmp`;
    yield* fs.writeFileString(tmp, edited, { mode: 0o600 });
    yield* fs.rename(tmp, file);
    return true;
  }).pipe(Effect.orElseSucceed(() => false));

/** The desktop app's bundle, from its server's command line; null for a CLI install. */
export const desktopBundle = (commandLine: string): string | null =>
  /^(\/.+?\.app)\/Contents\//.exec(commandLine.trim())?.[1] ?? null;

/** The app zip for `arch` and its sha512 (base64), from a release's <channel>-mac.yml. */
export const macZip = (yml: string, arch: "arm64" | "x64") => {
  const entries = [...yml.matchAll(/-\s+url:\s*(\S+)\s*\n\s+sha512:\s*(\S+)/g)];
  const hit = entries.find((m) => m[1]?.endsWith(`-${arch}.zip`));
  return hit?.[1] === undefined || hit[2] === undefined ? null : { file: hit[1], sha512: hit[2] };
};

const run = (command: string, args: ReadonlyArray<string>, seconds = 60) =>
  exec({ command, args, timeout: Duration.seconds(seconds) });

const teamOf = (app: string) =>
  run("codesign", ["-dv", app]).pipe(
    Effect.map((r) => /TeamIdentifier=(\S+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? null),
  );

/** Download, verify and swap in `version` of the desktop app at `app`, then open it again. */
const installDesktop = (home: string, app: string, version: string, appPid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const client = yield* HttpClient.HttpClient;
    const channel = cliReleaseChannelOf(version);
    const manifestName = channel === "stable" ? "latest-mac.yml" : `${channel}-mac.yml`;
    const base = `${RELEASES}/v${version}`;
    const get = (url: string) =>
      client.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(Duration.minutes(10)),
        Effect.mapError(() => `could not download ${url}`),
        Effect.flatMap((r) =>
          r.status === 200 ? Effect.succeed(r) : Effect.fail(`${url}: HTTP ${r.status}`),
        ),
      );
    const yml = yield* get(`${base}/${manifestName}`).pipe(
      Effect.flatMap((r) => r.text.pipe(Effect.mapError(() => `could not read ${manifestName}`))),
    );
    const zip = macZip(yml, process.arch === "arm64" ? "arm64" : "x64");
    if (zip === null) return yield* Effect.fail(`${manifestName} names no app for ${process.arch}`);

    const work = `${stateDir(home)}/t3-update`;
    yield* fs.remove(work, { recursive: true }).pipe(Effect.ignore);
    yield* fs.makeDirectory(work, { recursive: true });
    const bytes = yield* get(`${base}/${zip.file}`).pipe(
      Effect.flatMap((r) =>
        r.arrayBuffer.pipe(Effect.mapError(() => `could not read ${zip.file}`)),
      ),
    );
    const digest = createHash("sha512").update(new Uint8Array(bytes)).digest("base64");
    if (digest !== zip.sha512)
      return yield* Effect.fail(`${zip.file} does not match the sha512 in ${manifestName}`);
    yield* fs.writeFile(`${work}/app.zip`, new Uint8Array(bytes));
    const unpacked = yield* run("ditto", ["-x", "-k", `${work}/app.zip`, `${work}/app`], 300);
    if (unpacked.code !== 0) return yield* Effect.fail(`could not unpack ${zip.file}`);
    const name = app.split("/").pop() ?? "";
    const fresh = `${work}/app/${name}`;
    if (!(yield* fs.exists(fresh)))
      return yield* Effect.fail(`${zip.file} does not contain ${name}`);
    const verified = yield* run("codesign", ["--verify", "--deep", "--strict", fresh], 300);
    if (verified.code !== 0)
      return yield* Effect.fail(`${name} from ${zip.file} is not validly signed`);
    const [want, got] = [yield* teamOf(app), yield* teamOf(fresh)];
    if (want === null || want !== got)
      return yield* Effect.fail(
        `${name} from ${zip.file} is signed by ${got ?? "nobody"}, not ${want ?? "the installed app's team"}`,
      );

    // Quit the app, the way a user would, and wait for it to go.
    const bundleId = (yield* run("defaults", [
      "read",
      `${app}/Contents/Info.plist`,
      "CFBundleIdentifier",
    ])).stdout.trim();
    yield* run("osascript", ["-e", `tell application id "${bundleId}" to quit`]);
    let gone = false;
    for (let i = 0; i < 60 && !gone; i++) {
      gone = (yield* run("kill", ["-0", String(appPid)], 5)).code !== 0;
      if (!gone) yield* Effect.sleep(Duration.seconds(1));
    }
    if (!gone) {
      yield* run("open", [app]);
      return yield* Effect.fail(`${name} did not quit within a minute; left as it was`);
    }
    const previous = `${work}/previous.app`;
    const moved = yield* run("mv", [app, previous]);
    if (moved.code !== 0) {
      yield* run("open", [app]);
      return yield* Effect.fail(`could not move ${app} aside: ${moved.stderr.trim()}`);
    }
    const placed = yield* run("mv", [fresh, app]);
    if (placed.code !== 0) {
      yield* run("mv", [previous, app]);
      yield* run("open", [app]);
      return yield* Effect.fail(`could not put the new ${name} in place; the old one is back`);
    }
    yield* run("open", [app]);
    yield* fs.remove(work, { recursive: true }).pipe(Effect.ignore);
    return `installed ${name} ${version} and opened it again`;
  });

/** /run/user/<uid> when this process's user has a systemd user session; null elsewhere. */
const runtimeDirOf = () =>
  Effect.gen(function* () {
    if (process.platform !== "linux" || process.getuid === undefined) return null;
    const dir = `/run/user/${process.getuid()}`;
    return (yield* (yield* FileSystem.FileSystem)
      .exists(dir)
      .pipe(Effect.orElseSucceed(() => false)))
      ? dir
      : null;
  });

/**
 * What `t3 update` needs to reach T3's service when T3 Fleet runs as a system
 * unit (root on a server) while T3 is a systemd user service: a system unit
 * gets neither the user's runtime directory nor its session bus. Pure, for tests.
 */
export const userSession = (
  env: Readonly<Record<string, string | undefined>>,
  runtimeDir: string | null,
): Record<string, string> =>
  runtimeDir === null || env["XDG_RUNTIME_DIR"] !== undefined
    ? {}
    : {
        XDG_RUNTIME_DIR: runtimeDir,
        ...(env["DBUS_SESSION_BUS_ADDRESS"] === undefined
          ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` }
          : {}),
      };

/**
 * Update this machine's T3 to its channel's newest release. With `ifIdle`,
 * only when no thread is busy; otherwise the reason it waits is the result.
 */
export const updateT3 = (options: { readonly ifIdle: boolean }) =>
  Effect.gen(function* () {
    const home = process.env["HOME"] ?? "";
    const fs = yield* FileSystem.FileSystem;
    const runtimeText = yield* fs
      .readFileString(`${home}/.t3/userdata/server-runtime.json`)
      .pipe(Effect.mapError(() => "no T3 server has run here"));
    const runtime = yield* Schema.decodeEffect(Schema.fromJsonString(RuntimeFile))(
      runtimeText,
    ).pipe(Effect.mapError(() => "server-runtime.json is unreadable"));
    const ps = yield* run("ps", ["-ww", "-p", String(runtime.pid), "-o", "command="], 5);
    const commandLine = ps.stdout.trim();
    if (ps.code !== 0 || commandLine === "")
      return yield* Effect.fail(`the T3 server (pid ${runtime.pid}) is not running`);

    const client = yield* HttpClient.HttpClient;
    const descriptor = yield* client
      .execute(
        HttpClientRequest.get(new URL("/.well-known/t3/environment", runtime.origin).toString()),
      )
      .pipe(
        Effect.flatMap((r) => r.text),
        Effect.flatMap((t) => Schema.decodeEffect(Schema.fromJsonString(Descriptor))(t)),
        Effect.timeout(Duration.seconds(10)),
        Effect.mapError(() => `T3 at ${runtime.origin} did not say its version`),
      );
    const version = descriptor.serverVersion;
    const channel = cliReleaseChannelOf(version);
    const latest = yield* lookupLatest([version]);
    const newest = latest.t3[channel]?.versions[0];
    if (newest === undefined)
      return yield* Effect.fail(
        `could not look up T3's newest ${channel} release: ${latest.failed?.t3 ?? "no answer"}`,
      );
    if (newest === version) return `T3 ${version} is the newest ${channel} release`;

    if (options.ifIdle) {
      const access = yield* readAccess(home);
      if (Option.isNone(access))
        return yield* Effect.fail(
          "T3 Fleet has no token to see what T3 is doing: run t3-fleet t3 connect",
        );
      const busy = yield* activeThreads(access.value.origin, access.value.token);
      if (busy.length > 0)
        return `not updating T3 to ${newest} yet: ${busy.length} thread${busy.length === 1 ? " is" : "s are"} running (${busy.slice(0, 3).join(", ")}${busy.length > 3 ? ", …" : ""})`;
    }

    const continued = yield* enableContinuation(home);
    const note = continued ? " (turned on continuing threads after an update)" : "";
    const app = desktopBundle(commandLine);
    if (app !== null) {
      const appPid = Number(
        (yield* run("ps", ["-o", "ppid=", "-p", String(runtime.pid)], 5)).stdout.trim(),
      );
      return `${yield* installDesktop(home, app, newest, Number.isFinite(appPid) && appPid > 1 ? appPid : runtime.pid)}${note}`;
    }
    const cli = t3CliFromCommandLine(commandLine);
    if (cli === null)
      return yield* Effect.fail("could not find T3's CLI from the running server's command line");
    const updated = yield* exec({
      command: cli.command,
      args: [...cli.args, "update", "--channel", channel, "--yes"],
      env: { ...process.env, ...userSession(process.env, yield* runtimeDirOf()), ...cli.env },
      timeout: Duration.minutes(10),
    });
    if (updated.code !== 0)
      return yield* Effect.fail(
        `t3 update failed: ${(updated.stderr || updated.stdout).trim().split("\n").pop() ?? `exit ${updated.code}`}`,
      );
    return `updated T3 from ${version} to ${newest}${note}`;
  });
