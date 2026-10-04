/**
 * MCP servers as clients have them, turned into definitions for the repo's
 * mcp/<name>.json with every credential moved out into a secret.
 *
 * A credential can sit anywhere in a client's entry: a header value, an env
 * value, a URL's user, password, path or query, the argument after
 * `--api-key`, an mcp-remote `--header "Authorization: Bearer …"`. Each one
 * found is replaced by `$NAME` and its value returned as a secret NAME, so
 * the definition can be committed and the value goes into the encrypted
 * secrets file.
 *
 *   stdio    { kind: "stdio", command, args, env: { KEY: "$NAME" } }
 *   http     { kind: "direct", url, auth: { type: "bearer", token_env: "NAME" },
 *              headers: { "X-Api-Key": "$NAME" } }
 *   sse      the same, with transport: "sse"
 *
 * In env and headers a value that is exactly `$NAME` is a secret, so a
 * credential there makes the whole value the secret; the rule is `mcp add`'s:
 * a value is a secret unless it is clearly harmless (a number, a boolean, a
 * path, a URL without a credential). In a URL or an argument only the
 * credential itself is replaced. Claude's `${VAR}` placeholders are filled
 * from the environment setup runs in.
 *
 * Afterwards the definition is checked: when any secret's value, or anything
 * shaped like a token, is still in it, the server is left alone on this
 * machine rather than written with it.
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
  /** Why T3 Fleet must leave this server alone here (an app's, disabled, a credential it cannot separate); null otherwise. */
  readonly leave: string | null;
  /** Settings of the client's entry a definition cannot carry. */
  readonly dropped: ReadonlyArray<string>;
}

/**
 * Names that must never become fleet secrets: the secrets file is loaded
 * into the environment of fixes, so these would change how programs run.
 */
export const UNSAFE_NAME =
  /^(PATH|HOME|SHELL|USER|LOGNAME|IFS|ENV|BASH_ENV|PS4|CDPATH|TMPDIR|PROMPT_COMMAND)$|^(LD_|DYLD_|NODE_|NPM_CONFIG_|GIT_|SSH_|PYTHON|PERL5|PERLLIB|RUBY|JAVA_TOOL_|BASH_FUNC|T3_FLEET_CONFIG|T3_FLEET_NODE)/;

const upper = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** A secret's name: the server's name, then the variable's or header's own unless it starts with it. */
export const nameFor = (server: string, part: string) => {
  const s = upper(server) || "MCP";
  const p = upper(part);
  const joined = p === "" ? s : p === s || p.startsWith(`${s}_`) ? p : `${s}_${p}`;
  const named = /^[A-Z_]/.test(joined) ? joined : `MCP_${joined}`;
  return UNSAFE_NAME.test(named) ? `MCP_${named}` : named;
};

/**
 * Hands out secret names: unique among `taken` and each other. One server's
 * value found twice is one secret; two servers never share one.
 */
export const secretNamer = (taken: Iterable<string>) => {
  const used = new Set(taken);
  const byValue = new Map<string, string>();
  return (server: string, part: string, value: string | null) => {
    const key = `${server}\0${value ?? ""}`;
    if (value !== null) {
      const known = byValue.get(key);
      if (known !== undefined) return known;
    }
    const base = nameFor(server, part);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    if (value !== null) byValue.set(key, name);
    return name;
  };
};
export type SecretNamer = ReturnType<typeof secretNamer>;

export interface ExtractContext {
  readonly home: string;
  /** The environment setup runs in: placeholders and Codex's variables are read from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly name: SecretNamer;
}

/** Words in a variable's, header's or flag's name that make its value a credential (as `mcp add`). */
const CREDENTIAL_WORDS = new Set([
  "TOKEN",
  "SECRET",
  "KEY",
  "APIKEY",
  "PASSWORD",
  "PASSWD",
  "PAT",
  "AUTH",
  "AUTHORIZATION",
  "CREDENTIAL",
  "CREDENTIALS",
  "COOKIE",
  "BEARER",
  "SESSION",
  "SIGNATURE",
  "SIG",
  "DSN",
]);

/** Whether a name says it holds a credential. */
export const credentialName = (name: string) =>
  upper(name)
    .split("_")
    .some((word) => CREDENTIAL_WORDS.has(word));

const TOKEN_PREFIX =
  /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abposr]-|glpat-|AKIA|AIza|ya29\.|eyJ|phc_|phx_|lin_api_|ntn_|secret_|shpat_|dop_v1_|npm_)/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;

