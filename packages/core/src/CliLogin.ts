/**
 * The fallback for provider logins, when T3's own snapshot cannot be read
 * (no token yet, or T3 not answering; see T3Access.ts): ask the CLI itself,
 * run the way T3 runs it, with the T3 server's environment and through the
 * binary T3 launches, so a launcher contributes the token it loads.
 *
 *   claude   `auth status --json` prints {loggedIn, authMethod, ...} and
 *            exits 1 when logged out; authMethod is "claude.ai",
 *            "oauth_token" (a token from the environment), "api_key" or
 *            "none". For an environment token only `--text` says which
 *            variable it came from.
 *   codex    `login status` prints "Logged in using ChatGPT", "Logged in
 *            using an API key …" or "Not logged in" (exit 1).
 *
 * Other drivers have no fallback; T3's snapshot is the only source for them.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProviderAuth } from "./Api.ts";
import { exec } from "./Exec.ts";

const StatusJson = Schema.Struct({
  loggedIn: Schema.Boolean,
  authMethod: Schema.optionalKey(Schema.String),
  apiProvider: Schema.optionalKey(Schema.String),
  subscriptionType: Schema.optionalKey(Schema.NullOr(Schema.String)),
  apiKeySource: Schema.optionalKey(Schema.String),
});

const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(StatusJson));

type Login = Pick<ProviderAuth, "auth" | "method" | "detail">;

/** Reads `auth status --json` output, and `--text` output when the method is an environment token. */
export const parseClaudeAuth = (json: string, text: string | null): Login => {
  const status = decodeStatus(json.trim());
  if (Option.isNone(status)) {
    const line = json.split("\n").find((l) => l.trim() !== "") ?? "no output";
    return { auth: "unknown", method: null, detail: `claude auth status did not answer as expected: ${line.trim().slice(0, 200)}` };
  }
  const s = status.value;
  const provider = s.apiProvider !== undefined && s.apiProvider !== "firstParty" ? ` via ${s.apiProvider}` : "";
  if (!s.loggedIn) return { auth: "unauthenticated", method: null, detail: `not logged in${provider}` };
  switch (s.authMethod) {
    case "claude.ai":
      return { auth: "authenticated", method: "claude.ai", detail: `${s.subscriptionType ? `${s.subscriptionType} subscription` : "claude.ai"} login${provider}` };
    case "oauth_token": {
      const source = /Auth token:\s*(\S+)/.exec(text ?? "")?.[1] ?? null;
      return source === "CLAUDE_CODE_OAUTH_TOKEN"
        ? { auth: "authenticated", method: "setup-token", detail: `token from ${source}${provider}` }
        : { auth: "authenticated", method: "auth-token", detail: `token from ${source ?? "the environment"}${provider}` };
    }
    case "api_key":
      return { auth: "authenticated", method: "api-key", detail: `API key from ${s.apiKeySource ?? "the environment"}${provider}` };
    default:
      return { auth: "authenticated", method: s.authMethod ?? null, detail: `logged in${provider}` };
  }
};

export const parseCodexLogin = (output: string): Login => {
  const line = output.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  if (/^not logged in/i.test(line)) return { auth: "unauthenticated", method: null, detail: "not logged in" };
  const how = /^logged in using (?:an? )?(chatgpt|api key)/i.exec(line);
  if (how?.[1] !== undefined) return { auth: "authenticated", method: how[1].toLowerCase() === "chatgpt" ? "chatgpt" : "api-key", detail: line.slice(0, 200) };
  return { auth: "unknown", method: null, detail: `codex login status did not answer as expected: ${line.slice(0, 200) || "no output"}` };
};

const failed = (run: { readonly timedOut: boolean; readonly spawnError?: string }, what: string): Login | null =>
  run.timedOut
    ? { auth: "unknown", method: null, detail: `${what} timed out after 20s` }
    : run.spawnError !== undefined
      ? { auth: "unknown", method: null, detail: run.spawnError.slice(0, 240) }
      : null;

/** Runs `<binary> auth status` with `env`; never fails, an unknown answer is auth "unknown". */
export const claudeLogin = (binary: string, env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const json = yield* exec({ command: binary, args: ["auth", "status", "--json"], env, timeout: Duration.seconds(20) });
    const broken = failed(json, "claude auth status");
    if (broken !== null) return broken;
    const needsText = /"authMethod":\s*"oauth_token"/.test(json.stdout);
    const text = needsText
      ? (yield* exec({ command: binary, args: ["auth", "status", "--text"], env, timeout: Duration.seconds(20) })).stdout
      : null;
    return parseClaudeAuth(json.stdout === "" ? json.stderr : json.stdout, text);
  });

/** Runs `<binary> login status` with `env`; never fails. */
export const codexLogin = (binary: string, env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const run = yield* exec({ command: binary, args: ["login", "status"], env, timeout: Duration.seconds(20) });
    return failed(run, "codex login status") ?? parseCodexLogin(`${run.stdout}\n${run.stderr}`);
  });

/** The fallback check for a driver, or null when its CLI has none. */
export const cliLogin = (driver: string) => (driver === "claudeAgent" ? claudeLogin : driver === "codex" ? codexLogin : null);
