/**
 * Credentials in what T3 Fleet is about to commit. Every commit it makes
 * (commitAndPush, sync's commits and proposals, approvals, init) and every
 * push scans the lines it adds and refuses one that looks like a secret:
 * secrets belong in secrets/secrets.env.age, which `t3-fleet secrets set`
 * encrypts.
 *
 * Only added lines are scanned, so a file already committed (a vendored skill
 * whose docs show an example token) never blocks an unrelated change to it.
 * What it finds is named by file, line and kind, never by value.
 *
 * Two kinds of rule. One knows a credential by its shape (ghp_…, a JWT, a
 * private key block). The other knows it by its name (`api_key = …`,
 * `--token …`, `?sig=…`, `Bearer …`): the name must end in key, token,
 * secret, password or the like, and the value must be varied, with a digit,
 * and not a variable name, a path, a reference ($NAME) or a placeholder
 * (YOUR_…). A key or token is one run of letters, digits and `_-+/=.`, of 20
 * or more; a password any run of 12 or more without brackets, as code has.
 *
 * Merge conflict markers are refused the same way: no commit carries one.
 *
 * A false positive is let through by an entry in t3-fleet.toml, keyed by the
 * file and the SHA-256 of the line, which `t3-fleet secrets allow FILE HASH`
 * adds. The hash is shown only in the refusal on the machine itself.
 *
 *   [[allow_secret]]
 *   file = "skills/mapbox/README.md"
 *   line = "<sha-256 of the line>"
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { sha256 } from "./Hash.ts";

/** A line that looks like a secret, before the allow-list is consulted. */
export interface Suspect {
  readonly file: string;
  readonly line: number;
  /** What it looks like: "a GitHub token", "a password in a URL". */
  readonly kind: string;
  readonly text: string;
}

export interface SecretHit {
  readonly file: string;
  /** 0 when the whole file is the problem (unresolved conflict). */
  readonly line: number;
  /** The commit adding it, when a commit not yet pushed does. */
  readonly commit?: string;
  readonly kind: string;
  /** SHA-256 of the line, the key an allow_secret entry uses. Never published. */
  readonly hash: string;
}

export interface Allowed {
  readonly file: string;
  readonly line: string;
}

/** A line's identity for the allow-list: SHA-256 of its trimmed text. */
export const lineHash = (line: string) => Effect.promise(() => sha256(line.trim()));

/** Bits per character: a real token is varied, an example (`xxxx`, `1234…`) is not. */
export const entropy = (value: string) => {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
  return bits;
};

const PLACEHOLDER =
  /your|xxx|example|placeholder|dummy|sample|changeme|change[-_]me|redacted|replace|insert|fake|<|>|\.\.\.|…|\*\*\*/i;