/** Whether a value looks like a token whatever it is called: a known prefix, or long and random. */
export const looksLikeToken = (value: string) => {
  if (/\s/.test(value) || value.startsWith("$")) return false;
  if (TOKEN_PREFIX.test(value) && value.length >= 12) return true;
  if (value.length < 20 || /[/:@]/.test(value) || UUID.test(value) || SHA.test(value)) return false;
  return /^[A-Za-z0-9_\-.=+]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
};

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
};

/** A URL that carries a credential: a user, a password, a credential query parameter or path segment. */
const urlCredential = (url: URL) =>
  url.username !== "" ||
  url.password !== "" ||
  [...url.searchParams].some(([k, v]) => credentialName(k) || looksLikeToken(v)) ||
  url.pathname.split("/").some((s) => looksLikeToken(safeDecode(s)));

/**
 * Whether a value is clearly no credential: nothing, a number, a boolean, a
 * path, or a URL without one. `mcp add` keeps everything else secret.
 */
export const isHarmless = (value: string) => {
  if (value === "" || /^-?\d+(\.\d+)?$/.test(value)) return true;
  if (/^(true|false|yes|no|on|off)$/i.test(value)) return true;
  if (/^(\/|~\/|\.\.?\/)\S*$/.test(value)) return true;
  const url = URL.parse(value);
  return url !== null && /^(https?|wss?):$/.test(url.protocol) && !urlCredential(url);
};

/** A short plain word (`debug`, `eu`, `production`): harmless unless its name says credential. */
const plainWord = (value: string) => /^[A-Za-z][A-Za-z_-]{0,23}$/.test(value);

/** Whether an env or header value is a credential, by `mcp add`'s rule. */
export const isSecretValue = (key: string, value: string) =>
  !isHarmless(value) && (credentialName(key) || !plainWord(value));

/** `$NAME`: a reference to a secret already. */
const isRef = (value: string) => /^\$[A-Z_][A-Z0-9_]*$/.test(value);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

const tilde = (p: string, home: string) =>
  home !== "" && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;

/** What one server's extraction finds. */
interface Found {
  readonly server: string;
  readonly ctx: ExtractContext;
  readonly secrets: Array<Secret>;
  readonly missing: Array<Missing>;
}

const secret = (f: Found, part: string, value: string, where: string) => {
  const name = f.ctx.name(f.server, part, value);
  if (!f.secrets.some((s) => s.name === name)) f.secrets.push({ name, value, where });
  return name;
};

/**
 * Claude's `${VAR}` and `${VAR:-default}`: the value from the environment
 * setup runs in, as a secret; or missing, when it is not set here.
 */
const fillPlaceholders = (f: Found, text: string, where: string) =>
  text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_, variable: string, fallback: string | undefined) => {
      const value = f.ctx.env[variable] ?? fallback;
      if (value === undefined || value === "") {
        const name = f.ctx.name(f.server, variable, null);
        if (!f.missing.some((m) => m.name === name))
          f.missing.push({ name, why: `${where} uses \${${variable}}, which is not set here` });
        return `$${name}`;
      }
      return `$${secret(f, variable, value, `${where} (\${${variable}})`)}`;
    },
  );

/**
 * A URL with its credentials replaced, rebuilt from its parsed parts: the
 * user and password, path segments shaped like tokens, credential query
 * parameters. A URL with none is returned exactly as it was.
 */
