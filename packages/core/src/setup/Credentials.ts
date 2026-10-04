/**
 * MCP servers as clients have them, turned into definitions for the repo's
 * mcp/<name>.json with every credential moved out into a secret.
 *
 * A credential can sit anywhere in a client's entry: a header value, an env
 * value, a URL query parameter, the argument after `--api-key`, the password
 * in a connection string. Each one found is replaced by `$NAME` and its
 * value returned as a secret named NAME, so the definition can be committed
 * and the value goes into the encrypted secrets file. Values that are not
 * credentials (LOG_LEVEL=debug, a path) stay as they are: dropping them was
 * as wrong as committing the others.
 *
 *   stdio    { kind: "stdio", command, args, env: { KEY: "$NAME" } }
 *   http     { kind: "direct", url, auth: { type: "bearer", token_env: "NAME" },
 *              headers: { "X-Api-Key": "$NAME" } }
 *   sse      the same, with transport: "sse"
 *
 * In env and headers a value that is exactly `$NAME` is a secret, so a
 * credential there makes the whole value the secret. In a URL or an argument
 * only the credential itself is replaced.
 *
 * Pure: the caller reads the clients' files and the environment.
 */

export interface Secret {
  readonly name: string;
  readonly value: string;
  /** Where it was found, for the plan: "header Authorization", "arg --api-key". */
  readonly where: string;
}

/** A secret the definition needs whose value setup could not find. */
export interface Missing {
  readonly name: string;
  readonly why: string;
}

export interface Extracted {
  readonly definition: Record<string, unknown>;
  readonly secrets: ReadonlyArray<Secret>;
  readonly missing: ReadonlyArray<Missing>;
  /** Why this server can only work on this machine; null when it can work anywhere. */
  readonly local: string | null;
  /** Settings of the client's entry a definition cannot carry. */
  readonly dropped: ReadonlyArray<string>;
}

/**
 * Hands out secret names: unique among `taken` and each other, and the same
 * name again for a value already named (one token used by two servers is one
 * secret).
 */
export const secretNamer = (taken: Iterable<string>) => {
  const used = new Set(taken);
  const byValue = new Map<string, string>();
  return (base: string, value: string | null) => {
    if (value !== null) {
      const known = byValue.get(value);
      if (known !== undefined) return known;
    }
    const clean =
      base
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/^(?=\d)/, "_") || "SECRET";
    let name = clean;
    for (let n = 2; used.has(name); n++) name = `${clean}_${n}`;
    used.add(name);
    if (value !== null) byValue.set(value, name);
    return name;
  };
};
export type SecretNamer = ReturnType<typeof secretNamer>;

