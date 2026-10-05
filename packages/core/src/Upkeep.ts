/**
 * How the fleet looks after its machines without anyone asking: which areas'
 * safe fixes sync applies by itself ([fleet] apply), and where alerts go
 * ([notify]). Plain data, so the setup wizard in the browser and the engine
 * say the same thing.
 *
 *   [fleet]
 *   apply = [...]                  areas whose safe fixes sync applies unattended
 *
 *   [notify]
 *   desktop = ["<node>"]           nodes that show an OS notification for every fleet alert
 *   ntfy = "T3_FLEET_NTFY_URL"     name of a secret holding the ntfy topic URL; omitted = no push
 */

/** Areas that keep a machine the fleet's: always applied by sync, whatever setup was told. */
export const KEEP_AREAS = ["engine", "secrets", "dotfiles", "instructions", "mcp"] as const;

/** Areas that bring new versions and new skills: "keep things up to date automatically". */
export const UPDATE_AREAS = ["t3", "agents", "skills"] as const;

/** What sync applies when `[fleet] apply` is not set. */
export const DEFAULT_APPLY: ReadonlyArray<string> = [...KEEP_AREAS, ...UPDATE_AREAS];

/** `[fleet] apply` with updates on or off. */
export const applyAreas = (autoUpdate: boolean): ReadonlyArray<string> =>
  autoUpdate ? DEFAULT_APPLY : KEEP_AREAS;

/** UPDATE_AREAS in plain words, in order. T3 updates only while no thread runs ([t3] update = "when-idle"). */
export const UPDATE_WORDS = [
  "T3 Code, when no thread is running",
  "Claude Code and Codex",
  "skills",
];

/**
 * What setup takes when not told, in the wizard and the terminal alike:
 * updates on, a notification on this computer, no push to a phone, MCP
 * servers left where they run.
 */
export const UPKEEP_DEFAULTS = {
  autoUpdate: true,
  desktop: true,
  ntfy: false,
  mcpHub: false,
} as const;

/** The secret holding the ntfy topic URL; `[notify] ntfy` names it. */
export const NTFY_SECRET = "T3_FLEET_NTFY_URL";

const NTFY_TOPIC = /^https:\/\/ntfy\.sh\/[a-z0-9]{24,64}$/;

/** A new ntfy.sh topic nobody can guess: 128 random bits, base 36. */
export const newNtfyUrl = () => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const n = bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  return `https://ntfy.sh/t3fleet${n.toString(36).padStart(25, "0")}`;
};

/** Whether a URL is a topic setup would make: ntfy.sh, and long and random enough not to be guessed. */
export const isNtfyUrl = (url: string) => NTFY_TOPIC.test(url);