const scrubUrl = (f: Found, text: string, where: string) => {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  const url = URL.parse(text);
  if (url === null) return text;
  let changed = false;
  let user = safeDecode(url.username);
  let pass = safeDecode(url.password);
  if (pass !== "" && !isRef(pass)) {
    pass = `$${secret(f, "password", pass, `${where} password`)}`;
    changed = true;
  }
  // A user alone is the credential (https://<token>@host); with a password, only when it looks like one.
  if (user !== "" && !isRef(user) && (looksLikeToken(user) || url.password === "")) {
    user = `$${secret(f, url.password === "" ? "token" : "user", user, `${where} user`)}`;
    changed = true;
  }
  const path = url.pathname
    .split("/")
    .map((segment) => {
      const value = safeDecode(segment);
      if (!looksLikeToken(value)) return segment;
      changed = true;
      return `$${secret(f, "path_token", value, `${where} path`)}`;
    })
    .join("/");
  const query = url.search
    .replace(/^\?/, "")
    .split("&")
    .filter((p) => p !== "")
    .map((pair) => {
      const at = pair.indexOf("=");
      if (at < 0) return pair;
      const key = safeDecode(pair.slice(0, at));
      const value = safeDecode(pair.slice(at + 1));
      if (value === "" || isRef(value) || (!credentialName(key) && !looksLikeToken(value)))
        return pair;
      changed = true;
      return `${pair.slice(0, at)}=$${secret(f, key, value, `${where} query ${key}`)}`;
    });
  if (!changed) return text;
  const enc = (s: string) => (isRef(s) ? s : encodeURIComponent(s));
  const userinfo =
    user === "" && pass === "" ? "" : `${enc(user)}${pass === "" ? "" : `:${enc(pass)}`}@`;
  return `${url.protocol}//${userinfo}${url.host}${path}${query.length > 0 ? `?${query.join("&")}` : ""}${url.hash}`;
};

/** An env or header value: `$NAME` for the whole value when it is a credential. */
const scrubWhole = (f: Found, key: string, value: string, where: string) => {
  if (isRef(value) || value === "") return value;
  // A filled placeholder inside a longer value keeps its shape, unless the rest is a credential too.
  const rest = value.replace(/\$[A-Z_][A-Z0-9_]*/g, "");
  if (rest !== value && (rest.trim() === "" || !isSecretValue(key, rest))) return value;
  if (!isSecretValue(key, value)) return value;
  return `$${secret(f, key, value, where)}`;
};

/** An mcp-remote header argument, `Name: value` or `Name:value`, with its value treated as a header's. */
const scrubHeaderArg = (f: Found, arg: string, where: string) => {
  const m = /^([^:\s]+)(:\s*)(.*)$/s.exec(arg);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) return arg;
  const [header, sep, value] = [m[1], m[2], m[3]];
  const scheme = /^(Bearer|Basic|Token)\s+(\S+)$/i.exec(value);
  if (scheme?.[1] !== undefined && scheme[2] !== undefined) {
    if (isRef(scheme[2])) return arg;
    const part = /^authorization$/i.test(header) ? "token" : header;
    return `${header}${sep}${scheme[1]} $${secret(f, part, scheme[2], where)}`;
  }
  return `${header}${sep}${scrubWhole(f, header, value, where)}`;
};

const FLAG = /^--?[\w-]*(key|token|secret|passw|credential|auth)[\w-]*$/i;
const HEADER_FLAG = /^(-H|--header)$/;

const scrubArgs = (f: Found, args: ReadonlyArray<string>) => {
  const out: Array<string> = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const next = args[i + 1];
    const eq = /^(--?[\w-]+)=(.*)$/s.exec(arg);
    if (eq?.[1] !== undefined && eq[2] !== undefined && eq[2] !== "") {
      const [flag, value] = [eq[1], eq[2]];
      if (HEADER_FLAG.test(flag)) {
        out.push(`${flag}=${scrubHeaderArg(f, value, `arg ${flag}`)}`);
        continue;
      }
      if (FLAG.test(flag)) {
        const url = scrubUrl(f, value, `arg ${flag}`);
        const kept = url !== value || isRef(value) || isHarmless(value);
        out.push(
          `${flag}=${kept ? url : `$${secret(f, flag.replace(/^-+/, ""), value, `arg ${flag}`)}`}`,
        );
        continue;
      }
    }
    if (HEADER_FLAG.test(arg) && next !== undefined) {
      out.push(arg, scrubHeaderArg(f, next, `arg ${arg}`));
      i++;
      continue;
    }
    if (FLAG.test(arg) && next !== undefined && !next.startsWith("-")) {
      const value = isRef(next)
        ? next
        : `$${secret(f, arg.replace(/^-+/, ""), next, `arg ${arg}`)}`;
      out.push(arg, value);
      i++;
      continue;
    }
    // KEY=value, as docker -e and env take it.
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(arg);
    if (assign?.[1] !== undefined && assign[2] !== undefined && credentialName(assign[1])) {
      out.push(`${assign[1]}=${scrubWhole(f, assign[1], assign[2], `arg ${assign[1]}=`)}`);
      continue;
    }
    const url = scrubUrl(f, arg, `arg ${i + 1}`);
    if (url !== arg) {
      out.push(url);
      continue;
    }
    if (looksLikeToken(arg)) {
      out.push(`$${secret(f, "token", arg, `arg ${i + 1}`)}`);
      continue;
    }
    out.push(tilde(arg, f.ctx.home));
  }
  return out;
};

