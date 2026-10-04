/**
 * Setup's changes, in steps. Each step is recorded in setup.json when it
 * finishes, so a run that fails resumes at the step that failed, and every
 * step can run again over its own half-done work.
 *
 *   snapshot  before.json, before anything else changes (State.ts)
 *   repo      first machine: the repository, its first commit, and its remote
 *   clone     joining machine: the fleet's repository, cloned into place
 *   content   skills, MCP definitions, instruction files, settings
 *   keys      this machine's key; secrets encrypted (an authority), or
 *             proposed encrypted for an authority to merge (any other)
 *   commit    first machine or an authority: commit and push (Git.commitAndPush)
 *   config    ~/.config/t3-fleet/config.toml
 *   links     what the repo now holds, linked into place; the originals moved
 *             to ~/.local/state/t3-fleet/setup/backup and listed in before.json
 *   t3        T3 Fleet's read-only token for T3 (t3-fleet t3 connect)
 *   sync      a first sync, applying only the areas setup covers
 *
 * A joining machine never commits to the branch: its additions and choices
 * are local edits under [fleet] auto_commit, which its first sync proposes.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { parse as parseToml } from "smol-toml";

import type { ProbeServices } from "../Area.ts";
import { loadConfig } from "../Config.ts";
import { exec } from "../Exec.ts";
import { commitAndPush, ensureGitConfig, git, ok, out, why } from "../Git.ts";
import { writeLocalConfig } from "../Init.ts";
import { FLEET_FILE } from "../Names.ts";
import {
  decryptWith,
  encryptFor,
  ensureIdentity,
  installSecrets,
  localSecretsPath,
  readRecipients,
  readSecrets,
  setVar,
  varNames,
  writeRecipients,
  writeSecrets,
} from "../Secrets.ts";
import { recordSources } from "../SkillSources.ts";
import { syncRun } from "../Sync.ts";
import type { Secret } from "./Credentials.ts";
import type { Discovery } from "./Discover.ts";
import { PROPOSED_SECRETS, type Actions, type Mode } from "./Plan.ts";
import type { Preflight } from "./Preflight.ts";
import { GITIGNORE, newFleetFile, newNodeFile } from "./Repo.ts";
import { backupDir, recordMoved, takeSnapshot } from "./State.ts";
import { addToList, appendEntry, setKey, type Edit } from "./TomlEdit.ts";

export interface Extras {
  /** An always-on machine: the relay. `url` is where the others reach it. */
  readonly relay: { readonly url: string | null; readonly token: string | null } | null;
  /** The model proxy, with Claude's long-lived token when one was given. */
  readonly models: { readonly token: string | null } | null;
  /** T3 Fleet's read-only token for T3. */
  readonly t3: boolean;
}

export interface SetupInput {
  readonly mode: Mode;
  readonly node: string;
  /** Where the config repo lives on this machine. */
  readonly checkout: string;
  /** The joining machine's fleet URL, and the scratch clone of it. */
  readonly join: { readonly url: string; readonly clone: string } | null;
  /** Whether this machine commits (first, or an authority) rather than proposing. */
  readonly commits: boolean;
  readonly actions: Actions;
  readonly extras: Extras;
  readonly timer: Preflight["timer"];
  /** First machine: create this GitHub repository with gh, or push to an existing empty remote. */
  readonly remote: { readonly github: string } | { readonly url: string } | null;
  readonly raw: Discovery["raw"];
  readonly now: number;
}

export interface Step {
  readonly id: string;
  readonly title: string;
  /** What it did, a line each. */
  readonly run: Effect.Effect<ReadonlyArray<string>, string, ProbeServices>;
}

const fail = (what: string) => (e: unknown) =>
  `${what}: ${typeof e === "string" ? e : e instanceof Error ? e.message : typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e)}`;

