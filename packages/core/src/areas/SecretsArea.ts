/**
 * Whether each node can read the fleet's secrets, and has the current ones.
 *
 * The node's key is created on the node (`fleetx secrets init`) and only its
 * public half leaves it. An authority then adds that public key to the repo
 * and re-encrypts (`fleetx secrets add-node`), and the node decrypts its copy
 * (`fleetx secrets install`). Each step is a fix on the node that can take it.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { armor, Decrypter, identityToRecipient } from "age-encryption";
import { parse as parseToml } from "smol-toml";

import { defineArea, sh } from "../Area.ts";
import type { Finding } from "../Diagnose.ts";
import { encryptedPath, keyPath, localSecretsPath, recipientsPath } from "../Secrets.ts";

const Observed = Schema.Struct({
  /** This node's public key, when it has a key. */
  recipient: Schema.NullOr(Schema.String),
  /** Whether the repo has an encrypted secrets file. */
  encrypted: Schema.Boolean,
  /** Node names whose keys the repo lists. */
  listed: Schema.Array(Schema.String),
  /** Whether this node's key is one of them. */
  isRecipient: Schema.Boolean,
  /** The decrypted repo file equals the node's installed copy; null if not decryptable. */
  current: Schema.NullOr(Schema.Boolean),
  error: Schema.NullOr(Schema.String),
});

export const SecretsArea = defineArea({
  id: "secrets",
  description: "every node can read the fleet's secrets and has the current ones",
  desired: Schema.Unknown,
  observed: Observed,
  observe: (_desired, ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const read = (p: string) => fs.readFileString(p).pipe(Effect.option);
      const keyText = yield* read(keyPath(ctx.home));
      const identity = Option.isSome(keyText) ? keyText.value.split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-")) ?? null : null;
      const recipient = identity === null ? null : yield* Effect.tryPromise(() => identityToRecipient(identity)).pipe(Effect.orElseSucceed(() => null));
      const recipientsText = yield* read(recipientsPath(ctx.checkout));
      const listedMap: Record<string, unknown> = Option.isSome(recipientsText)
        ? yield* Effect.try(() => parseToml(recipientsText.value) as Record<string, unknown>).pipe(Effect.orElseSucceed(() => ({})))
        : {};
      const listed = Object.keys(listedMap).sort();
      const isRecipient = recipient !== null && Object.values(listedMap).includes(recipient);
      const armored = yield* read(encryptedPath(ctx.checkout));
      let current: boolean | null = null;
      let error: string | null = null;
      if (Option.isSome(armored) && identity !== null && isRecipient) {
        const plain = yield* Effect.tryPromise(() => {
          const d = new Decrypter();
          d.addIdentity(identity);
          return d.decrypt(armor.decode(armored.value), "text");
        }).pipe(Effect.result);
        if (plain._tag === "Failure") error = "cannot decrypt secrets.env.age with this node's key";
        else {
          const installed = yield* read(localSecretsPath(ctx.home));
          current = Option.isSome(installed) && installed.value === plain.success;
        }
      }
      return { recipient, encrypted: Option.isSome(armored), listed, isRecipient, current, error };
    }),
  diagnose: ({ node, observed, authority }) => {
    const out: Array<Finding> = [];
    const base = { node, area: "secrets" as const };
    if (!observed.encrypted) return out;
    if (observed.recipient === null) {
      out.push({ ...base, key: "secrets-no-key", severity: "warn", title: "this machine has no key for the fleet's secrets", fix: { command: "fleetx secrets init", safe: true } });
      return out;
    }
    if (!observed.isRecipient) {
      // Only an authority can re-encrypt; the fix runs on one.
      out.push({
        ...base,
        key: "secrets-not-recipient",
        severity: "warn",
        title: "this machine's key is not among the secrets' recipients, so it cannot read them",
        ...(authority === null
          ? { detail: `no node has the authority role to add it: fleetx secrets add-node ${node} ${observed.recipient}` }
          : { fix: { command: `fleetx secrets add-node ${sh(node)} ${sh(observed.recipient)}`, safe: true, on: authority } }),
      });
      return out;
    }
    if (observed.error !== null) out.push({ ...base, key: "secrets-unreadable", severity: "error", title: observed.error });
    else if (observed.current === false) {
      out.push({ ...base, key: "secrets-stale", severity: "warn", title: "this machine's installed secrets are out of date", fix: { command: "fleetx secrets install", safe: true } });
    }
    return out;
  },
});

