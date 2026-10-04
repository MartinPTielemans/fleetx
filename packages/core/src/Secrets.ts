/**
 * Secrets: one dotenv file, encrypted with age to every node's key and kept
 * in the config repo.
 *
 *   secrets/secrets.env.age      armored age file (in git)
 *   secrets/recipients.toml      node = "age1…" public keys (in git)
 *   ~/.config/t3-fleet/age-key.txt this node's private key (never leaves it)
 *   ~/.config/t3-fleet/secrets.env decrypted, mode 600, what fixes and
 *                                templates read
 *
 * Encryption uses age-encryption, so nodes need no age binary.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { armor, Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { configDir } from "./Names.ts";

export class SecretsError extends Schema.TaggedError<SecretsError>()("SecretsError", {
  message: Schema.String,
}) {}

export const keyPath = (home: string) => `${configDir(home)}/age-key.txt`;
export const localSecretsPath = (home: string) => `${configDir(home)}/secrets.env`;
export const encryptedPath = (repo: string) => `${repo}/secrets/secrets.env.age`;
export const recipientsPath = (repo: string) => `${repo}/secrets/recipients.toml`;

const promise = <A>(f: () => Promise<A>, what: string) =>
  Effect.tryPromise({ try: f, catch: (cause) => new SecretsError({ message: `${what}: ${String(cause)}` }) });

const writePrivate = (file: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.ignore);
    yield* fs.writeFileString(file, content, { mode: 0o600 });
    yield* fs.chmod(file, 0o600);
  });

/** This node's identity, created on first use. */
export const ensureIdentity = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = process.env["HOME"] ?? "";
  const existing = yield* fs.readFileString(keyPath(home)).pipe(Effect.option);
  const identity = Option.isSome(existing)
    ? (existing.value.split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-")) ?? "")
    : "";
  if (identity !== "") return { identity, recipient: yield* promise(() => identityToRecipient(identity), "reading key"), created: false };
  const fresh = yield* promise(() => generateX25519Identity(), "generating key");
  const recipient = yield* promise(() => identityToRecipient(fresh), "deriving recipient");
  yield* writePrivate(keyPath(home), `# T3 Fleet node key; public: ${recipient}\n${fresh}\n`);
  return { identity: fresh, recipient, created: true };
});

export const readRecipients = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(recipientsPath(repo)).pipe(Effect.option);
    if (Option.isNone(text)) return {} as Record<string, string>;
    const raw = yield* Effect.try({
      try: () => parseToml(text.value) as Record<string, unknown>,
      catch: () => new SecretsError({ message: `${recipientsPath(repo)} is not valid TOML` }),
    });
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
    return out;
  });

export const writeRecipients = (repo: string, recipients: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${repo}/secrets`, { recursive: true }).pipe(Effect.ignore);
    const sorted = Object.fromEntries(Object.entries(recipients).sort(([a], [b]) => a.localeCompare(b)));
    yield* fs.writeFileString(recipientsPath(repo), `# Public age keys of the nodes that can read secrets.env.age.\n${stringifyToml(sorted)}\n`);
  });

export const decryptWith = (identity: string, armored: string) =>
  Effect.gen(function* () {
    const d = new Decrypter();
    d.addIdentity(identity);
    return yield* promise(() => d.decrypt(armor.decode(armored), "text"), "decrypting secrets");
  });

export const encryptFor = (recipients: ReadonlyArray<string>, plaintext: string) =>
  Effect.gen(function* () {
    if (recipients.length === 0) return yield* new SecretsError({ message: "no recipients: add a node key first" });
    const e = new Encrypter();
    for (const r of recipients) e.addRecipient(r);
    return armor.encode(yield* promise(() => e.encrypt(plaintext), "encrypting secrets"));
  });

/** The repo's secrets as plaintext, decrypted with this node's key ("" when there are none yet). */
export const readSecrets = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const armored = yield* fs.readFileString(encryptedPath(repo)).pipe(Effect.option);
    if (Option.isNone(armored)) return "";
    const { identity } = yield* ensureIdentity;
    return yield* decryptWith(identity, armored.value);
  });

/** Re-encrypt `plaintext` to every recipient and write it into the repo. */
export const writeSecrets = (repo: string, plaintext: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const recipients = Object.values(yield* readRecipients(repo));
    const armored = yield* encryptFor(recipients, plaintext);
    yield* fs.makeDirectory(`${repo}/secrets`, { recursive: true }).pipe(Effect.ignore);
    yield* fs.writeFileString(encryptedPath(repo), armored);
  });

/** Decrypt the repo's secrets onto this node, where fixes and templates read them. */
export const installSecrets = (repo: string) =>
  Effect.gen(function* () {
    const home = process.env["HOME"] ?? "";
    const plaintext = yield* readSecrets(repo);
    yield* writePrivate(localSecretsPath(home), plaintext);
    return plaintext.split("\n").filter((l) => /^\s*[A-Z_][A-Z0-9_]*=/.test(l)).length;
  });

/** Parse and edit dotenv text, keeping comments and order. */
export const setVar = (text: string, key: string, value: string | null) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${key}=`).test(l));
  const quoted = value === null ? null : /^[A-Za-z0-9_./:@+-]*$/.test(value) ? value : `"${value.replace(/["\\$`]/g, "\\$&")}"`;
  if (quoted === null) {
    if (at >= 0) lines.splice(at, 1);
  } else if (at >= 0) lines[at] = `${key}=${quoted}`;
  else {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(`${key}=${quoted}`, "");
  }
  return lines.join("\n");
};

export const varNames = (text: string) =>
  text
    .split("\n")
    .map((l) => /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=/.exec(l)?.[1])
    .filter((k): k is string => k !== undefined);
