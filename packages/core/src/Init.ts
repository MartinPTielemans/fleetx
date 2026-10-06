/**
 * The pieces every way into a fleet shares: this machine's pointer to its
 * config repo, and a machine added to the repo by an authority (`invite`).
 * Starting or joining a fleet is `t3-fleet setup` (setup/).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { commitAndPush } from "./Git.ts";
import { configDir } from "./Names.ts";

const tilde = (p: string, home: string) =>
  p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;

const tomlString = (s: string) => JSON.stringify(s);

/** Write this machine's pointer to its config repo. */
export const writeLocalConfig = (repo: string, node: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = process.env["HOME"] ?? "";
    yield* fs.makeDirectory(configDir(home), { recursive: true });
    yield* fs.writeFileString(
      `${configDir(home)}/config.toml`,
      `repo = ${tomlString(tilde(repo, home))}\nnode = ${tomlString(node)}\n`,
    );
  });

/** Where `curl … | sh` gets T3 Fleet from. */
export const INSTALL_URL =
  "https://github.com/MartinPTielemans/fleetx/releases/latest/download/install.sh";

/**
 * `s` as one POSIX shell word: left bare when it holds only characters no
 * shell treats specially, single-quoted (with `'` written as `'\''`) otherwise.
 */
export const shellWord = (s: string) =>
  /^[A-Za-z0-9@%+=:,./_-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * The one line that sets up `name` on its own machine, joining the fleet at
 * `url`. Both are quoted: a URL's `&` or `;` must reach setup intact, never
 * run as shell on the new machine.
 */
export const inviteLine = (url: string, name: string) =>
  `curl -fsSL ${INSTALL_URL} | sh -s -- setup ${shellWord(url)} ${shellWord(name)}`;

/** Add a node to the repo (an authority inviting a machine). */
export const addNode = (
  repo: string,
  name: string,
  ssh: string | null,
  profiles: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${repo}/nodes/${name}.toml`;
    if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))
      return yield* Effect.fail(`nodes/${name}.toml already exists`);
    const lines = [`# ${name}: added by t3-fleet invite.`, 'roles = ["member"]'];
    if (ssh !== null) lines.push(`ssh = ${tomlString(ssh)}`);
    if (profiles.length > 0) lines.push(`profiles = [${profiles.map(tomlString).join(", ")}]`);
    yield* fs.writeFileString(file, `${lines.join("\n")}\n`);
    return yield* commitAndPush(repo, [`nodes/${name}.toml`], `Invite ${name}`);
  });
