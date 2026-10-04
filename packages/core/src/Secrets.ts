/**
 * Secrets: one dotenv file, encrypted with age to every node's key and kept
 * in the config repo.
 *
 *   secrets/secrets.env.age      armored age file (in git)
 *   secrets/recipients.toml      node = "age1…" public keys (in git), and in a
 *                                comment the hash of the keys secrets.env.age
 *                                was last encrypted to
 *   ~/.config/t3-fleet/age-key.txt this node's private key (never leaves it)
 *   ~/.config/t3-fleet/secrets.env decrypted, mode 600, what fixes and
 *                                templates read
 *
 * Encryption uses age-encryption, so nodes need no age binary. Writing into
 * the repo holds the sync lock; a caller that commits afterwards should hold
 * it around both.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  armor,
  Decrypter,
  Encrypter,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { commitAndPush } from "./Git.ts";
import { sha256 } from "./Hash.ts";
import { configDir } from "./Names.ts";
import { underSyncLock } from "./SyncLock.ts";

export class SecretsError extends Schema.TaggedError<SecretsError>()("SecretsError", {
  message: Schema.String,
}) {}

export const keyPath = (home: string) => `${configDir(home)}/age-key.txt`;
export const localSecretsPath = (home: string) => `${configDir(home)}/secrets.env`;
export const encryptedPath = (repo: string) => `${repo}/secrets/secrets.env.age`;
export const recipientsPath = (repo: string) => `${repo}/secrets/recipients.toml`;

const promise = <A>(f: () => Promise<A>, what: string) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new SecretsError({ message: `${what}: ${String(cause)}` }),
  });

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
  if (identity !== "")
    return {
      identity,
      recipient: yield* promise(() => identityToRecipient(identity), "reading key"),
      created: false,
    };
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

const ENCRYPTED_FOR = "# encrypted-for: ";

/**
 * What re-encrypting writes, relative to the repo: the secrets, and the
 * recipients with the set they were encrypted to. Every change commits both,
 * in one commit: recipients.toml alone left behind is a dirty fleet file.
 */
export const SECRETS_FILES = ["secrets/secrets.env.age", "secrets/recipients.toml"] as const;
export const RECIPIENTS_FILE = "secrets/recipients.toml";

/** The set of keys, whoever holds them: SHA-256 of the distinct keys, sorted. */
export const recipientSet = (keys: ReadonlyArray<string>) =>
  Effect.promise(() => sha256([...new Set(keys)].sort().join("\n")));

/** The recipient set secrets.env.age was last encrypted to, as recipients.toml records it. */
export const encryptedFor = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(recipientsPath(repo)).pipe(Effect.option);
    if (Option.isNone(text)) return null;
    const line = text.value.split("\n").find((l) => l.startsWith(ENCRYPTED_FOR));
    return line === undefined ? null : line.slice(ENCRYPTED_FOR.length).trim();
  });

/**
 * Write the recipients. `encrypted` is the recipient set the secrets were
 * just encrypted to; without it the recorded one is kept, so listing a key
 * without re-encrypting never claims the file is readable by it.
 */
export const writeRecipients = (
  repo: string,
  recipients: Record<string, string>,
  encrypted?: string,
) =>
  underSyncLock(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const recorded = encrypted ?? (yield* encryptedFor(repo));
      yield* fs.makeDirectory(`${repo}/secrets`, { recursive: true }).pipe(Effect.ignore);
      const sorted = Object.fromEntries(
        Object.entries(recipients).sort(([a], [b]) => a.localeCompare(b)),
      );
      yield* fs.writeFileString(
        recipientsPath(repo),
        [
          "# Public age keys of the nodes that can read secrets.env.age.",
          ...(recorded === null ? [] : [`${ENCRYPTED_FOR}${recorded}`]),
          stringifyToml(sorted),
          "",
        ].join("\n"),
      );
      return [RECIPIENTS_FILE] as ReadonlyArray<string>;
    }),
  );

export const decryptWith = (identity: string, armored: string) =>
  Effect.gen(function* () {
    const d = new Decrypter();
    d.addIdentity(identity);
    return yield* promise(() => d.decrypt(armor.decode(armored), "text"), "decrypting secrets");
  });

export const encryptFor = (recipients: ReadonlyArray<string>, plaintext: string) =>
  Effect.gen(function* () {
    if (recipients.length === 0)
      return yield* new SecretsError({ message: "no recipients: add a node key first" });
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

/**
 * Encrypt `plaintext` to `recipients` (by default those listed) and write it
 * into the repo, then the recipients with the set it was encrypted to. In
 * that order: a crash between the two leaves a recorded set that matches
 * neither, and the next change re-encrypts.
 */
export const writeSecrets = (
  repo: string,
  plaintext: string,
  recipients?: Record<string, string>,
) =>
  underSyncLock(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const to = recipients ?? (yield* readRecipients(repo));
      const armored = yield* encryptFor(Object.values(to), plaintext);
      yield* fs.makeDirectory(`${repo}/secrets`, { recursive: true }).pipe(Effect.ignore);
      yield* fs.writeFileString(encryptedPath(repo), armored);
      yield* writeRecipients(repo, to, yield* recipientSet(Object.values(to)));
      return SECRETS_FILES as ReadonlyArray<string>;
    }),
  );

/**
 * Change the secrets on an authority: encrypt `plaintext`, install it here,
 * and commit and push what that wrote (SECRETS_FILES) with `message`.
 */
export const storeSecrets = (repo: string, plaintext: string, message: string) =>
  underSyncLock(
    Effect.gen(function* () {
      const files = yield* writeSecrets(repo, plaintext);
      yield* installSecrets(repo);
      return yield* commitAndPush(repo, files, message);
    }),
  );

/**
 * Let `node` read the secrets: list its key and re-encrypt to every key.
 * Nothing changes (false) when that key is listed and the secrets were last
 * encrypted to exactly the listed keys: re-encrypting again would only
 * commit the same secrets anew.
 */
export const addRecipient = (repo: string, node: string, recipient: string) =>
  underSyncLock(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const recipients = yield* readRecipients(repo);
      const exists = yield* fs.exists(encryptedPath(repo)).pipe(Effect.orElseSucceed(() => false));
      if (
        recipients[node] === recipient &&
        exists &&
        (yield* encryptedFor(repo)) === (yield* recipientSet(Object.values(recipients)))
      )
        return false;
      const text = yield* readSecrets(repo);
      yield* writeSecrets(repo, text, { ...recipients, [node]: recipient });
      return true;
    }),
  );

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
  const quoted =
    value === null
      ? null
      : /^[A-Za-z0-9_./:@+-]*$/.test(value)
        ? value
        : `"${value.replace(/["\\$`]/g, "\\$&")}"`;
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
