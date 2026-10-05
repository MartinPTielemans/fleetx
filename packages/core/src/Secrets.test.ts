// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  SECRETS_FILES,
  storeSecrets,
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
    await run(writeRecipients(repo, { hub: own }));
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
    await run(writeRecipients(repo, { hub: own }));
    await run(writeSecrets(repo, "A=1\n"));
    const laptop = await identityToRecipient(await generateX25519Identity());
    // Listed by hand, never re-encrypted.
    await run(writeRecipients(repo, { hub: own, laptop }));
    expect(await run(addRecipient(repo, "laptop", laptop))).toBe(true);
    expect(await run(addRecipient(repo, "laptop", laptop))).toBe(false);
  });

  it("tells whose stanzas they are: same count, different keys, re-encrypts", async () => {
    const home = mkdtempSync(join(tmpdir(), "t3f-secrets-"));
    process.env["HOME"] = home;
    const repo = join(home, "fleet");
    const { recipient: own } = await run(ensureIdentity);
    const departed = await identityToRecipient(await generateX25519Identity());
    await run(writeRecipients(repo, { hub: own, old: departed }));
    await run(writeSecrets(repo, "A=1\n"));
    // A node leaves without re-encrypting (its secrets could not be read), and another joins:
    // two keys listed, two stanzas, but not the same two.
    const laptop = await identityToRecipient(await generateX25519Identity());
    await run(writeRecipients(repo, { hub: own, laptop }));
    expect(await run(addRecipient(repo, "laptop", laptop))).toBe(true);
    expect(await run(encryptedFor(repo))).toBe(await run(recipientSet([own, laptop])));
  });

  it("encrypts before it lists: a crash between the two never claims the file is readable", async () => {
    const home = mkdtempSync(join(tmpdir(), "t3f-secrets-"));
    process.env["HOME"] = home;
    const repo = join(home, "fleet");
    const { recipient: own } = await run(ensureIdentity);
    await run(writeRecipients(repo, { hub: own }));
    await run(writeSecrets(repo, "A=1\n"));
    const recorded = await run(encryptedFor(repo));
    const laptop = await identityToRecipient(await generateX25519Identity());
    // Listing alone keeps the set the file was encrypted to.
    await run(writeRecipients(repo, { hub: own, laptop }));
    expect(await run(encryptedFor(repo))).toBe(recorded);
    expect(readFileSync(recipientsPath(repo), "utf8")).toContain(`laptop = "${laptop}"`);
  });
});

describe("storing secrets on a fleet whose recipients.toml has no encrypted-for line yet", () => {
  it("commits the recipients with the secrets, in one commit, pushed", async () => {
    const home = mkdtempSync(join(tmpdir(), "t3f-store-"));
    process.env["HOME"] = home;
    const git = (cwd: string, ...args: Array<string>) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd,
        encoding: "utf8",
      });
    const origin = join(home, "origin.git");
    const repo = join(home, "fleet");
    git(home, "init", "-q", "--bare", "-b", "main", origin);
    git(home, "clone", "-q", origin, repo);
    const { recipient } = await run(ensureIdentity);
    await run(writeSecrets(repo, "A=1\n", { a: recipient }));
    // As every fleet made before the line existed has it.
    writeFileSync(
      recipientsPath(repo),
      readFileSync(recipientsPath(repo), "utf8").replace(/^# encrypted-for: .*\n/m, ""),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "legacy");
    git(repo, "push", "-q", "-u", "origin", "main");

    // What `hub token create` does on an authority.
    const rev = await run(storeSecrets(repo, "A=1\nT3_FLEET_HUB_TOKEN_X=t\n", "Set secret X"));
    expect(rev).not.toBe("nothing to commit");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").trim().split("\n")).toEqual(
      [...SECRETS_FILES].sort(),
    );
    expect(git(origin, "show", "main:secrets/recipients.toml")).toContain("# encrypted-for: ");
  });
});
