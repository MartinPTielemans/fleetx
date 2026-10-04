// A temporary home with this machine's key, and a fleet repo with a bare origin.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { mergeProposedSecrets, sortProposed } from "./ProposedSecrets.ts";
import {
  encryptFor,
  ensureIdentity,
  readSecrets,
  writeRecipients,
  writeSecrets,
} from "./Secrets.ts";

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

const home = fs.mkdtempSync(join(tmpdir(), "t3-fleet-proposed-"));
const repo = join(home, "fleet");
const realHome = process.env["HOME"];
beforeAll(() => {
  process.env["HOME"] = home;
});
afterAll(() => {
  process.env["HOME"] = realHome;
});

describe("sortProposed", () => {
  it("takes only names the fleet uses, never unsafe ones, never over another value", () => {
    const { take, refused } = sortProposed(
      new Map([
        ["NOTES_KEY", "n"],
        ["FLEET_A", "other"],
        ["NODE_OPTIONS", "--require=/tmp/x.js"],
        ["UNUSED", "u"],
        ["PEM", "a\nb"],
      ]),
      new Map([["FLEET_A", "1"]]),
      new Set(["NOTES_KEY", "FLEET_A", "NODE_OPTIONS", "PEM"]),
    );
    expect(take).toEqual(["NOTES_KEY"]);
    expect(refused.join("; ")).toMatch(
      /FLEET_A .*another value.*NODE_OPTIONS .*how programs run.*UNUSED .*nothing in the fleet uses it.*PEM .*several lines/,
    );
  });
});

describe("mergeProposedSecrets", () => {
  it("merges what it may, file by file, and leaves a file it cannot read for another authority", async () => {
    const origin = join(home, "origin.git");
    git(home, "init", "-q", "--bare", "-b", "main", origin);
    git(home, "clone", "-q", origin, repo);
    const { recipient } = await run(ensureIdentity);
    fs.mkdirSync(join(repo, "mcp"));
    fs.writeFileSync(
      join(repo, "mcp/notes.json"),
      JSON.stringify({ kind: "direct", url: "https://n", headers: { "X-Key": "$NOTES_KEY" } }),
    );
    fs.writeFileSync(join(repo, "t3-fleet.toml"), "[fleet]\n");
    await run(writeRecipients(repo, { laptop: recipient }));
    await run(writeSecrets(repo, "FLEET_A=1\n"));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "start");
    git(repo, "push", "-q", "-u", "origin", "main");

    fs.mkdirSync(join(repo, "secrets-proposed"));
    const proposed = await run(
      encryptFor([recipient], "NOTES_KEY=n-value\nFLEET_A=other\nNODE_OPTIONS=--x\n"),
    );
    fs.writeFileSync(join(repo, "secrets-proposed/desktop.env.age"), proposed);
    const stranger = await identityToRecipient(await generateX25519Identity());
    fs.writeFileSync(
      join(repo, "secrets-proposed/server.env.age"),
      await run(encryptFor([stranger], "X=1\n")),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "proposals");
    git(repo, "push", "-q");

    const lines = await run(mergeProposedSecrets(repo));
    expect(lines.join("\n")).toContain("could not decrypt secrets-proposed/server.env.age");
    expect(lines.join("\n")).toMatch(
      /desktop's secrets: merged NOTES_KEY; refused FLEET_A .*NODE_OPTIONS/,
    );
    const secrets = await run(readSecrets(repo));
    expect(secrets).toContain("NOTES_KEY=n-value");
    expect(secrets).toContain("FLEET_A=1");
    expect(secrets).not.toContain("NODE_OPTIONS");
    expect(fs.existsSync(join(repo, "secrets-proposed/desktop.env.age"))).toBe(false);
    expect(fs.existsSync(join(repo, "secrets-proposed/server.env.age"))).toBe(true);
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("Merge proposed secrets");
  });
});
