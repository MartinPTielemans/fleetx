/**
 * Credentials in what T3 Fleet is about to commit. Every commit it makes
 * (commitAndPush, sync's commits and proposals, approvals, init) scans the
 * lines it adds and refuses one that looks like a secret: secrets belong in
 * secrets/secrets.env.age, which `t3-fleet secrets set` encrypts.
 *
 * Only added lines are scanned, so a file already committed (a vendored skill
 * whose docs show an example token) never blocks an unrelated change to it.
 * What it finds is named by file, line and kind, never by value.
 *
 * A false positive is let through by an entry in t3-fleet.toml, keyed by the
 * file and a hash of the line, which `t3-fleet secrets allow FILE HASH` adds:
 *
 *   [[allow_secret]]
 *   file = "skills/mapbox/README.md"
 *   line = "9f2c4a1e07b3d855"
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export interface SecretHit {
  readonly file: string;
  readonly line: number;
  /** What it looks like: "a GitHub token", "a password in a URL". */
  readonly kind: string;
  /** Hash of the line, the key an allow_secret entry uses. */
  readonly hash: string;
}

export interface Allowed {
  readonly file: string;
  readonly line: string;
}

/** A line's identity for the allow-list: FNV-1a, twice, over its trimmed text. Not the value. */
export const lineHash = (line: string) => {
  const text = line.trim();
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return fnv(0x811c9dc5) + fnv(0x050c5d1f);
};

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

/** A publishable key (Mapbox's pk.…, Stripe's pk_…) is meant to be shown. */
const isPublic = (value: string) => /^pk[._]/.test(value);

/** A value worth calling a secret: long, varied, not a reference or a placeholder. */
const looksReal = (value: string, minLength: number) =>
  value.length >= minLength &&
  !isReference(value) &&
  !isPublic(value) &&
  !PLACEHOLDER.test(value) &&
  entropy(value) >= 3 &&
  /[0-9]/.test(value) &&
  /[A-Za-z]/.test(value);

interface Rule {
  readonly kind: string | ((m: RegExpExecArray) => string);
  readonly pattern: RegExp;
  /** The group holding the value; the whole match when absent. */
  readonly value?: number;
  readonly minLength: number;
}

const NAME = String.raw`[A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|pwd|credential)[A-Za-z0-9_.-]*`;

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
    kind: "an age secret key",
    pattern: /AGE-SECRET-KEY-1[0-9A-Z]{50,}/g,
    minLength: 50,
  },
  {
    kind: "a password in a URL",
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:([^\s/@"']+)@/gi,
    value: 1,
    minLength: 8,
  },
  {
    kind: (m) => `a token in a URL query (${m[1]})`,
    pattern: new RegExp(String.raw`[?&](${NAME})=([^&\s"'#]+)`, "gi"),
    value: 2,
    minLength: 12,
  },
  {
    kind: (m) => `a secret in a command-line flag (--${m[1]})`,
    pattern: new RegExp(String.raw`--(${NAME})(?:=|\s+|["']\s*,\s*["'])["']?([^\s"',]+)`, "gi"),
    value: 2,
    minLength: 16,
  },
  {
    kind: (m) => `a secret assigned to ${m[1]}`,
    pattern: new RegExp(
      String.raw`(?<![-A-Za-z0-9_])(${NAME})["']?\s*[:=]\s*["']?([^\s"',;}]+)`,
      "gi",
    ),
    value: 2,
    minLength: 16,
  },
];

const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const AGE_ARMOR = "-----BEGIN AGE ENCRYPTED FILE-----";

/** What one line looks like, if a secret: the first rule whose value is real. */
export const scanLine = (text: string): string | null => {
  if (PRIVATE_KEY.test(text)) return "a private key";
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (let m = rule.pattern.exec(text); m !== null; m = rule.pattern.exec(text)) {
      const value = (rule.value === undefined ? m[0] : m[rule.value]) ?? "";
      if (looksReal(value, rule.minLength))
        return typeof rule.kind === "string" ? rule.kind : rule.kind(m);
    }
  }
  return null;
};

/** Lines of `file` (numbered from `first`) that look like secrets, less those allowed. */
export const scanLines = (
  file: string,
  lines: ReadonlyArray<{ readonly line: number; readonly text: string }>,
  allowed: ReadonlyArray<Allowed> = [],
): Array<SecretHit> => {
  if (file.endsWith(".age") || lines.some((l) => l.text.includes(AGE_ARMOR))) return [];
  const hits: Array<SecretHit> = [];
  for (const { line, text } of lines) {
    const kind = scanLine(text);
    if (kind === null) continue;
    const hash = lineHash(text);
    if (allowed.some((a) => a.file === file && a.line === hash)) continue;
    hits.push({ file, line, kind, hash });
  }
  return hits;
};

/** Every line of a whole text, for a file not yet in git. */
export const scanText = (file: string, text: string, allowed: ReadonlyArray<Allowed> = []) =>
  scanLines(
    file,
    text.split("\n").map((t, i) => ({ line: i + 1, text: t })),
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

/** The repo's allow_secret entries, from its t3-fleet.toml; none when it has none or cannot be read. */
export const readAllowed = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(`${repo}/t3-fleet.toml`)
      .pipe(Effect.orElseSucceed(() => ""));
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

/** One hit, for a person: where and what, and how to let it through if it is not a secret. */
export const describeHit = (hit: SecretHit) => `${hit.file}:${hit.line} looks like ${hit.kind}`;

export const allowCommand = (hit: SecretHit) => `t3-fleet secrets allow ${hit.file} ${hit.hash}`;

/** The refusal for hits: each named, never its value, and the ways forward. */
export const refusal = (hits: ReadonlyArray<SecretHit>) =>
  [
    "refusing to commit what looks like a secret:",
    ...hits.map((h) => `  ${describeHit(h)}`),
    "Move it into the fleet's secrets (`t3-fleet secrets set NAME=VALUE`, then refer to it as ${NAME}).",
    "If it is not a secret, allow that line and try again:",
    ...[...new Set(hits.map(allowCommand))].map((c) => `  ${c}`),
  ].join("\n");

/** Add an allow_secret entry to the repo's t3-fleet.toml, unless it is there. Whether it was added. */
export const allowSecret = (repo: string, file: string, hash: string, reason?: string) =>
  Effect.gen(function* () {
    if (!/^[0-9a-f]{16}$/.test(hash))
      return yield* Effect.fail(`not a line hash (16 hex digits, from the refusal): ${hash}`);
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
