/**
 * Every name T3 Fleet leaves on a machine, in one place, with the fleetx
 * name it replaced. Until 1.0 the old names are still read, so a machine
 * keeps working from before its migration until after it:
 *
 *   ~/.config/t3-fleet        was ~/.config/fleetx        (settings, keys, secrets)
 *   ~/.local/state/t3-fleet   was ~/.local/state/fleetx   (logs, locks, the hub's state)
 *   ~/.local/share/t3-fleet   was ~/.local/share/fleetx   (the bundle)
 *   ~/.local/bin/t3-fleet     and ~/.local/bin/fleetx, an alias until 1.0
 *   dev.t3-fleet.<role>       was dev.fleetx.<role>       (launchd)
 *   t3-fleet-<role>           was fleetx-<role>           (systemd units)
 *   t3-fleet-<instance>       was fleetx-<instance>       (model launchers)
 *   t3-fleet-mcp-<server>     was fleetx-mcp-<server>     (hub containers)
 *   x-t3-fleet-<name>         was x-fleetx-<name>         (headers between machines)
 *
 * A data directory is the old one for as long as that is a real directory,
 * then the new one: the engine area's migration moves it and leaves a link
 * behind, so both names reach the same place from then on. Whatever is
 * written to the new name before that is merged in by the migration.
 *
 * The config repo's own names are shared by every machine and move together,
 * in one authority fix (`t3-fleet repo rename`), once every machine runs a
 * build that reads both (see repoRenamed below):
 *
 *   t3-fleet.toml                     was fleetx.toml
 *   t3-fleet/{state,staging,rejected}/<node>   were fleetx/…   (branches)
 *   T3_FLEET_RELAY_TOKEN, T3_FLEET_MCP_TOKEN_*  were FLEETX_…   (secrets)
 */
// Resolving a directory has to be synchronous: paths are built in plain
// functions all over, and this is a cheap, read-only check.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, lstatSync } from "node:fs";

export const PRODUCT = "T3 Fleet";
export const CLI = "t3-fleet";
export const LEGACY_CLI = "fleetx";

const isRealDir = (path: string) => {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

const dataDir = (home: string, now: string, was: string) =>
  isRealDir(`${home}/${was}`) ? `${home}/${was}` : `${home}/${now}`;

export const CONFIG_DIR = ".config/t3-fleet";
export const LEGACY_CONFIG_DIR = ".config/fleetx";
export const STATE_DIR = ".local/state/t3-fleet";
export const LEGACY_STATE_DIR = ".local/state/fleetx";
export const SHARE_DIR = ".local/share/t3-fleet";
export const LEGACY_SHARE_DIR = ".local/share/fleetx";

/** ~/.config/t3-fleet, or ~/.config/fleetx on a machine not migrated yet. */
export const configDir = (home: string) => dataDir(home, CONFIG_DIR, LEGACY_CONFIG_DIR);
/** ~/.local/state/t3-fleet, or ~/.local/state/fleetx on a machine not migrated yet. */
export const stateDir = (home: string) => dataDir(home, STATE_DIR, LEGACY_STATE_DIR);

/** The same choice in shell, for commands and scripts that run on the machine itself. */
const shDataDir = (now: string, was: string) =>
  `$( [ -d "$HOME/${was}" ] && [ ! -L "$HOME/${was}" ] && echo "$HOME/${was}" || echo "$HOME/${now}" )`;
export const SH_CONFIG_DIR = shDataDir(CONFIG_DIR, LEGACY_CONFIG_DIR);
export const SH_STATE_DIR = shDataDir(STATE_DIR, LEGACY_STATE_DIR);

export const BUNDLE_FILE = "t3-fleet.mjs";
export const LEGACY_BUNDLE_FILE = "fleetx.mjs";

/** launchd label and systemd unit name for one of T3 Fleet's services or timers ("sync", "serve", "listen", "models"). */
export const launchdLabel = (role: string) => `dev.t3-fleet.${role}`;
export const systemdUnit = (role: string) => `t3-fleet-${role}`;
export const legacyLaunchdLabel = (role: string) => `dev.fleetx.${role}`;
export const legacySystemdUnit = (role: string) => `fleetx-${role}`;

export const LAUNCHER_PREFIX = "t3-fleet-";
export const LEGACY_LAUNCHER_PREFIX = "fleetx-";
/** Whether a binary is one of the models area's launchers, under either name. */
export const isLauncher = (file: string) =>
  file.startsWith(LAUNCHER_PREFIX) || file.startsWith(LEGACY_LAUNCHER_PREFIX);

export const CONTAINER_PREFIX = "t3-fleet-mcp-";
export const LEGACY_CONTAINER_PREFIX = "fleetx-mcp-";
export const CONTAINER_LABEL = "dev.t3-fleet";
export const LEGACY_CONTAINER_LABEL = "dev.fleetx";

/** A header one machine sends another; the old name is accepted, and sent too, until 1.0. */
export const header = (name: string) => `x-t3-fleet-${name}`;
export const legacyHeader = (name: string) => `x-fleetx-${name}`;
/** A header's value under its name, or else its old name. */
export const readHeader = (headers: Readonly<Record<string, string | undefined>>, name: string) =>
  headers[header(name)] ?? headers[legacyHeader(name)];

export const FLEET_FILE = "t3-fleet.toml";
export const LEGACY_FLEET_FILE = "fleetx.toml";

/**
 * Whether a config repo has its T3 Fleet names: it holds t3-fleet.toml.
 * Writers use the names the repo has; readers take both until 1.0, for a
 * machine that has not pulled the rename yet.
 */
export const repoRenamed = (repo: string) => existsSync(`${repo}/${FLEET_FILE}`);

export type BranchKind = "state" | "staging" | "rejected";
/** The prefix this repo's branches of one kind are written under: "t3-fleet/state/". */
export const branchPrefix = (repo: string, kind: BranchKind) =>
  `${repoRenamed(repo) ? "t3-fleet" : "fleetx"}/${kind}/`;
/** Every prefix branches of one kind are read from, the current one first. Until 1.0. */
export const branchPrefixes = (kind: BranchKind) =>
  [`t3-fleet/${kind}/`, `fleetx/${kind}/`] as const;

export const SECRET_PREFIX = "T3_FLEET_";
export const LEGACY_SECRET_PREFIX = "FLEETX_";
/** A fleet secret's name in this repo: T3_FLEET_RELAY_TOKEN, or FLEETX_RELAY_TOKEN before the rename. */
export const secretName = (repo: string, name: string) =>
  `${repoRenamed(repo) ? SECRET_PREFIX : LEGACY_SECRET_PREFIX}${name}`;
/** The fleetx name of a T3_FLEET_ secret, read when the new one is not set; null for any other name. Until 1.0. */
export const legacySecretName = (name: string) =>
  name.startsWith(SECRET_PREFIX)
    ? `${LEGACY_SECRET_PREFIX}${name.slice(SECRET_PREFIX.length)}`
    : null;
