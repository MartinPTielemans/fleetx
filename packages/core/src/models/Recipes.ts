/**
 * What [models] says, resolved: the upstreams the proxy forwards to, and per
 * T3 provider instance the recipe its launcher follows.
 *
 *   [models.upstreams.<name>]       the proxy serves /<name>/* → url
 *   url = "https://…"
 *   chatgpt_url = "https://…"       optional: where requests made with a
 *                                   ChatGPT login go instead (Codex)
 *
 *   [models.providers.<instanceId>]
 *   upstream = "<name>"             which upstream it uses
 *   env = { X_BASE_URL = "{proxy}" }  variables the launcher sets; {proxy} is
 *                                   http://127.0.0.1:8398/<upstream>
 *   args = ["--flag", "{proxy}"]    arguments the launcher puts first
 *   command = "grok"                the CLI to run (default: the driver's)
 *   token_env = "SOME_TOKEN"        a long-lived credential the launcher
 *                                   loads from the fleet's secrets
 *   route = false                   leave this instance alone
 *
 * Two upstreams and two recipes are built in, so routing Claude and Codex
 * needs nothing but `[models]`:
 *
 *   anthropic   https://api.anthropic.com
 *   openai      https://api.openai.com/v1, or chatgpt.com/backend-api/codex
 *               for a ChatGPT login
 *   claudeAgent ANTHROPIC_BASE_URL={proxy}; token_env CLAUDE_CODE_OAUTH_TOKEN
 *               (a `claude setup-token` token, which does not rotate)
 *   codex       -c openai_base_url="{proxy}", which keeps Codex's built-in
 *               provider and its login
 *
 * Any other driver whose CLI takes its base URL from a variable or a flag is
 * routed by declaring env or args. Drivers without a CLI (SDK providers) or
 * without a recipe are reported, never guessed at.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { T3_DRIVERS } from "../T3Settings.ts";
import { LAUNCHER_PREFIX, LEGACY_LAUNCHER_PREFIX } from "../Names.ts";

export const MODELS_PORT = 8398;

const UpstreamSettings = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  chatgpt_url: Schema.optionalKey(Schema.String),
});

const ProviderSettings = Schema.Struct({
  upstream: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  command: Schema.optionalKey(Schema.String),
  token_env: Schema.optionalKey(Schema.String),
  route: Schema.optionalKey(Schema.Boolean),
});

export const ModelsSettings = Schema.Struct({
  egress: Schema.optionalKey(Schema.Literals(["direct", "relay"])),
  upstreams: Schema.optionalKey(Schema.Record(Schema.String, UpstreamSettings)),
  providers: Schema.optionalKey(Schema.Record(Schema.String, ProviderSettings)),
});
export type ModelsSettings = typeof ModelsSettings.Type;

export const decodeModelsSettings = (raw: unknown): ModelsSettings =>
  Option.getOrElse(Schema.decodeUnknownOption(ModelsSettings)(raw ?? {}), () => ({}));

/**
 * `record[key]` when the record itself has it, never what it inherits: a
 * path like /constructor/… must not find Object.prototype.constructor.
 */
export const own = <V>(record: Readonly<Record<string, V>> | undefined, key: string): V | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

// ---- upstreams ----------------------------------------------------------------

export interface UpstreamDef {
  readonly url: string;
  /** Where requests made with a ChatGPT login go instead; see Forward.ts. */
  readonly chatgptUrl?: string | undefined;
}
export type Upstreams = Readonly<Record<string, UpstreamDef>>;

export const BUILTIN_UPSTREAMS: Upstreams = {
  anthropic: { url: "https://api.anthropic.com" },
  openai: { url: "https://api.openai.com/v1", chatgptUrl: "https://chatgpt.com/backend-api/codex" },
};

/** Paths the proxy serves itself, which no upstream may be named. */
const RESERVED = new Set(["health", "stats", "egress"]);
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The built-ins, overlaid field by field with what the settings declare; unusable names are dropped. */
export const upstreamsOf = (settings: ModelsSettings): Upstreams => {
  const out: Record<string, UpstreamDef> = { ...BUILTIN_UPSTREAMS };
  for (const [name, declared] of Object.entries(settings.upstreams ?? {})) {
    if (!NAME.test(name) || RESERVED.has(name)) continue;
    const base = own(out, name);
    const url = (declared.url ?? base?.url ?? "").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) continue;
    const chatgpt = declared.chatgpt_url ?? base?.chatgptUrl;
    out[name] = { url, ...(chatgpt === undefined ? {} : { chatgptUrl: chatgpt.replace(/\/+$/, "") }) };
  }
  return out;
};

export const proxyUrl = (upstream: string, port: number = MODELS_PORT) => `http://127.0.0.1:${port}/${upstream}`;

/** Every base URL these upstreams forward to: what a relay's /egress route may send to. */
export const upstreamBases = (upstreams: Upstreams): ReadonlyArray<string> =>
  Object.values(upstreams).flatMap((u) => (u.chatgptUrl === undefined ? [u.url] : [u.url, u.chatgptUrl]));

// ---- recipes ------------------------------------------------------------------

