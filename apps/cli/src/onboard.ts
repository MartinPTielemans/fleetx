/**
 * Getting machines into a fleet.
 *
 *   init     on the first machine: a config repo from what is already here
 *   invite   on an authority: add a machine, print the command to run there
 *   join     on the new machine: clone the repo, take its place, first sync
 */
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { expandHome, loadConfig, loadConfigFrom } from "@t3-fleet/core/Config";
import { exec } from "@t3-fleet/core/Exec";
import { ensureGitConfig, git, ok, out, why } from "@t3-fleet/core/Git";
import { addNode, createRepo, discover, writeLocalConfig } from "@t3-fleet/core/Init";
import { ensureIdentity, installSecrets } from "@t3-fleet/core/Secrets";
import { syncRun, underSyncLock } from "@t3-fleet/core/Sync";

import { reportUserErrors } from "./shared.ts";
import { stateDir } from "@t3-fleet/core/Names";

const INSTALL_URL = "https://github.com/MartinPTielemans/fleetx/releases/latest/download/install.sh";

export const initCommand = Command.make("init", {
  repo: Flag.String("repo").pipe(Flag.withDescription("Where to create the config repo."), Flag.withDefault("~/fleet")),
  github: Flag.String("github").pipe(
    Flag.withDescription("Also create this private GitHub repository (owner/name) with gh, and push."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Start a fleet from what this machine already has. Reads and copies; changes nothing here."),
  Command.withHandler(({ repo, github }) =>
    Effect.gen(function* () {
      const home = process.env["HOME"] ?? "";
      const path = yield* Path.Path;
      const target = path.resolve(expandHome(repo, home));
      const found = yield* discover;
      yield* Console.log(`Found on ${found.node}:`);
      yield* Console.log(`  agents        ${found.agents.join(", ") || "none"}${found.t3 ? `, ${found.t3}` : ""}`);
      yield* Console.log(`  skills        ${found.skills.length}`);
      yield* Console.log(`  mcp servers   ${found.mcp.map((m) => m.name).join(", ") || "none"}`);
      yield* Console.log(`  instructions  ${found.instructions.map((i) => i.dest).join(", ") || "none"}`);
      const tokens = found.mcp.filter((m) => m.secret !== null).length;
      if (tokens > 0) yield* Console.log(`  secrets       ${tokens} token${tokens === 1 ? "" : "s"} from MCP config, stored encrypted`);
      const { recipient } = yield* createRepo(target, found);
      yield* writeLocalConfig(target, found.node);
      yield* Console.log(`\nCreated ${target} (node ${found.node}, authority). This machine's key: ${recipient}`);
      if (github._tag === "Some") {
        const gh = yield* exec({
          command: "gh",
          args: ["repo", "create", github.value, "--private", "--source", target, "--push"],
          timeout: Duration.minutes(2),
        });
        if (gh.code !== 0) return yield* Effect.fail(`gh repo create: ${gh.stderr.trim().split("\n").pop() ?? ""}`);
        yield* Console.log(`Pushed to the private repository ${github.value}.`);
      } else {
        yield* Console.log("Next: push it to a private repository, for example\n  gh repo create <you>/fleet --private --source " + target + " --push");
      }
      yield* Console.log("Then add another machine with: t3-fleet invite <name>");
    }).pipe(reportUserErrors),
  ),
);

export const inviteCommand = Command.make("invite", {
  name: Argument.String("name").pipe(Argument.withDescription("The new machine's name in the fleet.")),
  ssh: Flag.String("ssh").pipe(Flag.withDescription("Its ssh destination, when it differs from the name."), Flag.optional),
  profile: Flag.String("profile").pipe(Flag.withDescription("A profile it uses (repeatable)."), Flag.atLeast(0)),
}).pipe(
  Command.withDescription("Add a machine to the fleet and print the command to run on it (authority)."),
  Command.withHandler(({ name, ssh, profile }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      if (!config.nodes.find((n) => n.name === config.self)?.roles.includes("authority")) {
        return yield* Effect.fail(`${config.self} is not an authority`);
      }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return yield* Effect.fail("names are lowercase letters, digits and dashes");
      const url = out(yield* git(config.repo, ["remote", "get-url", "origin"]));
      if (url === "") return yield* Effect.fail("the config repo has no origin remote yet; push it to a private repository first");
      const rev = yield* underSyncLock(addNode(config.repo, name, ssh._tag === "Some" ? ssh.value : null, profile));
      yield* Console.log(`Added nodes/${name}.toml (${rev}). On ${name}, run:\n\n  curl -fsSL ${INSTALL_URL} | sh -s -- join ${url} ${name}\n`);
      yield* Console.log("It joins, publishes its state, and this machine's next sync lets it read the secrets.");
    }).pipe(reportUserErrors),
  ),
);

export const joinCommand = Command.make("join", {
  url: Argument.String("repo-url").pipe(Argument.withDescription("The fleet's config repository.")),
  name: Argument.String("name").pipe(Argument.withDescription("This machine's name, as invited.")),
  dir: Flag.String("dir").pipe(Flag.withDescription("Where to clone it; defaults to the fleet's [fleet] checkout."), Flag.optional),
}).pipe(
  Command.withDescription("Join a fleet: clone its config repo, take this machine's place in it, sync once."),
  Command.withHandler(({ url, name, dir }) =>
    Effect.gen(function* () {
      const home = process.env["HOME"] ?? "";
      const path = yield* Path.Path;
      yield* ensureGitConfig;
      const scratch = path.join(stateDir(home), "join-clone");
      yield* exec({ command: "rm", args: ["-rf", scratch], timeout: Duration.seconds(30) });
      const clone = yield* git(home, ["clone", "-q", url, scratch], { timeout: Duration.minutes(5) });
      if (!ok(clone)) return yield* Effect.fail(`cloning ${url}: ${why(clone)} (is gh logged in? run: gh auth login)`);
      const probe = yield* loadConfigFrom(scratch, name).pipe(Effect.mapError((e) => e.message));
      const target = path.resolve(expandHome(dir._tag === "Some" ? dir.value : probe.checkout, home));
      if (yield* exec({ command: "test", args: ["-e", target], timeout: Duration.seconds(2) }).pipe(Effect.map((r) => r.code === 0))) {
        return yield* Effect.fail(`${target} already exists; move it or pass --dir`);
      }
      yield* exec({ command: "mkdir", args: ["-p", path.dirname(target)], timeout: Duration.seconds(5) });
      const move = yield* exec({ command: "mv", args: [scratch, target], timeout: Duration.seconds(30) });
      if (move.code !== 0) return yield* Effect.fail(`moving the clone into place: ${move.stderr.trim()}`);
      yield* writeLocalConfig(target, name);
      const { recipient } = yield* ensureIdentity;
      yield* Console.log(`Joined as ${name}; config repo at ${target}. This machine's key: ${recipient}`);
      const config = yield* loadConfig;
      const result = yield* syncRun(config, { apply: true });
      for (const line of result.lines) yield* Console.log(`  ${line}`);
      const secrets = yield* installSecrets(target).pipe(Effect.option);
      yield* Console.log(
        secrets._tag === "Some"
          ? "Secrets installed."
          : "Secrets follow once an authority's next sync adds this machine's key (or run there: t3-fleet secrets add-node " + name + " " + recipient + ").",
      );
    }).pipe(reportUserErrors),
  ),
);
