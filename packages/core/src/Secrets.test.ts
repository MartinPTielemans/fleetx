// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { describe, expect, it } from "vite-plus/test";

import {
  addRecipient,
  encryptedFor,
  encryptedPath,
  ensureIdentity,
  recipientSet,
  recipientsPath,
  readSecrets,
  writeRecipients,
  writeSecrets,
} from "./Secrets.ts";

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

describe("letting a node read the secrets", () => {
  it("re-encrypts once, not again while the node has yet to pull", async () => {
    const home = mkdtempSync(join(tmpdir(), "t3f-secrets-"));
    process.env["HOME"] = home;
    const repo = join(home, "fleet");
    const { recipient: own } = await run(ensureIdentity);
    await run(writeRecipients(repo, { box: own }));
    await run(writeSecrets(repo, "A=1\n"));
    const laptop = await identityToRecipient(await generateX25519Identity());

    expect(await run(addRecipient(repo, "laptop", laptop))).toBe(true);
    const encrypted = readFileSync(encryptedPath(repo), "utf8");
    // The next authority sync runs the same fix again: nothing changes.
    expect(await run(addRecipient(repo, "laptop", laptop))).toBe(false);
    expect(readFileSync(encryptedPath(repo), "utf8")).toBe(encrypted);
    expect(await run(readSecrets(repo))).toBe("A=1\n");

    // A new key for the node is a change.
    const fresh = await identityToRecipient(await generateX25519Identity());
    expect(await run(addRecipient(repo, "laptop", fresh))).toBe(true);
  });

  it("re-encrypts when the key is listed but the file was not encrypted to that set", async () => {
    const home = mkdtempSync(join(tmpdir(), "t3f-secrets-"));
    process.env["HOME"] = home;
    const repo = join(home, "fleet");
    const { recipient: own } = await run(ensureIdentity);
    await run(writeRecipients(repo, { box: own }));
    await run(writeSecrets(repo, "A=1\n"));
    const laptop = await identityToRecipient(await generateX25519Identity());
    // Listed by hand, never re-encrypted.
    await run(writeRecipients(repo, { box: own, laptop }));
    expect(await run(addRecipient(repo, "laptop", laptop))).toBe(true);
    expect(await run(addRecipient(repo, "laptop", laptop))).toBe(false);
  });

  it("tells whose stanzas they are: same count, different keys, re-encrypts", async () => {
    const home = mkdtempSync(join(tmpdir(), "t3f-secrets-"));
    process.env["HOME"] = home;
    const repo = join(home, "fleet");
    const { recipient: own } = await run(ensureIdentity);
    const departed = await identityToRecipient(await generateX25519Identity());
    await run(writeRecipients(repo, { box: own, old: departed }));
    await run(writeSecrets(repo, "A=1\n"));
    // A node leaves without re-encrypting (its secrets could not be read), and another joins:
    // two keys listed, two stanzas, but not the same two.
    const laptop = await identityToRecipient(await generateX25519Identity());
    await run(writeRecipients(repo, { box: own, laptop }));
    expect(await run(addRecipient(repo, "laptop", laptop))).toBe(true);
    expect(await run(encryptedFor(repo))).toBe(await run(recipientSet([own, laptop])));
  });

  it("encrypts before it lists: a crash between the two never claims the file is readable", async () => {
    const home = mkdtempSync(join(tmpdir(), "t3f-secrets-"));
    process.env["HOME"] = home;
    const repo = join(home, "fleet");
    const { recipient: own } = await run(ensureIdentity);
    await run(writeRecipients(repo, { box: own }));
    await run(writeSecrets(repo, "A=1\n"));
    const recorded = await run(encryptedFor(repo));
    const laptop = await identityToRecipient(await generateX25519Identity());
    // Listing alone keeps the set the file was encrypted to.
    await run(writeRecipients(repo, { box: own, laptop }));
    expect(await run(encryptedFor(repo))).toBe(recorded);
    expect(readFileSync(recipientsPath(repo), "utf8")).toContain(`laptop = "${laptop}"`);
  });
});