const sh = (command: string, args: ReadonlyArray<string>, seconds = 60) =>
  exec({ command, args, timeout: Duration.seconds(seconds) });

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Edit a TOML file in the checkout (creating it from `initial` when missing), or fail with why. */
const editToml = (file: string, initial: string, steps: ReadonlyArray<(text: string) => Edit>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const before = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => initial));
    let text = before;
    for (const step of steps) {
      const edit = step(text);
      if ("error" in edit) return yield* Effect.fail(`${file}: ${edit.error}`);
      text = edit.text;
    }
    if (text !== before || !(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))))
      yield* fs.writeFileString(file, text);
  });

/** Copy a skill into the repo without any .git in it: a clone committed as a gitlink reaches no other machine. */
const copySkill = (from: string, to: string) =>
  Effect.gen(function* () {
    yield* sh("rm", ["-rf", to], 30);
    yield* sh("mkdir", ["-p", to.slice(0, to.lastIndexOf("/"))], 5);
    const cp = yield* sh("cp", ["-R", from, to]);
    if (cp.code !== 0) return yield* Effect.fail(`copying ${from}: ${cp.stderr.trim()}`);
    yield* sh("find", [to, "-name", ".git", "-prune", "-exec", "rm", "-rf", "{}", "+"], 30);
  });

/** Every secret setup stores: the servers', and the extras'. */
export const secretsToStore = (input: SetupInput): ReadonlyArray<Secret> => [
  ...input.actions.secrets,
  ...(input.extras.relay?.token != null
    ? [{ name: "T3_FLEET_RELAY_TOKEN", value: input.extras.relay.token, where: "relay" }]
    : []),
  ...(input.extras.models?.token != null
    ? [
        {
          name: "CLAUDE_CODE_OAUTH_TOKEN",
          value: input.extras.models.token,
          where: "claude setup-token",
        },
      ]
    : []),
];

