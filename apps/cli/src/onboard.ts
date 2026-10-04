/**
 * `t3-fleet invite <name>`, on an authority: add a machine to the fleet and
 * print the one line that sets it up there (`t3-fleet setup <repo> <name>`,
 * setup.ts).
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { loadConfig } from "@t3-fleet/core/Config";
import { git, out } from "@t3-fleet/core/Git";
import { addNode } from "@t3-fleet/core/Init";
import { underSyncLock } from "@t3-fleet/core/Sync";

import { reportUserErrors } from "./shared.ts";

const INSTALL_URL =
  "https://github.com/MartinPTielemans/fleetx/releases/latest/download/install.sh";

export const inviteCommand = Command.make("invite", {
  name: Argument.String("name").pipe(
    Argument.withDescription("The new machine's name in the fleet."),
  ),
  ssh: Flag.String("ssh").pipe(
    Flag.withDescription("Its ssh destination, when it differs from the name."),
    Flag.optional,
  ),
  profile: Flag.String("profile").pipe(
    Flag.withDescription("A profile it uses (repeatable)."),
    Flag.atLeast(0),
  ),
}).pipe(
  Command.withDescription(
    "Add a machine to the fleet and print the command to run on it (authority).",
  ),
  Command.withHandler(({ name, ssh, profile }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      if (!config.nodes.find((n) => n.name === config.self)?.roles.includes("authority")) {
        return yield* Effect.fail(`${config.self} is not an authority`);
      }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
        return yield* Effect.fail("names are lowercase letters, digits and dashes");
      const url = out(yield* git(config.repo, ["remote", "get-url", "origin"]));
      if (url === "")
        return yield* Effect.fail(
          "the config repo has no origin remote yet; push it to a private repository first",
        );
      const rev = yield* underSyncLock(
        addNode(config.repo, name, ssh._tag === "Some" ? ssh.value : null, profile),
      );
      yield* Console.log(
        `Added nodes/${name}.toml (${rev}). On ${name}, run:\n\n  curl -fsSL ${INSTALL_URL} | sh -s -- setup ${url} ${name}\n`,
      );
      yield* Console.log(
        "Setup there shows its plan before changing anything; this machine's next sync lets it read the secrets.",
      );
    }).pipe(reportUserErrors),
  ),
);