/** `$NAME`, `${NAME}`, `{env:NAME}`, `%NAME%`, `process.env.NAME`: a reference, not a value. */
const isReference = (value: string) =>
  /^\$|\$\{|^\{env:|^%[A-Za-z_]+%$|process\.env|os\.environ|getenv/.test(value);

/** Publishable keys, meant to be shown: Mapbox's pk.…, Stripe's pk_…, PostHog's phc_…. */
const isPublic = (value: string) => /^(?:pk[._]|phc_)/.test(value);

/** Varied, with letters and a digit, not a reference, placeholder or publishable key. */
const looksReal = (value: string, minLength: number) =>
  value.length >= minLength &&
  !isReference(value) &&
  !isPublic(value) &&
  !PLACEHOLDER.test(value) &&
  entropy(value) >= 3 &&
  /[0-9]/.test(value) &&
  /[A-Za-z]/.test(value);

/** One run of token characters: no call, index, space or quote, as code has. */
const tokenShaped = (value: string) => /^[A-Za-z0-9_\-+/=.]+$/.test(value);

/** An environment variable's name (T3_FLEET_MCP_TOKEN_MAC), which says where a value is. */
const isVariableName = (value: string) => /^[A-Z][A-Z0-9_]*$/.test(value);

/** A file path: rooted (~/, /, ./), or with directories and an extension (renders/out-1.mp4). */
const isPath = (value: string) =>
  /^(?:~\/|\/|\.\.?\/)/.test(value) || (value.includes("/") && /\.[A-Za-z0-9]{1,5}$/.test(value));

/** Code reaching into an object (config.oauth.clientSecret, env.S3SecretAccessKey), not a value. */
const isMemberAccess = (value: string) => /^[A-Za-z_]+(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value);

/** A kebab-case name (t3-not-installed, docker-http): words, each perhaps ending in a number. */
const isSlug = (value: string) => /^[a-z]+[0-9]*(?:-[a-z]+[0-9]*)+$/.test(value);

/** A key or token value a name-based rule calls a secret. */
const looksLikeToken = (value: string, minLength: number) =>
  tokenShaped(value) &&
  !isVariableName(value) &&
  !isPath(value) &&
  !isMemberAccess(value) &&
  !isSlug(value) &&
  looksReal(value, minLength);

/** A password value: any run without brackets (a call or an index is code), not a name or path. */
const looksLikePassword = (value: string, minLength: number) =>
  !/[\s()[\]{}]/.test(value) &&
  !isVariableName(value) &&
  !isPath(value) &&
  !isMemberAccess(value) &&
  looksReal(value, minLength);

/** `Basic <base64>`: real when it decodes to user:password. */
const looksLikeBasic = (value: string) => {
  if (!looksReal(value, 12)) return false;
  let decoded = "";
  try {
    decoded = atob(value);
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  return colon > 0 && colon < decoded.length - 1 && !PLACEHOLDER.test(decoded);
};

/** How a rule judges its value: by shape alone, as a key or token, as a password, as Basic auth. */
type Check = "shape" | "token" | "password" | "basic";

const PASSWORD_NAME = /(?:password|passwd|pwd)$/i;
/** The shell's working directory (PWD, OLDPWD), which only ends like a password. */
const SHELL_DIRECTORY = /^(?:OLD)?PWD$/i;

interface Rule {
  readonly kind: string | ((m: RegExpExecArray) => string);
  readonly pattern: RegExp;
  /** The group holding the value (the first it matched, of several); the whole match when absent. */
  readonly value?: number | ReadonlyArray<number>;
  /** Judged by shape alone unless it says otherwise; a password-named value as a password. */
  readonly check?: Check | ((m: RegExpExecArray) => Check);
  /** For shape rules: the least length a real one has. */
  readonly minLength?: number;
}

const MIN_LENGTH: Record<Exclude<Check, "shape">, number> = { token: 20, password: 12, basic: 12 };
/** A name-based rule's check: a password-named value is judged as a password. */
const byName = (m: RegExpExecArray): Check =>
  PASSWORD_NAME.test(m[1] ?? "") && !SHELL_DIRECTORY.test(m[1] ?? "") ? "password" : "token";

/**
 * A name that ends in what a credential is called: api_key, apiKey,
 * access_token, client_secret, passwd, DB_AUTH, X_BEARER. Not one that only
 * contains it: keyframeInterval, token_env, subject_token_type.
 */
const NAME = String.raw`[A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|pwd|credentials?|auth|bearer)`;
/** A query parameter's name: the same, or a signature (`sig`, `signature`). */
const QUERY_NAME = String.raw`(?:${NAME}|[A-Za-z0-9_.-]*(?:sig|signature))`;
/** Where a name-based rule's value ends. */
const VALUE = String.raw`[^\s"'\`,;}]+`;

const RULES: ReadonlyArray<Rule> = [
  {
    kind: "a GitHub token",
    pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g,
    minLength: 30,
  },
  {
    kind: "an Anthropic API key",
    pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g,
    minLength: 20,
  },
  {
    kind: "an API key (sk-…)",
    pattern: /(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{20,}/g,
    minLength: 20,
  },
  {
    kind: "a Slack token",
    pattern: /(?<![A-Za-z0-9_])xox[abposr]-[A-Za-z0-9-]{10,}/g,
    minLength: 15,
  },
  {
    kind: "a Slack webhook",
    pattern: /hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{20,}/g,
    minLength: 20,
  },
  {
    kind: "a Discord webhook",
    pattern: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g,
    minLength: 20,
  },
  {
    kind: "a Linear API key",
    pattern: /(?<![A-Za-z0-9_])lin_api_[A-Za-z0-9]{20,}/g,
    minLength: 20,
  },
  {
    kind: "an AWS access key",
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
    minLength: 20,
  },
  { kind: "a GitLab token", pattern: /(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}/g, minLength: 20 },
  { kind: "an npm token", pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36,}/g, minLength: 36 },
  { kind: "a Google API key", pattern: /(?<![A-Za-z0-9_])AIza[0-9A-Za-z_-]{35}/g, minLength: 35 },
  {
    kind: "a Stripe key",
    pattern: /(?<![A-Za-z0-9_])(?:sk|rk)_live_[0-9A-Za-z]{20,}/g,
    minLength: 20,
  },
  { kind: "a Hugging Face token", pattern: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/g, minLength: 30 },
  { kind: "a Groq API key", pattern: /(?<![A-Za-z0-9_])gsk_[A-Za-z0-9]{40,}/g, minLength: 40 },
  {
    kind: "a SendGrid API key",
    pattern: /(?<![A-Za-z0-9_])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
    minLength: 60,
  },
  {
    kind: "a Telegram bot token",
    pattern: /(?<![A-Za-z0-9_:])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
    minLength: 40,
  },
  {
    kind: "an age secret key",
    pattern: /AGE-SECRET-KEY-1[0-9A-Z]{50,}/g,
    minLength: 50,
  },
  {
    kind: "a JWT",
    pattern:
      /(?<![A-Za-z0-9_.-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g,
    minLength: 30,
  },
  {
    // An empty user too (redis://:pw@host). A Sentry DSN carries only a public key, and no colon.
    kind: "a password in a URL",
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']*:([^\s/@"']+)@/gi,
    value: 1,
    minLength: 8,
  },
  {
    kind: "a Basic auth header",
    pattern: /\bBasic\s+([A-Za-z0-9+/]{12,}={0,2})(?![A-Za-z0-9+/=])/g,
    value: 1,
    check: "basic",
  },
  {
    kind: "a bearer token",
    pattern: new RegExp(String.raw`\bBearer\s+(${VALUE})`, "gi"),
    value: 1,
    check: "token",
  },
  {
    kind: (m) => `a token in a URL query (${m[1]})`,
    pattern: new RegExp(String.raw`[?&](${QUERY_NAME})=([^&\s"'#]+)`, "gi"),
    value: 2,
    check: byName,
    minLength: 12,
  },
  {
    kind: (m) => `a secret in a command-line flag (--${m[1]})`,
    pattern: new RegExp(
      String.raw`--(${NAME})(?![A-Za-z0-9_-])(?:=|\s+|["']\s*,\s*["'])["']?(${VALUE})`,
      "gi",
    ),
    value: 2,
    check: byName,
  },
  {
    kind: "a password in a .netrc line",
    pattern: /(?:^\s*|\b(?:machine|login|default)\s+\S+\s+)password\s+(\S+)/gi,
    value: 1,
    check: "password",
    minLength: 8,
  },
  {
    // A quoted value is the whole quote, so a password may hold any punctuation.
    kind: (m) => `a secret assigned to ${m[1]}`,
    pattern: new RegExp(
      String.raw`(?<![-A-Za-z0-9_])(${NAME})(?![A-Za-z0-9_])["']?\s*[:=]\s*(?:"([^"\s]*)"|'([^'\s]*)'|(${VALUE}))`,
      "gi",
    ),
    value: [2, 3, 4],
    check: byName,
  },
];

const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const AGE_ARMOR = "-----BEGIN AGE ENCRYPTED FILE-----";

/** Whether a rule's value is real, by the rule's check. */
const real = (rule: Rule, m: RegExpExecArray, value: string) => {
  const check = typeof rule.check === "function" ? rule.check(m) : (rule.check ?? "shape");
  if (check === "shape") return looksReal(value, rule.minLength ?? 0);
  if (check === "basic") return looksLikeBasic(value);
  const min = rule.minLength ?? MIN_LENGTH[check];
  return check === "password" ? looksLikePassword(value, min) : looksLikeToken(value, min);
};

/** What one line looks like, if a secret: the first rule whose value is real. */
export const scanLine = (text: string): string | null => {
  if (PRIVATE_KEY.test(text)) return "a private key";
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (let m = rule.pattern.exec(text); m !== null; m = rule.pattern.exec(text)) {
      const groups =
        rule.value === undefined ? [0] : typeof rule.value === "number" ? [rule.value] : rule.value;
      const value = groups.map((g) => m?.[g]).find((v) => v !== undefined) ?? "";
      if (real(rule, m, value)) return typeof rule.kind === "string" ? rule.kind : rule.kind(m);
    }
  }
  return null;
};

/** A line git leaves where a merge conflicted. */
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/;

/** The fleet's own encrypted secrets, and any file that is an age file: never scanned. */
export const isEncrypted = (file: string, firstLine: string | null) =>
  file.startsWith("secrets/") || (firstLine !== null && firstLine.trim() === AGE_ARMOR);

/**
 * Lines of `file` that look like secrets. `firstLine` is the file's first
 * line, when the lines given do not include it, to know an age file.
 */
export const suspectLines = (
  file: string,
  lines: ReadonlyArray<{ readonly line: number; readonly text: string }>,
  firstLine: string | null = null,
): Array<Suspect> => {
  const first = lines.find((l) => l.line === 1)?.text ?? firstLine;
  if (isEncrypted(file, first)) return [];
  const suspects: Array<Suspect> = [];
  for (const { line, text } of lines) {
    const kind = CONFLICT_MARKER.test(text) ? "a merge conflict marker" : scanLine(text);
    if (kind !== null) suspects.push({ file, line, kind, text });
  }
  return suspects;
};

/** Hash the suspects and drop the lines the allow-list lets through. */
export const settle = (suspects: ReadonlyArray<Suspect>, allowed: ReadonlyArray<Allowed>) =>
  Effect.gen(function* () {
    const hits: Array<SecretHit> = [];
    for (const s of suspects) {
      const hash = yield* lineHash(s.text);
      if (allowed.some((a) => a.file === s.file && a.line === hash)) continue;
      hits.push({ file: s.file, line: s.line, kind: s.kind, hash });
    }
    return hits;
  });

/** Every line of a whole text, for a file not yet in git. */
export const scanText = (file: string, text: string, allowed: ReadonlyArray<Allowed> = []) =>
  settle(
    suspectLines(
      file,
      text.split("\n").map((t, i) => ({ line: i + 1, text: t })),
    ),
    allowed,
  );

/** The added lines of a `git diff -U0`, by file. */
export const addedLines = (diff: string) => {
  const files = new Map<string, Array<{ line: number; text: string }>>();
  let current: Array<{ line: number; text: string }> | null = null;
  let next = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4);
      if (target === "/dev/null") {
        current = null;
        continue;
      }
      const unquoted = target.startsWith('"') ? (JSON.parse(target) as string) : target;
      const name = unquoted.replace(/^b\//, "");
      current = files.get(name) ?? [];
      files.set(name, current);
    } else if (raw.startsWith("@@ ")) {
      next = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
    } else if (raw.startsWith("+") && current !== null) {
      current.push({ line: next++, text: raw.slice(1) });
    }
  }
  return files;
};

