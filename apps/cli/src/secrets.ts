/**
 * t3-fleet secrets: the fleet's encrypted dotenv file.
 *
 *   init                     create this node's key (once), print its public half
 *   install                  decrypt the repo's secrets onto this node
 *   list                     names only, never values
 *   set KEY=VALUE…           an authority changes secrets; re-encrypted, committed, pushed
 *   unset KEY…
 *   import FILE              replace every secret from a dotenv file
 *   add-node NODE RECIPIENT  let a node read the secrets (authority)
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Argument, Command } from "effect/unstable/cli";

import { loadConfig } from "@t3-fleet/core/Config";
import { commitAndPush } from "@t3-fleet/core/Git";
import {
  encryptedPath,
  ensureIdentity,
  installSecrets,
  readRecipients,
  readSecrets,
  recipientsPath,
  setVar,
  varNames,
  writeRecipients,
  writeSecrets,
} from "@t3-fleet/core/Secrets";

import { reportUserErrors } from "./shared.ts";

/** Changes the repo's secrets: refuses on a node without the authority role. */
const asAuthority = Effect.gen(function* () {
  const config = yield* loadConfig;
  const self = config.nodes.find((n) => n.name === config.self);
  if (!self?.roles.includes("authority")) {
    return yield* Effect.fail(`${config.self} is not an authority; change secrets on a node with the authority role`);
  }
  return config;
});

const commitSecrets = (repo: string, message: string) =>
  commitAndPush(repo, [encryptedPath(repo), recipientsPath(repo)].map((p) => p.slice(repo.length + 1)), message);

const init = Command.make("init").pipe(
  Command.withDescription("Create this node's key if it has none, and print its public half."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const { recipient, created } = yield* ensureIdentity;
      yield* Console.log(`${created ? "created" : "existing"} key; public: ${recipient}`);
    }).pipe(reportUserErrors),
  ),
);

const install = Command.make("install").pipe(
  Command.withDescription("Decrypt the repo's secrets into ~/.config/t3-fleet/secrets.env (mode 600)."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const count = yield* installSecrets(config.repo);
      yield* Console.log(`installed ${count} secret${count === 1 ? "" : "s"}`);
    }).pipe(reportUserErrors),
  ),
);

const list = Command.make("list").pipe(
  Command.withDescription("List secret names (never values)."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const names = varNames(yield* readSecrets(config.repo));
      yield* Console.log(names.length === 0 ? "no secrets" : names.join("\n"));
    }).pipe(reportUserErrors),
  ),
);

const set = Command.make("set", {
  pairs: Argument.String("KEY=VALUE").pipe(Argument.variadic({ min: 1 })),
}).pipe(
  Command.withDescription("Set secrets (authority). Re-encrypts for every node, commits and pushes."),
  Command.withHandler(({ pairs }) =>
    Effect.gen(function* () {
      const config = yield* asAuthority;
      let text = yield* readSecrets(config.repo);
      const keys: Array<string> = [];
      for (const pair of pairs) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/s.exec(pair);
        if (m?.[1] === undefined) return yield* Effect.fail(`not KEY=VALUE with an upper-case key: ${pair.split("=")[0]}`);
        text = setVar(text, m[1], m[2] ?? "");
        keys.push(m[1]);
      }
      yield* writeSecrets(config.repo, text);
      yield* installSecrets(config.repo);
      const rev = yield* commitSecrets(config.repo, `Set secret${keys.length === 1 ? "" : "s"} ${keys.join(", ")}`);
      yield* Console.log(`set ${keys.join(", ")} (${rev})`);
    }).pipe(reportUserErrors),
  ),
);

const unset = Command.make("unset", {
  keys: Argument.String("KEY").pipe(Argument.variadic({ min: 1 })),
}).pipe(
  Command.withDescription("Remove secrets (authority)."),
  Command.withHandler(({ keys }) =>
    Effect.gen(function* () {
      const config = yield* asAuthority;
      let text = yield* readSecrets(config.repo);
      for (const key of keys) text = setVar(text, key, null);
      yield* writeSecrets(config.repo, text);
      yield* installSecrets(config.repo);
      const rev = yield* commitSecrets(config.repo, `Remove secret${keys.length === 1 ? "" : "s"} ${keys.join(", ")}`);
      yield* Console.log(`removed ${keys.join(", ")} (${rev})`);
    }).pipe(reportUserErrors),
  ),
);

const importFile = Command.make("import", {
  file: Argument.String("FILE").pipe(Argument.withDescription("A dotenv file; its content replaces the secrets.")),
}).pipe(
  Command.withDescription("Replace every secret from a dotenv file (authority)."),
  Command.withHandler(({ file }) =>
    Effect.gen(function* () {
      const config = yield* asAuthority;
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(file).pipe(Effect.mapError(() => `cannot read ${file}`));
      const recipients = yield* readRecipients(config.repo);
      if (!Object.keys(recipients).includes(config.self)) {
        const { recipient } = yield* ensureIdentity;
        yield* writeRecipients(config.repo, { ...recipients, [config.self]: recipient });
      }
      yield* writeSecrets(config.repo, text);
      yield* installSecrets(config.repo);
      const names = varNames(text);
      const rev = yield* commitSecrets(config.repo, `Import ${names.length} secrets`);
      yield* Console.log(`imported ${names.length} secrets (${rev})`);
    }).pipe(reportUserErrors),
  ),
);

const addNode = Command.make("add-node", {
  node: Argument.String("NODE"),
  recipient: Argument.String("RECIPIENT").pipe(Argument.withDescription("The node's public key (age1…), from `t3-fleet secrets init` there.")),
}).pipe(
  Command.withDescription("Let a node read the secrets (authority): adds its key and re-encrypts."),
  Command.withHandler(({ node, recipient }) =>
    Effect.gen(function* () {
      const config = yield* asAuthority;
      if (!config.nodes.some((n) => n.name === node)) return yield* Effect.fail(`unknown machine: ${node}`);
      if (!/^age1[0-9a-z]+$/.test(recipient)) return yield* Effect.fail("not an age public key (age1…)");
      const text = yield* readSecrets(config.repo);
      const recipients = yield* readRecipients(config.repo);
      yield* writeRecipients(config.repo, { ...recipients, [node]: recipient });
      yield* writeSecrets(config.repo, text);
      const rev = yield* commitSecrets(config.repo, `Let ${node} read the fleet's secrets`);
      yield* Console.log(`${node} can read the secrets after its next pull (${rev})`);
    }).pipe(reportUserErrors),
  ),
);

export const secretsCommand = Command.make("secrets").pipe(
  Command.withDescription("The fleet's encrypted secrets."),
  Command.withSubcommands([init, install, list, set, unset, importFile, addNode]),
);
