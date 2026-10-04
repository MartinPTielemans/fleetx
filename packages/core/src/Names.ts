/**
 * Every name T3 Fleet leaves on a machine, in one place:
 *
 *   ~/.config/t3-fleet        settings, keys, secrets
 *   ~/.local/state/t3-fleet   logs, locks, the hub's state
 *   ~/.local/share/t3-fleet   the bundle
 *   ~/.local/bin/t3-fleet     the command
 *   dev.t3-fleet.<role>       launchd labels
 *   t3-fleet-<role>           systemd units
 *   t3-fleet-<instance>       model launchers
 *   t3-fleet-mcp-<server>     hub containers
 *   x-t3-fleet-<name>         headers between machines
 *
 * And in the config repo, shared by every machine:
 *
 *   t3-fleet.toml
 *   t3-fleet/{state,staging,rejected}/<node>    branches
 *   T3_FLEET_RELAY_TOKEN, T3_FLEET_MCP_TOKEN_*  secrets
 */
export const PRODUCT = "T3 Fleet";
export const CLI = "t3-fleet";

export const CONFIG_DIR = ".config/t3-fleet";
export const STATE_DIR = ".local/state/t3-fleet";
export const SHARE_DIR = ".local/share/t3-fleet";

/** ~/.config/t3-fleet */
export const configDir = (home: string) => `${home}/${CONFIG_DIR}`;
/** ~/.local/state/t3-fleet */
export const stateDir = (home: string) => `${home}/${STATE_DIR}`;

/** The same, in shell, for commands and scripts that run on the machine itself. */
export const SH_CONFIG_DIR = `$HOME/${CONFIG_DIR}`;
export const SH_STATE_DIR = `$HOME/${STATE_DIR}`;

export const BUNDLE_FILE = "t3-fleet.mjs";

/** launchd label and systemd unit name for one of T3 Fleet's services or timers ("sync", "serve", "listen", "models"). */
export const launchdLabel = (role: string) => `dev.t3-fleet.${role}`;
export const systemdUnit = (role: string) => `t3-fleet-${role}`;

export const LAUNCHER_PREFIX = "t3-fleet-";
/** Whether a binary is one of the models area's launchers. */
export const isLauncher = (file: string) => file.startsWith(LAUNCHER_PREFIX);

export const CONTAINER_PREFIX = "t3-fleet-mcp-";
export const CONTAINER_LABEL = "dev.t3-fleet";

/** A header one machine sends another. */
export const header = (name: string) => `x-t3-fleet-${name}`;

export const FLEET_FILE = "t3-fleet.toml";

export type BranchKind = "state" | "staging" | "rejected";
/** The prefix branches of one kind are written and read under: "t3-fleet/state/". */
export const branchPrefix = (kind: BranchKind) => `t3-fleet/${kind}/`;

export const SECRET_PREFIX = "T3_FLEET_";
/** A fleet secret's name: T3_FLEET_RELAY_TOKEN. */
export const secretName = (name: string) => `${SECRET_PREFIX}${name}`;