export interface ExtractContext {
  readonly home: string;
  /** The environment setup runs in: Codex reads some credentials from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly name: SecretNamer;
}

const CREDENTIAL_NAME =
  /key|token|secret|passw|pwd|auth|credential|session|cookie|(^|[_-])pat($|[_-])|dsn|connection[_-]?string|signature|(^|[_-])sig($|[_-])/i;
const NOT_CREDENTIAL_NAME = /^(no_auth|auth_type|auth_mode|authority|author|keys?_?path|.*_file)$/i;
const TOKEN_PREFIX =
  /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abposr]-|glpat-|AKIA|AIza|ya29\.|eyJ|phc_|phx_|lin_api_|ntn_|secret_|shpat_|dop_v1_|npm_)/;
const FLAG = /^--?[\w-]*(key|token|secret|passw|credential|auth)[\w-]*$/i;

/** Whether a name (an env key, a header, a query parameter, a flag) says it holds a credential. */
export const credentialName = (name: string) =>
  CREDENTIAL_NAME.test(name) && !NOT_CREDENTIAL_NAME.test(name);

/** Whether a value looks like a token whatever it is called: a known prefix, or long and random. */
export const looksLikeToken = (value: string) => {
  if (/\s/.test(value) || value.startsWith("$")) return false;
  if (TOKEN_PREFIX.test(value) && value.length >= 12) return true;
  if (value.length < 24 || /[/:@]/.test(value)) return false;
  return /^[A-Za-z0-9_\-.=+]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
};

const isPlaceholder = (value: string) => /^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(value);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

const tilde = (p: string, home: string) =>
  home !== "" && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;

const nameFor = (server: string, part: string) => {
  const s = server.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const p = part.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return p.startsWith(`${s}_`) || p === s ? p : `${s}_${p}`;
};

/**
 * Moves credentials out of one string: the password of a URL and its
 * credential query parameters. Everything else in the string stays.
 */
const scrubUrl = (
  text: string,
  server: string,
  where: string,
  ctx: ExtractContext,
  secrets: Array<Secret>,
) => {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  const url = URL.parse(text);
  if (url === null) return text;
  let out = text;
  if (url.password !== "") {
    const value = decodeURIComponent(url.password);
    const name = ctx.name(nameFor(server, "password"), value);
    secrets.push({ name, value, where: `${where} password` });
    // Replace in the original text: URL would re-encode the rest of it.
    out = out.replace(`:${url.password}@`, `:$${name}@`);
  }
  for (const [key, value] of url.searchParams) {
    if (value === "" || isPlaceholder(value)) continue;
    if (!credentialName(key) && !looksLikeToken(value)) continue;
    const name = ctx.name(nameFor(server, key), value);
    secrets.push({ name, value, where: `${where} query ${key}` });
    const encoded = [value, encodeURIComponent(value)];
    for (const v of encoded) out = out.replace(`${key}=${v}`, `${key}=$${name}`);
  }
  return out;
};

/** Whether a URL carries a credential: a password, or a credential query parameter. */
const urlHasCredential = (text: string) => {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false;
  const url = URL.parse(text);
  if (url === null) return false;
  return (
    url.password !== "" ||
    [...url.searchParams].some(
      ([k, v]) => v !== "" && !isPlaceholder(v) && (credentialName(k) || looksLikeToken(v)),
    )
  );
};

/**
 * One argument's value: the password or credential query parameter of a URL,
 * or the whole value when its flag or its look says it is a credential.
 */
const scrubValue = (
  server: string,
  key: string,
  value: string,
  base: string,
  where: string,
  ctx: ExtractContext,
  secrets: Array<Secret>,
) => {
  if (isPlaceholder(value)) return value;
  const scrubbed = scrubUrl(value, server, where, ctx, secrets);
  if (scrubbed !== value) return scrubbed;
  if (value === "" || (!credentialName(key) && !looksLikeToken(value))) return value;
  const name = ctx.name(base, value);
  secrets.push({ name, value, where });
  return `$${name}`;
};

/**
 * An env or header value: a value that is exactly `$NAME` is the secret NAME
 * (the definition's rule), so a credential anywhere in it makes the whole
 * value the secret, a connection string with its password included.
 */
const scrubWhole = (
  key: string,
  value: string,
  base: string,
  where: string,
  ctx: ExtractContext,
  secrets: Array<Secret>,
) => {
  if (isPlaceholder(value) || value === "") return value;
  if (!credentialName(key) && !looksLikeToken(value) && !urlHasCredential(value)) return value;
  const name = ctx.name(base, value);
  secrets.push({ name, value, where });
  return `$${name}`;
};

const scrubArgs = (
  server: string,
  args: ReadonlyArray<string>,
  ctx: ExtractContext,
  secrets: Array<Secret>,
) => {
  const out: Array<string> = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const eq = /^(--?[\w-]+)=(.*)$/s.exec(arg);
    if (eq?.[1] !== undefined && FLAG.test(eq[1]) && eq[2] !== undefined && eq[2] !== "") {
      const flag = eq[1].replace(/^-+/, "");
      out.push(
        `${eq[1]}=${scrubValue(server, flag, eq[2], nameFor(server, flag), `arg ${eq[1]}`, ctx, secrets)}`,
      );
      continue;
    }
    if (FLAG.test(arg) && i + 1 < args.length && !(args[i + 1] ?? "").startsWith("-")) {
      const flag = arg.replace(/^-+/, "");
      const value = args[i + 1] ?? "";
      out.push(arg);
      if (isPlaceholder(value)) out.push(value);
      else {
        const name = ctx.name(nameFor(server, flag), value);
        secrets.push({ name, value, where: `arg ${arg}` });
        out.push(`$${name}`);
      }
      i++;
      continue;
    }
    // KEY=value, as docker -e and env take it.
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(arg);
    if (assign?.[1] !== undefined && assign[2] !== undefined) {
      out.push(
        `${assign[1]}=${scrubValue(server, assign[1], assign[2], nameFor(server, assign[1]), `arg ${assign[1]}=`, ctx, secrets)}`,
      );
      continue;
    }
    const scrubbed = scrubUrl(arg, server, `arg ${i + 1}`, ctx, secrets);
    if (scrubbed !== arg) {
      out.push(scrubbed);
      continue;
    }
    if (looksLikeToken(arg)) {
      const name = ctx.name(nameFor(server, "token"), arg);
      secrets.push({ name, value: arg, where: `arg ${i + 1}` });
      out.push(`$${name}`);
      continue;
    }
    out.push(tilde(arg, ctx.home));
  }
  return out;
};