/** The steps for this run, in order. `hooks` are what only the command can do. */
export const setupSteps = (
  input: SetupInput,
  hooks: { readonly t3Connect: Effect.Effect<string, string, ProbeServices> },
): ReadonlyArray<Step> => {
  const home = process.env["HOME"] ?? "";
  const repo = input.checkout;
  const nodeFile = `${repo}/nodes/${input.node}.toml`;
  const fleetFile = `${repo}/${FLEET_FILE}`;
  const steps: Array<Step> = [];

  steps.push({
    id: "snapshot",
    title: "snapshot of the clients' MCP servers (for t3-fleet leave)",
    run: takeSnapshot(home, input.now, input.raw).pipe(
      Effect.map(() => ["~/.local/state/t3-fleet/setup/before.json"]),
      Effect.mapError(fail("snapshot")),
    ),
  });

  if (input.mode === "first") {
    steps.push({
      id: "repo",
      title: `the config repo at ${repo}`,
      run: Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const lines: Array<string> = [];
        const exists = yield* fs.exists(`${repo}/.git`).pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          const files = yield* fs
            .readDirectory(repo)
            .pipe(Effect.orElseSucceed(() => [] as Array<string>));
          if (files.length > 0)
            return yield* Effect.fail(`${repo} already exists and is not empty; pass --dir`);
          yield* fs.makeDirectory(`${repo}/nodes`, { recursive: true });
          yield* fs.writeFileString(
            fleetFile,
            newFleetFile({
              checkout: repo.startsWith(`${home}/`) ? `~${repo.slice(home.length)}` : repo,
              servers: [],
              instructions: [],
            }),
          );
          const roles = input.extras.relay === null ? ["authority"] : ["authority", "relay"];
          yield* fs.writeFileString(nodeFile, newNodeFile(input.node, roles, "t3-fleet setup"));
          yield* fs.writeFileString(`${repo}/.gitignore`, GITIGNORE);
          yield* ensureGitConfig;
          const init = yield* git(repo, ["init", "-q", "-b", "main"]);
          if (!ok(init)) return yield* Effect.fail(`git init: ${why(init)}`);
          yield* git(repo, ["add", "--", FLEET_FILE, "nodes", ".gitignore"]);
          const commit = yield* git(repo, [
            "commit",
            "-q",
            "-m",
            `Start the fleet on ${input.node}`,
          ]);
          if (!ok(commit)) return yield* Effect.fail(`git commit: ${why(commit)}`);
          lines.push(`created ${repo}`);
        }
        const origin = out(yield* git(repo, ["remote", "get-url", "origin"]));
        if (origin === "" && input.remote !== null) {
          if ("github" in input.remote) {
            const gh = yield* sh(
              "gh",
              ["repo", "create", input.remote.github, "--private", "--source", repo, "--push"],
              120,
            );
            if (gh.code !== 0)
              return yield* Effect.fail(
                `gh repo create ${input.remote.github}: ${gh.stderr.trim().split("\n").pop() ?? ""} (pass --github <owner/name> for another name)`,
              );
            lines.push(`created the private repository ${input.remote.github}`);
          } else {
            yield* git(repo, ["remote", "add", "origin", input.remote.url]);
            const push = yield* git(repo, ["push", "-q", "-u", "origin", "main"], {
              timeout: Duration.minutes(2),
            });
            if (!ok(push))
              return yield* Effect.fail(`pushing to ${input.remote.url}: ${why(push)}`);
            lines.push(`pushed to ${input.remote.url}`);
          }
        }
        return lines;
      }).pipe(Effect.mapError(fail("creating the repo"))),
    });
  }

  if (input.join !== null) {
    const join = input.join;
    steps.push({
      id: "clone",
      title: `the fleet's repo at ${repo}`,
      run: Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (yield* fs.exists(`${repo}/.git`).pipe(Effect.orElseSucceed(() => false))) {
          const origin = out(yield* git(repo, ["remote", "get-url", "origin"]));
          if (origin === join.url) return [`${repo} is already a clone of ${join.url}`];
          return yield* Effect.fail(
            `${repo} already holds another repository (${origin || "no remote"}); pass --dir`,
          );
        }
        if (yield* fs.exists(repo).pipe(Effect.orElseSucceed(() => false)))
          return yield* Effect.fail(`${repo} already exists; move it or pass --dir`);
        yield* fs.makeDirectory(repo.slice(0, repo.lastIndexOf("/")), { recursive: true });
        yield* fs.rename(join.clone, repo);
        return [`cloned ${join.url} into ${repo}`];
      }).pipe(Effect.mapError(fail("cloning"))),
    });
  }

  steps.push({
    id: "content",
    title: "skills, MCP servers, instructions and settings in the repo",
    run: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const a = input.actions;
      const lines: Array<string> = [];
      for (const s of a.skills) yield* copySkill(s.from, `${repo}/skills/${s.name}`);
      const sourced = a.skills.flatMap((s) =>
        s.source === null ? [] : [{ name: s.name, ...s.source }],
      );
      if (sourced.length > 0) yield* recordSources(repo, sourced);
      if (a.skills.length > 0) lines.push(`skills: ${a.skills.map((s) => s.name).join(", ")}`);
      if (a.servers.length > 0) {
        yield* fs.makeDirectory(`${repo}/mcp`, { recursive: true });
        for (const s of a.servers)
          yield* fs.writeFileString(`${repo}/mcp/${s.name}.json`, pretty(s.definition));
        lines.push(`MCP servers: ${a.servers.map((s) => s.name).join(", ")}`);
      }
      for (const i of a.instructions) {
        yield* fs.makeDirectory(`${repo}/${i.src}`.slice(0, `${repo}/${i.src}`.lastIndexOf("/")), {
          recursive: true,
        });
        yield* fs.writeFileString(`${repo}/${i.src}`, i.text);
      }
      if (a.instructions.length > 0)
        lines.push(`instructions: ${a.instructions.map((i) => i.dest).join(", ")}`);

      const fleet = a.servers.filter((s) => s.scope === "fleet").map((s) => s.name);
      const machine = a.servers.filter((s) => s.scope === "machine").map((s) => s.name);
      yield* editToml(fleetFile, "", [
        (t) =>
          fleet.length === 0 ? { text: t } : addToList(t, ["defaults", "mcp"], "servers", fleet),
        // An instruction the fleet already lists keeps its entry; only its file changes.
        ...a.instructions.map(
          (i) => (t: string) =>
            t.includes(`dest = ${JSON.stringify(i.dest)}`)
              ? { text: t }
              : appendEntry(t, ["defaults", "instructions"], { src: i.src, dest: i.dest }),
        ),
        (t) =>
          input.extras.relay === null || /^\[relay\]/m.test(t)
            ? { text: t }
            : relayEdits(t, input.extras.relay.url),
        ...(input.extras.models === null
          ? []
          : [
              (t: string) =>
                /^\[defaults\.models\]/m.test(t)
                  ? { text: t }
                  : setKey(t, ["defaults", "models"], "egress", "direct"),
            ]),
      ]);
      const roles = input.extras.relay === null ? ["member"] : ["relay", "member"];
      yield* editToml(nodeFile, newNodeFile(input.node, roles, "t3-fleet setup"), [
        (t) => (machine.length === 0 ? { text: t } : addToList(t, ["mcp"], "servers.add", machine)),
        (t) =>
          a.serversHereOnly.length === 0
            ? { text: t }
            : addToList(t, ["mcp"], "servers.remove", a.serversHereOnly),
        (t) =>
          a.instructionsHereOnly.length === 0
            ? { text: t }
            : setKey(t, [], "instructions.remove", a.instructionsHereOnly),
        (t) =>
          input.timer.works ? { text: t } : setKey(t, ["engine"], "timer", false, input.timer.why),
        (t) => {
          const current = rolesOf(t);
          return input.extras.relay === null || current.includes("relay")
            ? { text: t }
            : setKey(t, [], "roles", [...current, "relay"]);
        },
      ]);
      return lines;
    }).pipe(Effect.mapError(fail("writing the repo"))),
  });

  steps.push({
    id: "keys",
    title: input.commits
      ? "this machine's key, and the secrets encrypted"
      : "this machine's key, and its secrets proposed",
    run: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { recipient } = yield* ensureIdentity;
      const store = secretsToStore(input);
      const recipients = yield* readRecipients(repo);
      if (input.commits) {
        if (recipients[input.node] !== recipient)
          yield* writeRecipients(repo, { ...recipients, [input.node]: recipient });
        let text = input.mode === "first" ? "" : yield* readSecrets(repo);
        for (const s of store) text = setVar(text, s.name, s.value);
        if (input.mode === "first" || store.length > 0) yield* writeSecrets(repo, text);
        yield* installSecrets(repo);
        return [
          `key ${recipient}`,
          ...(store.length > 0
            ? [`${store.length} secret${store.length === 1 ? "" : "s"} encrypted`]
            : []),
        ];
      }
      if (store.length === 0) return [`key ${recipient}`];
      // For every machine that can read the fleet's secrets (an authority merges them), and this one.
      let plain = "";
      for (const s of store) plain = setVar(plain, s.name, s.value);
      const armored = yield* encryptFor(
        [...new Set([...Object.values(recipients), recipient])],
        plain,
      );
      yield* fs.makeDirectory(`${repo}/${PROPOSED_SECRETS}`, { recursive: true });
      yield* fs.writeFileString(`${repo}/${PROPOSED_SECRETS}/${input.node}.env.age`, armored);
      // Here they work at once; the fleet's own replace them once an authority merges these.
      const local = yield* fs
        .readFileString(localSecretsPath(home))
        .pipe(Effect.orElseSucceed(() => ""));
      let merged = local;
      for (const s of store) merged = setVar(merged, s.name, s.value);
      yield* fs.makeDirectory(
        localSecretsPath(home).slice(0, localSecretsPath(home).lastIndexOf("/")),
        { recursive: true },
      );
      yield* fs.writeFileString(localSecretsPath(home), merged, { mode: 0o600 });
      yield* fs.chmod(localSecretsPath(home), 0o600);
      return [
        `key ${recipient}`,
        `${store.length} secret${store.length === 1 ? "" : "s"} proposed, encrypted, in ${PROPOSED_SECRETS}/${input.node}.env.age`,
      ];
    }).pipe(Effect.mapError(fail("secrets"))),
  });

  if (input.commits) {
    steps.push({
      id: "commit",
      title: "commit and push",
      run: Effect.gen(function* () {
        const paths = [
          FLEET_FILE,
          ".gitignore",
          "nodes",
          "skills",
          "mcp",
          "secrets",
          ...new Set(input.actions.instructions.map((i) => i.src.split("/")[0] ?? "")),
        ];
        const origin = out(yield* git(repo, ["remote", "get-url", "origin"]));
        if (origin !== "") {
          const rev = yield* commitAndPush(repo, paths, `Set up ${input.node}`);
          return [
            rev === "nothing to commit" ? "nothing new to commit" : `committed and pushed ${rev}`,
          ];
        }
        // No remote yet: commit here; pushing is the next step shown.
        yield* git(repo, ["add", "-A", "--", ...paths]);
        const commit = yield* git(repo, ["commit", "-q", "-m", `Set up ${input.node}`]);
        return [ok(commit) ? "committed (no remote yet)" : "nothing new to commit"];
      }).pipe(Effect.mapError(fail("committing"))),
    });
  }

  steps.push({
    id: "config",
    title: "~/.config/t3-fleet/config.toml",
    run: writeLocalConfig(repo, input.node).pipe(
      Effect.map(() => [`this machine is ${input.node}, its repo ${repo}`]),
      Effect.mapError(fail("writing the local config")),
    ),
  });

  steps.push({
    id: "links",
    title: "skills and instructions linked from the repo",
    run: linkAll(input.actions.links, `${backupDir(home)}/${input.now}`, home).pipe(
      Effect.mapError(fail("linking")),
    ),
  });

  if (input.extras.t3)
    steps.push({
      id: "t3",
      title: "T3 Fleet's read-only token for T3",
      // Optional: without it T3 Fleet reads less about T3, and says so in status.
      run: hooks.t3Connect.pipe(
        Effect.map((line) => [line]),
        Effect.catch((why) => Effect.succeed([`skipped (${why}); later: t3-fleet t3 connect`])),
      ),
    });

  steps.push({
    id: "sync",
    title: "a first sync",
    run: Effect.gen(function* () {
      const config = yield* loadConfig.pipe(Effect.mapError((e) => e.message));
      // MCP servers wait until this machine can read the fleet's secrets: registered without them, they would lose their credentials.
      const readable = yield* readSecrets(repo).pipe(Effect.option);
      const areas = [
        "engine",
        "secrets",
        "skills",
        "instructions",
        "dotfiles",
        ...(Option.isSome(readable) ? ["mcp"] : []),
      ];
      const result = yield* syncRun(config, { apply: true, areas });
      const lines = [...result.lines];
      if (Option.isNone(readable))
        lines.push(
          "MCP servers are registered once an authority's next sync adds this machine's key",
        );
      if (result.state !== null && result.state.result !== "ok")
        return yield* Effect.fail(`sync incomplete: ${result.state.message}`);
      return lines;
    }).pipe(Effect.mapError(fail("the first sync"))),
  });
  return steps;
};