/** allow_secret entries in a t3-fleet.toml's text; none when it has none or does not parse. */
export const parseAllowed = (text: string) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try(() => parseToml(text) as unknown).pipe(
      Effect.orElseSucceed(() => ({})),
    );
    const entries = (parsed as { allow_secret?: unknown }).allow_secret;
    if (!Array.isArray(entries)) return [] as Array<Allowed>;
    return entries.flatMap((e): Array<Allowed> => {
      const { file, line } = (e ?? {}) as { file?: unknown; line?: unknown };
      return typeof file === "string" && typeof line === "string" ? [{ file, line }] : [];
    });
  });

/** The allow_secret entries in the checkout's t3-fleet.toml, as an authority has them. */
export const readAllowed = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(`${repo}/t3-fleet.toml`)
      .pipe(Effect.orElseSucceed(() => ""));
    return yield* parseAllowed(text);
  });

/** One hit, for a person: where and what. Never the value, and never its hash. */
export const describeHit = (hit: Pick<SecretHit, "file" | "line" | "kind" | "commit">) =>
  `${hit.file}${hit.line > 0 ? `:${hit.line}` : ""}${hit.commit === undefined ? "" : ` (in commit ${hit.commit})`} ${hit.line > 0 ? "looks like" : "has"} ${hit.kind}`;