const scrubTable = (
  server: string,
  table: Readonly<Record<string, unknown>> | undefined,
  label: "env" | "header",
  ctx: ExtractContext,
  secrets: Array<Secret>,
) => {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(table ?? {})) {
    if (typeof raw !== "string") continue;
    out[key] = scrubWhole(key, raw, nameFor(server, key), `${label} ${key}`, ctx, secrets);
  }
  return out;
};

/**
 * A bearer token in an Authorization header becomes `auth`, the form both
 * clients take a bearer secret in. Returns the headers left, and the auth.
 */
const bearerAuth = (
  server: string,
  headers: Readonly<Record<string, string>>,
  ctx: ExtractContext,
  secrets: Array<Secret>,
) => {
  const key = Object.keys(headers).find((h) => /^authorization$/i.test(h));
  const bearer = key === undefined ? null : /^Bearer\s+(\S+)$/i.exec(headers[key] ?? "");
  if (key === undefined || bearer?.[1] === undefined) return { headers, auth: null };
  const rest = Object.fromEntries(Object.entries(headers).filter(([h]) => h !== key));
  const ref = /^\$\{?([A-Z_][A-Z0-9_]*)\}?$/.exec(bearer[1])?.[1];
  if (ref !== undefined) return { headers: rest, auth: ref };
  const name = ctx.name(nameFor(server, "token"), bearer[1]);
  secrets.push({ name, value: bearer[1], where: `header ${key}` });
  return { headers: rest, auth: name };
};

/** Why a server can only run on this machine, or null. */
const localReason = (
  url: string | undefined,
  command: string | undefined,
  args: ReadonlyArray<string>,
  home: string,
) => {
  if (url !== undefined) {
    const host = URL.parse(url)?.hostname;
    if (host !== undefined && (LOCAL_HOSTS.has(host) || host.endsWith(".local")))
      return `listens on this machine (${host})`;
  }
  for (const p of [command, ...args]) {
    if (p !== undefined && p.startsWith("/") && !(home !== "" && p.startsWith(`${home}/`)))
      return `runs from ${p}, a path outside your home directory`;
  }
  return null;
};