const scrubTable = (f: Found, table: Readonly<Record<string, string>>, label: string) => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(table))
    out[key] = scrubWhole(f, key, value, `${label} ${key}`);
  return out;
};

/** A bearer token in an Authorization header becomes `auth`, the form both clients take one in. */
const bearerAuth = (f: Found, headers: Readonly<Record<string, string>>) => {
  const key = Object.keys(headers).find((h) => /^authorization$/i.test(h));
  const bearer = key === undefined ? null : /^Bearer\s+(\S+)$/i.exec(headers[key] ?? "");
  if (key === undefined || bearer?.[1] === undefined) return { headers, auth: null };
  const rest = Object.fromEntries(Object.entries(headers).filter(([h]) => h !== key));
  const ref = /^\$([A-Z_][A-Z0-9_]*)$/.exec(bearer[1])?.[1];
  return { headers: rest, auth: ref ?? secret(f, "token", bearer[1], `header ${key}`) };
};

/** Why a server is this machine's only: it listens here, or runs your own binary outside ~. */
const localReason = (url: string | undefined, command: string | undefined, home: string) => {
  if (url !== undefined) {
    const host = URL.parse(url)?.hostname;
    if (host !== undefined && (LOCAL_HOSTS.has(host) || host.endsWith(".local")))
      return `listens on this machine (${host})`;
  }
  if (
    command !== undefined &&
    command.startsWith("/") &&
    !(home !== "" && command.startsWith(`${home}/`))
  )
    return `runs ${command}, outside your home directory`;
  return null;
};

/** An app's own server (a command inside a .app bundle): the app manages it, not T3 Fleet. */
const appReason = (command: string | undefined) =>
  command !== undefined && /\.app(\/|$)/.test(command)
    ? `an app's own server (${command}); the app keeps it`
    : null;

