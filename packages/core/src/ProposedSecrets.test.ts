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

import { pullBranch } from "./Git.ts";
import { mergeProposedSecrets, sortProposed } from "./ProposedSecrets.ts";
import {
  encryptFor,
  ensureIdentity,
  readSecrets,
  writeRecipients,
  writeSecrets,
} from "./Secrets.ts";
import { approve, listProposals, reject, settleRejection } from "./Staging.ts";

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

/** An authority's checkout and a member's, of a fresh origin holding `fleet` as t3-fleet.toml. */
const twoMachines = async (name: string, fleet: string) => {
  const root = join(home, name);
  const origin = join(root, "origin.git");
  git(home, "init", "-q", "--bare", "-b", "main", origin);
  const authority = join(root, "authority");
  git(home, "clone", "-q", origin, authority);
  const { recipient } = await run(ensureIdentity);
  fs.writeFileSync(join(authority, "t3-fleet.toml"), fleet);
  await run(writeRecipients(authority, { laptop: recipient }));
  await run(writeSecrets(authority, "A=1\n"));
  git(authority, "add", "-A");
  git(authority, "commit", "-qm", "start");
  git(authority, "push", "-q", "-u", "origin", "main");
  const member = join(root, "member");
  git(home, "clone", "-q", origin, member);
  return { origin, authority, member };
};
/** The member's proposal: its edits, committed on t3-fleet/staging/member. */
const proposeFrom = (member: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(join(member, file, ".."), { recursive: true });
    fs.writeFileSync(join(member, file), text);
  }
  git(member, "add", "-A");
  git(member, "commit", "-qm", "Proposed by member");
  git(member, "push", "-q", "origin", "HEAD:refs/heads/t3-fleet/staging/member");
  git(member, "reset", "-q", "--soft", "HEAD~1");
  git(member, "reset", "-q");
};
const proposalOf = async (repo: string) => {
  const [p] = await run(listProposals(repo, "main"));
  if (p === undefined) throw new Error("no proposal");
  return p;
};

describe("approve", () => {
  const FLEET = '[fleet]\nauto_approve = []\ninterval = 900\n\n[models]\negress = "direct"\n';

  it("refuses a merge that is more than list additions, and the recovery it names works", async () => {
    const f = await twoMachines("removal", FLEET);
    // The member removes [models] and adds z = 3; main changes the line next to it meanwhile.
    proposeFrom(f.member, {
      "t3-fleet.toml": "[fleet]\nauto_approve = []\ninterval = 900\nz = 3\n",
    });
    fs.writeFileSync(join(f.authority, "t3-fleet.toml"), FLEET.replace("900", "600"));
    git(f.authority, "commit", "-qam", "interval");
    git(f.authority, "push", "-q");
    const refused = await run(
      Effect.flip(approve(f.authority, "main", await proposalOf(f.authority), "laptop")),
    );
    expect(refused).toContain("t3-fleet reject member");
    expect(git(f.origin, "show", "main:t3-fleet.toml")).toContain("[models]");
    expect(git(f.origin, "show", "main:t3-fleet.toml")).not.toContain("z = 3");
    // Rejected, the member's next sync sets its edit aside, and its pull goes through.
    await run(reject(f.authority, await proposalOf(f.authority)));
    expect(await run(settleRejection(f.member, "member", "main"))).toEqual(["t3-fleet.toml"]);
    expect(await run(pullBranch(f.member, "main", "ff-only"))).toBe(1);
  });

  it("refuses a proposal carrying another machine's secrets, and reports what its own merge did", async () => {
    const f = await twoMachines("secrets", FLEET);
    const stranger = await identityToRecipient(await generateX25519Identity());
    proposeFrom(f.member, {
      "secrets-proposed/other.env.age": await run(encryptFor([stranger], "X=1\n")),
    });
    expect(
      await run(Effect.flip(approve(f.authority, "main", await proposalOf(f.authority), "laptop"))),
    ).toContain("secrets that are not its own");

    const g = await twoMachines("unreadable", FLEET);
    proposeFrom(g.member, {
      "secrets-proposed/member.env.age": await run(encryptFor([stranger], "X=1\n")),
    });
    const { notes } = await run(
      approve(g.authority, "main", await proposalOf(g.authority), "laptop"),
    );
    expect(notes.join("\n")).toContain("could not decrypt secrets-proposed/member.env.age");
  });
});