const definitionOf = (
  server: string,
  entry: {
    readonly url?: string | undefined;
    readonly sse?: boolean;
    readonly command?: string | undefined;
    readonly args: ReadonlyArray<string>;
    readonly env?: Readonly<Record<string, unknown>> | undefined;
    readonly headers: Readonly<Record<string, string>>;
  },
  ctx: ExtractContext,
  secrets: Array<Secret>,
): Record<string, unknown> | null => {
  if (entry.url !== undefined) {
    const url = scrubUrl(entry.url, server, "url", ctx, secrets);
    const bearer = bearerAuth(server, entry.headers, ctx, secrets);
    const headers = scrubTable(server, bearer.headers, "header", ctx, secrets);
    return {
      kind: "direct",
      url,
      ...(entry.sse === true ? { transport: "sse" } : {}),
      ...(bearer.auth === null ? {} : { auth: { type: "bearer", token_env: bearer.auth } }),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  if (entry.command !== undefined) {
    const env = scrubTable(server, entry.env, "env", ctx, secrets);
    return {
      kind: "stdio",
      command: tilde(entry.command, ctx.home),
      args: scrubArgs(server, entry.args, ctx, secrets),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  return null;
};

const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const stringTable = (v: unknown): Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"),
      )
    : {};

/** One entry per secret: a value found twice is one secret. */
const unique = (secrets: ReadonlyArray<Secret>) =>
  secrets.filter((s, i) => secrets.findIndex((t) => t.name === s.name) === i);

const CLAUDE_KNOWN = new Set(["type", "url", "command", "args", "env", "headers"]);
const CODEX_KNOWN = new Set([
  "url",
  "command",
  "args",
  "env",
  "http_headers",
  "env_http_headers",
  "bearer_token_env_var",
  "enabled",
]);

/** A server from ~/.claude.json (`mcpServers`, user or project scope). Null when it is neither http nor stdio. */
export const fromClaude = (
  server: string,
  entry: Readonly<Record<string, unknown>>,
  ctx: ExtractContext,
): Extracted | null => {
  const secrets: Array<Secret> = [];
  const url = typeof entry["url"] === "string" ? entry["url"] : undefined;
  const command = typeof entry["command"] === "string" ? entry["command"] : undefined;
  const args = strings(entry["args"]);
  const definition = definitionOf(
    server,
    {
      url,
      sse: entry["type"] === "sse",
      command,
      args,
      env: stringTable(entry["env"]),
      headers: stringTable(entry["headers"]),
    },
    ctx,
    secrets,
  );
  if (definition === null) return null;
  return {
    definition,
    secrets: unique(secrets),
    missing: [],
    local: localReason(url, command, args, ctx.home),
    dropped: Object.keys(entry).filter((k) => !CLAUDE_KNOWN.has(k)),
  };
};

/** A server from ~/.codex/config.toml (`mcp_servers`). Null when it is neither http nor stdio. */
export const fromCodex = (
  server: string,
  entry: Readonly<Record<string, unknown>>,
  ctx: ExtractContext,
): Extracted | null => {
  const secrets: Array<Secret> = [];
  const missing: Array<Missing> = [];
  const url = typeof entry["url"] === "string" ? entry["url"] : undefined;
  const command = typeof entry["command"] === "string" ? entry["command"] : undefined;
  const args = strings(entry["args"]);
  // Headers Codex fills from the environment at run time: the value is whatever is set here now.
  const fromEnv: Record<string, string> = {};
  const envHeaders = stringTable(entry["env_http_headers"]);
  const bearer =
    typeof entry["bearer_token_env_var"] === "string" ? entry["bearer_token_env_var"] : null;
  const viaEnv: Array<readonly [string, string, string]> = [
    ...(bearer === null ? [] : [["Authorization", bearer, "Bearer "] as const]),
    ...Object.entries(envHeaders).map(([h, v]) => [h, v, ""] as const),
  ];
  for (const [header, variable, prefix] of viaEnv) {
    const value = ctx.env[variable];
    const name = ctx.name(variable, value === undefined || value === "" ? null : value);
    if (value === undefined || value === "")
      missing.push({
        name,
        why: `${header === "Authorization" ? "bearer_token_env_var" : `env_http_headers ${header}`} names $${variable}, which is not set here`,
      });
    else secrets.push({ name, value, where: `$${variable} (${header})` });
    fromEnv[header] = `${prefix}$${name}`;
  }
  const definition = definitionOf(
    server,
    {
      url,
      command,
      args,
      env: stringTable(entry["env"]),
      headers: { ...stringTable(entry["http_headers"]), ...fromEnv },
    },
    ctx,
    secrets,
  );
  if (definition === null) return null;
  return {
    definition,
    secrets: unique(secrets),
    missing,
    local: localReason(url, command, args, ctx.home),
    dropped: Object.keys(entry).filter(
      (k) => !CODEX_KNOWN.has(k) && !(k === "enabled" && entry[k] === true),
    ),
  };
};

/**
 * A definition with its secret names blanked, and the older
 * `auth = { type = "bearer", token_env }` written as the header it sends:
 * two definitions that differ only in what their secrets are called are the
 * same server. Values are never compared; a joining machine cannot read the
 * fleet's yet.
 */
export const shapeOf = (definition: Readonly<Record<string, unknown>>) => {
  const { auth, ...rest } = definition as { auth?: { type?: string; token_env?: string } };
  const normalized: Record<string, unknown> = { ...rest };
  if (auth?.type === "bearer" && auth.token_env !== undefined)
    normalized["headers"] = {
      ...(normalized["headers"] as object | undefined),
      Authorization: `Bearer $${auth.token_env}`,
    };
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : typeof v === "object" && v !== null
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sorted(x)]),
          )
        : v;
  return JSON.stringify(sorted(normalized)).replace(/\$\{?[A-Z_][A-Z0-9_]*\}?/g, "$SECRET");
};

/** The secret names a definition refers to. */
export const secretRefs = (definition: unknown): Array<string> => {
  const text = JSON.stringify(definition);
  return [
    ...new Set([
      ...[...text.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)].map((m) => m[1] ?? ""),
      ...[...text.matchAll(/"(?:token_env|client_secret_env)":"([A-Z_][A-Z0-9_]*)"/g)].map(
        (m) => m[1] ?? "",
      ),
    ]),
  ];
};
