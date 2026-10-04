/**
 * Renaming a config repo from fleetx's names to T3 Fleet's (Names.ts), on an
 * authority, once every machine runs a build that reads both:
 *
 *   fleetx.toml           moved to t3-fleet.toml
 *   FLEETX_* secrets      also kept as T3_FLEET_*, same value
 *   fleetx/{state,staging,rejected}/<node>   moved to t3-fleet/…
 *
 * The FLEETX_ secrets stay, and so do the settings' `token_env` names that
 * point at them: Codex reads those variables from T3's environment, fixed
 * when T3 started, so renaming them would cut running sessions off. They
 * move at 1.0, together with a T3 restart.
 *
 * Each step is skipped when already done, so it can run again after a
 * failure. A machine that pulls later still publishes under the old names
 * once; readers take both, and its next sync moves it over.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { ensureGitConfig, git, ok, out, why } from "./Git.ts";
import { FLEET_FILE, LEGACY_FLEET_FILE, LEGACY_SECRET_PREFIX, repoRenamed, SECRET_PREFIX } from "./Names.ts";
import { encryptedPath, installSecrets, readSecrets, writeSecrets } from "./Secrets.ts";

/** Every FLEETX_ secret also under its T3_FLEET_ name, with the same value; the names added. */
export const addRenamedSecrets = (text: string) => {
  const lines = text.split("\n");
  const has = new Set(lines.map((l) => /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=/.exec(l)?.[1]).filter((k) => k !== undefined));
  const added: Array<string> = [];
  for (const line of [...lines]) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${LEGACY_SECRET_PREFIX}([A-Z0-9_]+)=(.*)$`).exec(line);
    if (m === null) continue;
    const name = `${SECRET_PREFIX}${m[1]}`;
    if (has.has(name)) continue;
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(`${name}=${m[2]}`, "");
    has.add(name);
    added.push(name);
  }
  return { text: lines.join("\n"), added };
};

const BRANCH = /^refs\/heads\/fleetx\/(state|staging|rejected)\/(.+)$/;

/** Rename the repo on `branch`; what was done, one line each. */
export const renameRepo = (repo: string, branch: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* ensureGitConfig;
    // Other local edits are fine: they are set aside for the pull and never committed.
    const touched = [LEGACY_FLEET_FILE, FLEET_FILE, encryptedPath(repo).slice(repo.length + 1)];
    if (out(yield* git(repo, ["status", "--porcelain", "--", ...touched])) !== "") {
      return yield* Effect.fail(`${repo} has uncommitted changes to ${touched.join(" or ")}; commit or stash them first`);
    }
    const pull = yield* git(repo, ["pull", "-q", "--rebase", "--autostash", "origin", branch]);
    if (!ok(pull)) return yield* Effect.fail(`pull failed: ${why(pull)}`);
    const done: Array<string> = [];

    if (!repoRenamed(repo)) {
      const mv = yield* git(repo, ["mv", LEGACY_FLEET_FILE, FLEET_FILE]);
      if (!ok(mv)) return yield* Effect.fail(`moving ${LEGACY_FLEET_FILE}: ${why(mv)}`);
      done.push(`${LEGACY_FLEET_FILE} → ${FLEET_FILE}`);
    }

    if (yield* fs.exists(encryptedPath(repo)).pipe(Effect.orElseSucceed(() => false))) {
      const { text, added } = addRenamedSecrets(yield* readSecrets(repo));
      if (added.length > 0) {
        yield* writeSecrets(repo, text);
        yield* installSecrets(repo);
        yield* git(repo, ["add", "--", encryptedPath(repo).slice(repo.length + 1)]);
        done.push(`secrets added: ${added.join(", ")} (the ${LEGACY_SECRET_PREFIX} names stay until 1.0)`);
      }
    }

    if ((yield* git(repo, ["diff", "--cached", "--quiet"])).code !== 0) {
      const commit = yield* git(repo, ["commit", "-q", "-m", "Rename the config repo's names to T3 Fleet's\n\nt3-fleet.toml, and every FLEETX_ secret also as T3_FLEET_."]);
      if (!ok(commit)) return yield* Effect.fail(`commit failed: ${why(commit)}`);
      const push = yield* git(repo, ["push", "-q", "origin", `HEAD:${branch}`]);
      if (!ok(push)) return yield* Effect.fail(`committed, but the push failed: ${why(push)}`);
      done.push(`committed and pushed ${out(yield* git(repo, ["rev-parse", "--short", "HEAD"]))}`);
    }

    const remote = out(yield* git(repo, ["ls-remote", "origin", "refs/heads/fleetx/*", "refs/heads/t3-fleet/*"]))
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(/\s+/) as [string, string]);
    const present = new Set(remote.map(([, ref]) => ref));
    const specs: Array<string> = [];
    for (const [sha, ref] of remote) {
      const m = BRANCH.exec(ref);
      if (m === null) continue;
      const target = `refs/heads/t3-fleet/${m[1]}/${m[2]}`;
      // A branch already under the new name was written after the rename, so it is the newer one.
      if (!present.has(target)) specs.push(`${sha}:${target}`);
      specs.push(`:${ref}`);
      done.push(`${ref.slice("refs/heads/".length)} → ${target.slice("refs/heads/".length)}`);
    }
    if (specs.length > 0) {
      const fetch = yield* git(repo, ["fetch", "-q", "origin", "+refs/heads/fleetx/*:refs/remotes/origin/fleetx/*"]);
      if (!ok(fetch)) return yield* Effect.fail(`fetching the fleetx/ branches: ${why(fetch)}`);
      const push = yield* git(repo, ["push", "-q", "--force", "origin", ...specs]);
      if (!ok(push)) return yield* Effect.fail(`moving the branches: ${why(push)}`);
    }
    return done;
  });