export const allowCommand = (hit: SecretHit) => `t3-fleet secrets allow ${hit.file} ${hit.hash}`;

/** The refusal for hits, on the machine itself: each named, the ways forward, and the allow commands. */
export const refusal = (hits: ReadonlyArray<SecretHit>, doing = "commit") => {
  const conflicts = hits.filter((h) => CONFLICTS.has(h.kind));
  const secrets = hits.filter((h) => !CONFLICTS.has(h.kind));
  return [
    `refusing to ${doing} ${secrets.length > 0 ? "what looks like a secret" : "an unresolved merge conflict"}:`,
    ...hits.map((h) => `  ${describeHit(h)}`),
    ...(secrets.length > 0
      ? [
          "Move it into the fleet's secrets (`t3-fleet secrets set NAME=VALUE`, then refer to it as ${NAME}).",
          "If it is not a secret, an authority allows that line, then try again:",
          ...[...new Set(secrets.map(allowCommand))].map((c) => `  ${c}`),
        ]
      : []),
    ...(conflicts.length > 0
      ? [
          `Resolve the conflict: remove the <<<<<<< and >>>>>>> markers, then \`git add ${[...new Set(conflicts.map((h) => h.file))].join(" ")}\`.`,
        ]
      : []),
  ].join("\n");
};

/** What a merge leaves behind: not a secret, but never committed either. */
export const CONFLICTS: ReadonlySet<string> = new Set([
  "a merge conflict marker",
  "an unresolved merge conflict",
]);

/** Add an allow_secret entry to the repo's t3-fleet.toml, unless it is there. Whether it was added. */
export const allowSecret = (repo: string, file: string, hash: string, reason?: string) =>
  Effect.gen(function* () {
    if (!/^[0-9a-f]{64}$/.test(hash))
      return yield* Effect.fail(`not a line hash (64 hex digits, from the refusal): ${hash}`);
    if ((yield* readAllowed(repo)).some((a) => a.file === file && a.line === hash)) return false;
    const fs = yield* FileSystem.FileSystem;
    const path = `${repo}/t3-fleet.toml`;
    const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    const entry = stringifyToml({
      allow_secret: [{ file, line: hash, ...(reason === undefined ? {} : { reason }) }],
    }).trim();
    yield* fs.writeFileString(
      path,
      `${text}${text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n"}${entry}\n`,
    );
    return true;
  });