const rolesOf = (text: string): Array<string> => {
  try {
    const roles = (parseToml(text) as { roles?: unknown }).roles;
    return Array.isArray(roles)
      ? roles.filter((r): r is string => typeof r === "string")
      : ["member"];
  } catch {
    return ["member"];
  }
};

const relayEdits = (text: string, url: string | null): Edit => {
  const port = setKey(text, ["relay"], "port", 8399);
  if ("error" in port || url === null) return port;
  return setKey(port.text, ["relay"], "url", url);
};

/**
 * Replace each path with its link. What is there is moved into `backups`
 * (keeping its path under ~) and recorded in before.json first; a path that
 * already links where it should is left as it is.
 */
export const linkAll = (
  links: ReadonlyArray<{ readonly path: string; readonly link: string | null }>,
  backups: string,
  home: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let moved = 0;
    let linked = 0;
    for (const { path: at, link } of links) {
      const current = yield* fs.readLink(at).pipe(Effect.option);
      if (link !== null && Option.isSome(current)) {
        const [real, want] = yield* Effect.all([
          fs.realPath(at).pipe(Effect.orElseSucceed(() => "")),
          fs.realPath(link).pipe(Effect.orElseSucceed(() => link)),
        ]);
        if (real === want) continue;
      }
      const present =
        Option.isSome(current) || (yield* fs.exists(at).pipe(Effect.orElseSucceed(() => false)));
      if (present) {
        const rel = at.startsWith(`${home}/`) ? at.slice(home.length + 1) : at.replace(/^\//, "");
        const backup = path.join(backups, rel);
        yield* fs.makeDirectory(path.dirname(backup), { recursive: true });
        yield* fs.rename(at, backup);
        yield* recordMoved(home, at, backup);
        moved++;
      }
      if (link !== null) {
        yield* fs.makeDirectory(path.dirname(at), { recursive: true });
        yield* fs.symlink(link, at);
        linked++;
      }
    }
    return [`${linked} linked, ${moved} moved aside to ${backups.replace(home, "~")}`];
  });

