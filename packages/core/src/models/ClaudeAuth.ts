/**
 * Whether Claude Code is logged in, the way T3 would run it.
 *
 * Claude logins drop every few days on some machine (see
 * docs/design/companion.md): concurrent CLI processes refresh one rotating
 * OAuth token and invalidate each other. A provider that is logged out still
 * starts, so the `--version` check passes and the first sign is a failed turn
 * in T3. `claude auth status` answers without a model call; the probe runs it
 * with the T3 server's environment through the binary T3 launches, so a
 * fleetx-claude launcher contributes the token it loads.
 *
 * `claude auth status --json` prints {loggedIn, authMethod, ...} and exits 1
 * when logged out. authMethod is "claude.ai" (an interactive login),
 * "oauth_token" (a token from the environment), "api_key", or "none"; for an
 * environment token only the text form says which variable it came from.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ClaudeAuth } from "../Api.ts";
import { exec } from "../Exec.ts";

const StatusJson = Schema.Struct({
  loggedIn: Schema.Boolean,
  authMethod: Schema.optionalKey(Schema.String),
  apiProvider: Schema.optionalKey(Schema.String),
  subscriptionType: Schema.optionalKey(Schema.NullOr(Schema.String)),
  apiKeySource: Schema.optionalKey(Schema.String),
});

const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(StatusJson));

/** Reads `auth status --json` output, and `--text` output when the method is an environment token. */
export const parseClaudeAuth = (json: string, text: string | null): ClaudeAuth => {
  const status = decodeStatus(json.trim());
  if (Option.isNone(status)) {
    const line = json.split("\n").find((l) => l.trim() !== "") ?? "no output";
    return { loggedIn: null, method: null, detail: `claude auth status did not answer as expected: ${line.trim().slice(0, 200)}` };
  }
  const s = status.value;
  const provider = s.apiProvider !== undefined && s.apiProvider !== "firstParty" ? ` via ${s.apiProvider}` : "";
  if (!s.loggedIn) return { loggedIn: false, method: null, detail: `not logged in${provider}` };
  switch (s.authMethod) {
    case "claude.ai":
      return { loggedIn: true, method: "oauth", detail: `${s.subscriptionType ? `${s.subscriptionType} subscription` : "claude.ai"} login${provider}` };
    case "oauth_token": {
      const source = /Auth token:\s*(\S+)/.exec(text ?? "")?.[1] ?? null;
      return source === "CLAUDE_CODE_OAUTH_TOKEN"
        ? { loggedIn: true, method: "setup-token", detail: `token from ${source}${provider}` }
        : { loggedIn: true, method: "auth-token", detail: `token from ${source ?? "the environment"}${provider}` };
    }
    case "api_key":
      return { loggedIn: true, method: "api-key", detail: `API key from ${s.apiKeySource ?? "the environment"}${provider}` };
    default:
      return { loggedIn: true, method: s.authMethod ?? null, detail: `logged in${provider}` };
  }
};

/** Runs `<binary> auth status` with `env`; never fails, an unknown answer is loggedIn: null. */
export const claudeAuthStatus = (binary: string, env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const json = yield* exec({ command: binary, args: ["auth", "status", "--json"], env, timeout: Duration.seconds(20) });
    if (json.timedOut) return { loggedIn: null, method: null, detail: "claude auth status timed out after 20s" } satisfies ClaudeAuth;
    if (json.spawnError !== undefined) return { loggedIn: null, method: null, detail: json.spawnError.slice(0, 240) } satisfies ClaudeAuth;
    const needsText = /"authMethod":\s*"oauth_token"/.test(json.stdout);
    const text = needsText
      ? (yield* exec({ command: binary, args: ["auth", "status", "--text"], env, timeout: Duration.seconds(20) })).stdout
      : null;
    return parseClaudeAuth(json.stdout === "" ? json.stderr : json.stdout, text);
  });