/** Where any secret's value, or anything shaped like a token, is still in a definition; null when nothing is. */
export const residue = (
  definition: Readonly<Record<string, unknown>>,
  secrets: ReadonlyArray<Secret>,
) => {
  const text = JSON.stringify(definition);
  for (const s of secrets) {
    if (s.value.length < 4) continue;
    const encoded = encodeURIComponent(s.value);
    const forms = [
      s.value,
      encoded,
      encoded.replace(/%20/g, "+"),
      JSON.stringify(s.value).slice(1, -1),
    ];
    if (forms.some((v) => text.includes(v))) return s.where;
  }
  const refs = new Set([...text.matchAll(/\$([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]));
  const token = text.split(/[^A-Za-z0-9_\-.=+]+/).find((w) => !refs.has(w) && looksLikeToken(w));
  return token === undefined ? null : "something shaped like a token";
};

const definitionOf = (
  f: Found,
  entry: {
    readonly url?: string | undefined;
    readonly sse?: boolean;
    readonly command?: string | undefined;
    readonly args: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
    readonly headers: Readonly<Record<string, string>>;
  },
): Record<string, unknown> | null => {
  if (entry.url !== undefined) {
    const url = scrubUrl(f, entry.url, "url");
    const bearer = bearerAuth(f, entry.headers);
    const headers = scrubTable(f, bearer.headers, "header");
    return {
      kind: "direct",
      url,
      ...(entry.sse === true ? { transport: "sse" } : {}),
      ...(bearer.auth === null ? {} : { auth: { type: "bearer", token_env: bearer.auth } }),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  if (entry.command !== undefined) {
    const env = scrubTable(f, entry.env, "env");
    return {
      kind: "stdio",
      command: tilde(entry.command, f.ctx.home),
      args: scrubArgs(f, entry.args),
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

/** The checked result: a definition that still holds a credential is left alone, never offered. */
const finish = (
  f: Found,
  definition: Record<string, unknown>,
  source: { readonly url: string | undefined; readonly command: string | undefined },
  dropped: ReadonlyArray<string>,
  leave: string | null,
): Extracted => {
  const left = residue(definition, f.secrets);
  const multiLine = f.secrets.find((s) => s.value.includes("\n"));
  return {
    definition,
    secrets: f.secrets,
    missing: f.missing,
    local: localReason(source.url, source.command, f.ctx.home),
    leave:
      leave ??
      appReason(source.command) ??
      (left !== null
        ? `a credential in it (${left}) could not be separated; it stays in this machine's client only`
        : multiLine !== undefined
          ? `its credential (${multiLine.where}) spans several lines; it stays in this machine's client only`
          : null),
    dropped,
  };
};

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
  "env_vars",
]);

/** A server from ~/.claude.json (`mcpServers`, user or project scope). Null when it is neither http nor stdio. */
export const fromClaude = (
  server: string,
  entry: Readonly<Record<string, unknown>>,
  ctx: ExtractContext,
): Extracted | null => {
  const f: Found = { server, ctx, secrets: [], missing: [] };
  const fill = (s: string, where: string) => fillPlaceholders(f, s, where);
  const fillTable = (t: Record<string, string>, label: string) =>
    Object.fromEntries(Object.entries(t).map(([k, v]) => [k, fill(v, `${label} ${k}`)]));
  const url = typeof entry["url"] === "string" ? entry["url"] : undefined;
  const command = typeof entry["command"] === "string" ? entry["command"] : undefined;
  const definition = definitionOf(f, {
    url: url === undefined ? undefined : fill(url, "url"),
    sse: entry["type"] === "sse",
    command: command === undefined ? undefined : fill(command, "command"),
    args: strings(entry["args"]).map((a, i) => fill(a, `arg ${i + 1}`)),
    env: fillTable(stringTable(entry["env"]), "env"),
    headers: fillTable(stringTable(entry["headers"]), "header"),
  });
  if (definition === null) return null;
  const dropped = Object.keys(entry).filter((k) => !CLAUDE_KNOWN.has(k));
  return finish(f, definition, { url, command }, dropped, null);
};

/** A server from ~/.codex/config.toml (`mcp_servers`). Null when it is neither http nor stdio. */
export const fromCodex = (
  server: string,
  entry: Readonly<Record<string, unknown>>,
  ctx: ExtractContext,
): Extracted | null => {
  const f: Found = { server, ctx, secrets: [], missing: [] };
  const url = typeof entry["url"] === "string" ? entry["url"] : undefined;
  const command = typeof entry["command"] === "string" ? entry["command"] : undefined;
  // What Codex reads from its environment at run time: the value is whatever is set here now.
  const fromEnv = (variable: string, where: string) => {
    const value = ctx.env[variable];
    if (value === undefined || value === "") {
      const name = ctx.name(server, variable, null);
      if (!f.missing.some((m) => m.name === name))
        f.missing.push({ name, why: `${where} names $${variable}, which is not set here` });
      return name;
    }
    return secret(f, variable, value, `$${variable} (${where})`);
  };
  const headers: Record<string, string> = { ...stringTable(entry["http_headers"]) };
  for (const [header, variable] of Object.entries(stringTable(entry["env_http_headers"])))
    headers[header] = `$${fromEnv(variable, `env_http_headers ${header}`)}`;
  const bearer =
    typeof entry["bearer_token_env_var"] === "string" ? entry["bearer_token_env_var"] : null;
  if (bearer !== null)
    headers["Authorization"] = `Bearer $${fromEnv(bearer, "bearer_token_env_var")}`;
  const env: Record<string, string> = { ...stringTable(entry["env"]) };
  for (const v of strings(entry["env_vars"])) env[v] = `$${fromEnv(v, `env_vars ${v}`)}`;
  const definition = definitionOf(f, { url, command, args: strings(entry["args"]), env, headers });
  if (definition === null) return null;
  const dropped = Object.keys(entry).filter((k) => !CODEX_KNOWN.has(k));
  return finish(
    f,
    definition,
    { url, command },
    dropped,
    entry["enabled"] === false ? "disabled in Codex" : null,
  );
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