/**
 * Secrets machines proposed (secrets-proposed/<node>.env.age), merged into
 * the fleet's by an authority. A name the fleet already has keeps the
 * fleet's value; the proposal's is reported, not taken. Returns what it did.
 */
export const mergeProposedSecrets = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = `${repo}/${PROPOSED_SECRETS}`;
    const files = (yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>))).filter((f) => f.endsWith(".env.age"));
    if (files.length === 0) return [] as Array<string>;
    const { identity } = yield* ensureIdentity;
    let text = yield* readSecrets(repo);
    const have = new Set(varNames(text));
    const lines: Array<string> = [];
    for (const file of files) {
      const node = file.slice(0, -".env.age".length);
      const armored = yield* fs.readFileString(`${dir}/${file}`);
      const plain = yield* decryptWith(identity, armored).pipe(
        Effect.mapError(() => `${PROPOSED_SECRETS}/${file} is not encrypted to this machine's key`),
      );
      const values = new Map(
        plain
          .split("\n")
          .map((l) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l))
          .filter((m): m is RegExpExecArray => m !== null)
          .map(
            (m) =>
              [
                m[1] ?? "",
                (m[2] ?? "").replace(/^"(.*)"$/s, "$1").replace(/\\(["\\$`])/g, "$1"),
              ] as const,
          ),
      );
      const taken: Array<string> = [];
      for (const [name, value] of values) {
        if (have.has(name)) taken.push(name);
        else {
          text = setVar(text, name, value);
          have.add(name);
        }
      }
      yield* fs.remove(`${dir}/${file}`);
      lines.push(
        `merged ${values.size - taken.length} secret${values.size - taken.length === 1 ? "" : "s"} ${node} proposed${taken.length > 0 ? `; kept the fleet's ${taken.join(", ")}` : ""}`,
      );
    }
    yield* writeSecrets(repo, text);
    yield* installSecrets(repo);
    const rev = yield* commitAndPush(repo, ["secrets", PROPOSED_SECRETS], "Merge proposed secrets");
    return [...lines, `committed ${rev}`];
  });