export interface Recipe {
  readonly upstream: string;
  readonly env: Readonly<Record<string, string>>;
  readonly args: ReadonlyArray<string>;
  /** The CLI: "~/.local/bin/claude", or a name looked up on PATH. */
  readonly command: string;
  /** First arguments that make no model call and run the CLI directly (version, login). */
  readonly direct: ReadonlyArray<string>;
  readonly tokenEnv: string | null;
  /** How a person gets that credential. */
  readonly tokenHelp: string;
}

export const BUILTIN_RECIPES: Readonly<Record<string, Recipe>> = {
  claudeAgent: {
    upstream: "anthropic",
    env: { ANTHROPIC_BASE_URL: "{proxy}" },
    args: [],
    command: "~/.local/bin/claude",
    direct: ["-v", "--version", "auth", "setup-token", "update", "doctor"],
    tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    tokenHelp: "run `claude setup-token` once; the token it prints does not rotate, so concurrent sessions cannot log each other out",
  },
  codex: {
    upstream: "openai",
    env: {},
    args: ["-c", 'openai_base_url="{proxy}"'],
    command: "~/.local/bin/codex",
    direct: ["-V", "--version", "login", "logout"],
    tokenEnv: null,
    tokenHelp: "",
  },
};

const DEFAULT_DIRECT = ["-v", "-V", "--version", "login", "logout", "auth"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export type Resolved =
  | { readonly _tag: "route"; readonly recipe: Recipe }
  | { readonly _tag: "skip" }
  | { readonly _tag: "unroutable"; readonly reason: string };

/** The recipe for one T3 instance: the driver's built-in one overlaid with what the settings declare. */
export const resolveRecipe = (instanceId: string, driver: string, settings: ModelsSettings, upstreams: Upstreams): Resolved => {
  const declared = own(settings.providers, instanceId);
  if (declared?.route === false) return { _tag: "skip" };
  // Everything here ends up in a shell script written through a heredoc; one line each, or none at all.
  const fields = [instanceId, driver, declared?.upstream, declared?.command, declared?.token_env, ...Object.entries(declared?.env ?? {}).flat(), ...(declared?.args ?? [])];
  if (fields.some((f) => f !== undefined && CONTROL.test(f))) {
    return { _tag: "unroutable", reason: `the recipe for ${JSON.stringify(instanceId)} has a newline or control character in it, so no launcher is written` };
  }
  const builtin = own(BUILTIN_RECIPES, driver);
  const bin = own(T3_DRIVERS, driver)?.bin;
  const env = { ...builtin?.env, ...declared?.env };
  const args = declared?.args ?? builtin?.args ?? [];
  if (builtin === undefined && Object.keys(env).length === 0 && args.length === 0) {
    return {
      _tag: "unroutable",
      reason:
        bin === null
          ? `${driver} runs inside T3 (an SDK provider), with no CLI to point at the proxy`
          : `T3 Fleet has no recipe for ${driver}; declare [models.providers.${instanceId}] env or args if its CLI takes a base URL`,
    };
  }
  const command = declared?.command ?? builtin?.command ?? bin ?? null;
  if (command === null) return { _tag: "unroutable", reason: `${driver} has no CLI; set [models.providers.${instanceId}] command` };
  const upstream = declared?.upstream ?? builtin?.upstream ?? "";
  if (own(upstreams, upstream) === undefined) {
    return { _tag: "unroutable", reason: upstream === "" ? `set [models.providers.${instanceId}] upstream` : `no upstream named ${upstream} in [models.upstreams]` };
  }
  const badEnv = Object.keys(env).find((k) => !ENV_NAME.test(k));
  if (badEnv !== undefined) return { _tag: "unroutable", reason: `${badEnv} is not a variable name` };
  const tokenEnv = declared?.token_env ?? builtin?.tokenEnv ?? null;
  if (tokenEnv !== null && !ENV_NAME.test(tokenEnv)) return { _tag: "unroutable", reason: `token_env ${tokenEnv} is not a variable name` };
  return {
    _tag: "route",
    recipe: {
      upstream,
      env,
      args,
      command,
      direct: builtin?.direct ?? DEFAULT_DIRECT,
      tokenEnv,
      tokenHelp:
        builtin?.tokenEnv === tokenEnv && builtin?.tokenHelp
          ? builtin.tokenHelp
          : `store ${providerName(instanceId)}'s long-lived credential as ${tokenEnv ?? "its token"}`,
    },
  };
};

/** "claudeAgent" → "claude", what people call it and what its launcher is named after. */
export const providerName = (instanceId: string) => (instanceId === "claudeAgent" ? "claude" : instanceId);

const launcherName = (instanceId: string) => providerName(instanceId).replace(/[^A-Za-z0-9._-]/g, "-");
export const launcherPath = (home: string, instanceId: string) => `${home}/.local/bin/${LAUNCHER_PREFIX}${launcherName(instanceId)}`;
/** Where the launcher was before the rename. Until 1.0. */
export const legacyLauncherPath = (home: string, instanceId: string) => `${home}/.local/bin/${LEGACY_LAUNCHER_PREFIX}${launcherName(instanceId)}`;
