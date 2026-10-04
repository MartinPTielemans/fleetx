/**
 * Secrets a member proposes with its setup: `secrets-proposed/<node>.env.age`,
 * encrypted to every node that can read the fleet's secrets and to itself.
 * When an authority approves the proposal, they are merged into the fleet's
 * (Staging.approve), one file at a time:
 *
 *   - only names the fleet's definitions and settings refer to, after the
 *     approval: the secrets file is loaded into the environment of fixes, so
 *     a name nothing uses has no business there;
 *   - never a name that changes how programs run (PATH, NODE_OPTIONS,
 *     LD_PRELOAD, …);
 *   - never a different value for a name the fleet has: that is reported,
 *     and the fleet's value stays;
 *   - a file this machine cannot decrypt is left for an authority that can.
 *
 * `describeProposed` shows the same before approving.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { parse as parseToml } from "smol-toml";

import { commitAndPush, git, ok } from "./Git.ts";
import { FLEET_FILE } from "./Names.ts";
import {
  decryptWith,
  ensureIdentity,
  installSecrets,
  readSecrets,
  setVar,
  writeSecrets,
} from "./Secrets.ts";
import { secretRefs, UNSAFE_NAME } from "./setup/Credentials.ts";
import { PROPOSED_SECRETS } from "./setup/Plan.ts";

/** NAME=value lines, values unquoted as Secrets.setVar quotes them. */
export const parseDotenv = (text: string) => {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m?.[1] === undefined) continue;
    const raw = m[2] ?? "";
    out.set(m[1], /^".*"$/.test(raw) ? raw.slice(1, -1).replace(/\\(["\\$`])/g, "$1") : raw);
  }
  return out;
};

/** Every secret name the fleet's definitions and settings refer to. */
export const referencedNames = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const list = (dir: string) =>
      fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as Array<string>));
    const read = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    const names = new Set<string>();
    for (const file of (yield* list(`${repo}/mcp`)).filter((f) => f.endsWith(".json"))) {
      const text = yield* read(`${repo}/mcp/${file}`);
      for (const n of secretRefs(text.replace(/\\"/g, '"'))) names.add(n);
      for (const m of text.matchAll(
        /"(?:token_env|client_secret_env)"\s*:\s*"([A-Z_][A-Z0-9_]*)"/g,
      ))
        names.add(m[1] ?? "");
    }
    const tomls = [
      `${repo}/${FLEET_FILE}`,
      ...(yield* list(`${repo}/nodes`)).map((f) => `${repo}/nodes/${f}`),
      ...(yield* list(`${repo}/profiles`)).map((f) => `${repo}/profiles/${f}`),
    ].filter((f) => f.endsWith(".toml"));
    for (const file of tomls) {
      const text = yield* read(file);
      for (const m of text.matchAll(/token_env\s*=\s*"([A-Z_][A-Z0-9_]*)"/g)) names.add(m[1] ?? "");
      const parsed = yield* Effect.try(() => parseToml(text) as Record<string, unknown>).pipe(
        Effect.orElseSucceed(() => ({}) as Record<string, unknown>),
      );
      const defaults = (parsed["defaults"] ?? {}) as Record<string, unknown>;
      if (parsed["relay"] !== undefined) names.add("T3_FLEET_RELAY_TOKEN");
      if (parsed["models"] !== undefined || defaults["models"] !== undefined)
        names.add("CLAUDE_CODE_OAUTH_TOKEN");
    }
    return names;
  });

/** What merging `values` into `fleet` would do with each name. */
export const sortProposed = (
  values: ReadonlyMap<string, string>,
  fleet: ReadonlyMap<string, string>,
  referenced: ReadonlySet<string>,
) => {
  const take: Array<string> = [];
  const refused: Array<string> = [];
  for (const [name, value] of values) {
    if (UNSAFE_NAME.test(name)) refused.push(`${name} (it would change how programs run)`);
    else if (value.includes("\n")) refused.push(`${name} (a value over several lines)`);
    else if (!referenced.has(name)) refused.push(`${name} (nothing in the fleet uses it)`);
    else if (fleet.has(name) && fleet.get(name) !== value)
      refused.push(`${name} (the fleet has another value; set it by hand to change it)`);
    else if (!fleet.has(name)) take.push(name);
  }
  return { take, refused };
};

/** Merge the proposed secrets `files` (paths in the repo; all of them when empty). What it did, a line each. */
export const mergeProposedSecrets = (repo: string, files: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = `${repo}/${PROPOSED_SECRETS}`;
    const present = (yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
      .filter((f) => f.endsWith(".env.age"))
      .map((f) => `${PROPOSED_SECRETS}/${f}`)
      .filter((f) => files.length === 0 || files.includes(f));
    if (present.length === 0) return [] as Array<string>;
    const { identity } = yield* ensureIdentity;
    let text = yield* readSecrets(repo);
    const referenced = yield* referencedNames(repo);
    const lines: Array<string> = [];
    const merged: Array<string> = [];
    for (const file of present) {
      const node = file.slice(PROPOSED_SECRETS.length + 1, -".env.age".length);
      const plain = yield* fs.readFileString(`${repo}/${file}`).pipe(
        Effect.flatMap((armored) => decryptWith(identity, armored)),
        Effect.option,
      );
      if (plain._tag === "None") {
        lines.push(
          `could not decrypt ${file} with this machine's key; it is left for an authority that can`,
        );
        continue;
      }
      const { take, refused } = sortProposed(
        parseDotenv(plain.value),
        parseDotenv(text),
        referenced,
      );
      const values = parseDotenv(plain.value);
      for (const name of take) text = setVar(text, name, values.get(name) ?? "");
      merged.push(file);
      lines.push(
        `${node}'s secrets: ${take.length > 0 ? `merged ${take.join(", ")}` : "none merged"}${refused.length > 0 ? `; refused ${refused.join(", ")}` : ""}`,
      );
    }
    if (merged.length === 0) return lines;
    yield* writeSecrets(repo, text);
    yield* installSecrets(repo);
    // The merge is committed first: until it is, every proposal stays, and a retry (the
    // authority's next sync) finds them. Merging again takes nothing twice.
    const rev = yield* commitAndPush(
      repo,
      ["secrets"],
      `Merge proposed secrets\n\n${lines.join("\n")}`,
    );
    for (const file of merged) yield* fs.remove(`${repo}/${file}`);
    const dropped = yield* commitAndPush(
      repo,
      ["secrets", ...merged],
      `Drop the merged proposed secrets\n\n${merged.join("\n")}`,
    );
    return [...lines, `committed ${rev}`, `removed ${merged.join(", ")} (${dropped})`];
  });

/** Before approving: the names a proposal's secrets file holds, and what merging would do with each. */
export const describeProposed = (repo: string, commit: string, node: string) =>
  Effect.gen(function* () {
    const file = `${PROPOSED_SECRETS}/${node}.env.age`;
    const show = yield* git(repo, ["show", `${commit}:${file}`]);
    if (!ok(show)) return [] as Array<string>;
    const { identity } = yield* ensureIdentity;
    const plain = yield* decryptWith(identity, show.stdout).pipe(Effect.option);
    if (plain._tag === "None") return [`${file}: not encrypted to this machine's key`];
    const values = parseDotenv(plain.value);
    const fleet = parseDotenv(yield* readSecrets(repo).pipe(Effect.orElseSucceed(() => "")));
    // What the fleet's definitions will refer to once the proposal is in: its own mcp/ files too.
    const referenced = new Set(yield* referencedNames(repo));
    const changed = yield* git(repo, ["diff", "--name-only", `${commit}^`, commit, "--", "mcp"]);
    for (const f of changed.stdout.split("\n").filter(Boolean)) {
      const text = yield* git(repo, ["show", `${commit}:${f}`]);
      for (const n of secretRefs(text.stdout)) referenced.add(n);
      for (const m of text.stdout.matchAll(/"token_env"\s*:\s*"([A-Z_][A-Z0-9_]*)"/g))
        referenced.add(m[1] ?? "");
    }
    for (const f of ["t3-fleet.toml", `nodes/${node}.toml`]) {
      const text = yield* git(repo, ["show", `${commit}:${f}`]);
      if (/^\[relay\]/m.test(text.stdout)) referenced.add("T3_FLEET_RELAY_TOKEN");
      if (/^\[(defaults\.)?models\]/m.test(text.stdout)) referenced.add("CLAUDE_CODE_OAUTH_TOKEN");
    }
    const { take, refused } = sortProposed(values, fleet, referenced);
    return [
      `secrets it proposes: ${[...values.keys()].join(", ") || "none"}`,
      ...(take.length > 0 ? [`  would merge ${take.join(", ")}`] : []),
      ...(refused.length > 0 ? [`  would refuse ${refused.join(", ")}`] : []),
    ];
  });
