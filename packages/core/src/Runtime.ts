/**
 * The fixed runtime services and timers run with: an absolute node binary
 * and bundle, chosen once, never a login shell's PATH.
 *
 * The node is the first of these that runs Node 24 or newer: package
 * manager paths that survive upgrades (/opt/homebrew/bin, /usr/local/bin,
 * /usr/bin, a Nix profile), then the node running this probe. A version
 * manager's versioned directory is the last resort, because an upgrade
 * deletes it out from under the unit.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { exec } from "./Exec.ts";

export const MIN_NODE_MAJOR = 24;

export const stableNode = (home: string) =>
  Effect.gen(function* () {
    const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", `${home}/.nix-profile/bin/node`, "/run/current-system/sw/bin/node"];
    for (const candidate of candidates) {
      const version = yield* exec({ command: candidate, args: ["-p", "process.versions.node"], timeout: Duration.seconds(5) });
      if (version.code === 0 && Number(version.stdout.trim().split(".")[0]) >= MIN_NODE_MAJOR) return candidate;
    }
    return process.execPath;
  });

/** The bundle ~/.local/bin/fleetx resolves to (a development build, or the installed copy). */
export const installedBundle = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.realPath(`${home}/.local/bin/fleetx`).pipe(Effect.orElseSucceed(() => `${home}/.local/share/fleetx/fleetx.mjs`));
  });
