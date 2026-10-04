// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  lastProposalPath,
  permissionProblems,
  PROPOSAL_REF,
  proposalTrailer,
  restoreDropped,
  settleApproval,
  unmergedStep,
} from "./Approved.ts";
import { pullBranch } from "./Git.ts";

// Real repositories in a temporary home: an origin, the authority's checkout and a member's.
const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

const home = fs.mkdtempSync(join(tmpdir(), "t3-fleet-approved-"));
const realHome = process.env["HOME"];
beforeAll(() => {
  process.env["HOME"] = home;
});
afterAll(() => {
  process.env["HOME"] = realHome;
});

const FLEET = '[defaults.mcp]\nservers = ["fetch"]\n';
const servers = (...names: Array<string>) =>
  FLEET.replace('["fetch"]', JSON.stringify(["fetch", ...names]).replaceAll(",", ", "));
type Files = Record<string, string | { readonly text: string; readonly mode: number }>;
const write = (repo: string, files: Files) => {
  for (const [file, value] of Object.entries(files)) {
    const { text, mode } = typeof value === "string" ? { text: value, mode: 0o644 } : value;
    fs.mkdirSync(join(repo, file, ".."), { recursive: true });
    fs.writeFileSync(join(repo, file), text);
    fs.chmodSync(join(repo, file), mode);
  }
};
const commitOn = (repo: string, files: Files, message: string) => {
  write(repo, files);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);
  git(repo, "push", "-q", "origin", "HEAD:main");
};

/** origin with one commit, the authority's clone and the member's. */
const fleet = (name: string, files: Files = { "t3-fleet.toml": FLEET }) => {
  const root = join(home, name);
  const origin = join(root, "origin.git");
  git(home, "init", "-q", "--bare", "-b", "main", origin);
  const authority = join(root, "authority");
  git(home, "clone", "-q", origin, authority);
  commitOn(authority, files, "start");
  const member = join(root, "member");
  git(home, "clone", "-q", origin, member);
  return { authority, member };
};
/** The member proposes `files` as Sync does: a commit on its HEAD, recorded and kept by a ref; its copies stay. */
const propose = (member: string, files: Files) => {
  write(member, files);
  git(member, "add", "-A");
  const tree = git(member, "write-tree");
  const proposal = git(member, "commit-tree", tree, "-p", "HEAD", "-m", "Proposed by member");
  git(member, "reset", "-q");
  git(member, "update-ref", PROPOSAL_REF, proposal);
  fs.mkdirSync(join(lastProposalPath(home), ".."), { recursive: true });
  fs.writeFileSync(lastProposalPath(home), `${proposal}\n`);
  return proposal;
};
/** The authority approves `proposal`, landing `files` (merged, perhaps) with the trailer naming it. */
const approveWith = (authority: string, proposal: string, files: Files) =>
  commitOn(
    authority,
    files,
    `Approve member's proposal (by authority)\n\n${Object.keys(files).join("\n")}\n\n${proposalTrailer(proposal)}`,
  );
/** Settle, pull as Sync does with one fetch, and put dropped files back when the pull fails. */
const settle = async (member: string, exclude: ReadonlySet<string> = new Set()) => {
  git(member, "fetch", "-q", "origin", "main");
  const how =
    git(member, "rev-list", "--count", "origin/main..HEAD") === "0" ? "ff-only" : "rebase";
  const settled = await run(settleApproval(member, "member", "main", { exclude, how }));
  const pulled = await run(Effect.result(pullBranch(member, "main", how, { fetched: true })));
  if (pulled._tag === "Failure") await run(restoreDropped(member, settled));
  return { settled, pulled };
};
const read = (repo: string, file: string) => fs.readFileSync(join(repo, file), "utf8");
/** The step's commands, run as printed (chmod, then the stash), where git has no identity of its own. */
const runStep = (step: string) => {
  const commands = [...step.matchAll(/`((?:chmod|git -C) [^`]+)`/g)]
    .map((m) => m[1] ?? "")
    .filter((c) => !c.includes("stash show"));
  expect(commands.some((c) => c.includes("stash push -u -m t3-fleet"))).toBe(true);
  for (const command of commands)
    execFileSync("sh", ["-c", command], {
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.useConfigOnly",
        GIT_CONFIG_VALUE_0: "true",
      },
    });
};
const modeOf = (repo: string, file: string) => fs.statSync(join(repo, file)).mode & 0o777;
/** Everything a member's checkout holds, for "exactly as it was". */
const snapshot = (repo: string) =>
  JSON.stringify({
    head: git(repo, "rev-parse", "HEAD"),
    status: git(repo, "status", "--porcelain", "-uall"),
    files: git(repo, "ls-files", "-co", "--exclude-standard")
      .split("\n")
      .filter((f) => f !== "" && fs.existsSync(join(repo, f)))
      .map((f) => [f, read(repo, f), modeOf(repo, f)]),
  });

describe("settleApproval", () => {
  it("drops a copy exactly as its approved proposal had it; the pull brings the merged version", async () => {
    const f = fleet("approved");
    commitOn(f.authority, { "t3-fleet.toml": servers("posthog") }, "x");
    const p = propose(f.member, { "t3-fleet.toml": servers("notes") });
    approveWith(f.authority, p, { "t3-fleet.toml": servers("posthog", "notes") });
    const { settled, pulled } = await settle(f.member);
    expect(settled.dropped).toEqual(["t3-fleet.toml"]);
    expect(pulled._tag).toBe("Success");
    expect(read(f.member, "t3-fleet.toml")).toBe(servers("posthog", "notes"));
    expect(git(f.member, "status", "--porcelain")).toBe("");
    expect(git(f.member, "stash", "list")).toBe("");
    expect(fs.existsSync(join(home, ".local/state/t3-fleet/approved"))).toBe(false);
  });

  it("drops a proposed file the branch approved and then removed again (merged secrets)", async () => {
    const f = fleet("removed");
    const p = propose(f.member, { "secrets-proposed/member.env.age": "-----BEGIN AGE-----\n" });
    approveWith(f.authority, p, { "secrets-proposed/member.env.age": "-----BEGIN AGE-----\n" });
    fs.rmSync(join(f.authority, "secrets-proposed"), { recursive: true });
    git(f.authority, "commit", "-qam", "Drop the merged proposed secrets");
    git(f.authority, "push", "-q", "origin", "HEAD:main");
    const { settled, pulled } = await settle(f.member);
    expect(settled.dropped).toEqual(["secrets-proposed/member.env.age"]);
    expect(pulled._tag).toBe("Success");
    expect(git(f.member, "status", "--porcelain", "-uall")).toBe("");
  });

  it("puts a dropped file back from the proposal commit, mode included, when the pull fails", async () => {
    const f = fleet("mode", { "t3-fleet.toml": FLEET, "bin/run.sh": "v1\n", "notes.md": "one\n" });
    const p = propose(f.member, { "bin/run.sh": { text: "#!/bin/sh\necho v2\n", mode: 0o755 } });
    approveWith(f.authority, p, {
      "bin/run.sh": { text: "#!/bin/sh\necho v2, merged\n", mode: 0o755 },
    });
    // Meanwhile an edit here that the branch's change to notes.md overlaps: the pull refuses.
    commitOn(f.authority, { "notes.md": "one, branch\n" }, "notes");
    write(f.member, { "notes.md": "one, mine\n" });
    const before = snapshot(f.member);
    const { settled, pulled } = await settle(f.member);
    expect(settled.dropped).toEqual(["bin/run.sh"]);
    expect(settled.overlapping).toEqual(["notes.md"]);
    expect(pulled._tag).toBe("Failure");
    expect(snapshot(f.member)).toBe(before);
    expect(modeOf(f.member, "bin/run.sh")).toBe(0o755);
  });

  it("never drops a copy whose mode differs from the proposal's", async () => {
    const f = fleet("chmod", { "t3-fleet.toml": FLEET, "bin/run.sh": "v1\n" });
    const p = propose(f.member, { "bin/run.sh": { text: "v2\n", mode: 0o755 } });
    approveWith(f.authority, p, { "bin/run.sh": { text: "v2, merged\n", mode: 0o755 } });
    fs.chmodSync(join(f.member, "bin/run.sh"), 0o644);
    const before = snapshot(f.member);
    const { settled, pulled } = await settle(f.member);
    expect(settled).toMatchObject({ dropped: [], overlapping: ["bin/run.sh"] });
    expect(pulled._tag).toBe("Failure");
    expect(snapshot(f.member)).toBe(before);
  });

  it("touches nothing on a member with commits of its own", async () => {
    const f = fleet("local-commit", { "t3-fleet.toml": FLEET, "README.md": "fleet\n" });
    const p = propose(f.member, { "t3-fleet.toml": servers("notes") });
    approveWith(f.authority, p, { "t3-fleet.toml": servers("posthog", "notes") });
    write(f.member, { "README.md": "fleet, mine\n" });
    git(f.member, "commit", "-qm", "mine", "--", "README.md");
    const before = snapshot(f.member);
    const { settled, pulled } = await settle(f.member);
    expect(settled).toMatchObject({ dropped: [], overlapping: ["t3-fleet.toml"] });
    expect(pulled._tag).toBe("Failure");
    expect(snapshot(f.member)).toBe(before);
    expect(git(f.member, "log", "-1", "--format=%s")).toBe("mine");
  });

  it.skipIf(process.getuid?.() === 0)(
    "settling that fails part-way puts back what it dropped, names every file, and its step works",
    async () => {
      const f = fleet("midway", { "a.toml": "a = 1\n", "z/b.toml": "b = 1\n" });
      const p = propose(f.member, { "a.toml": "a = 2\n", "z/b.toml": "b = 2\n" });
      approveWith(f.authority, p, { "a.toml": "a = 2\nm = 1\n", "z/b.toml": "b = 2\nm = 1\n" });
      git(f.member, "fetch", "-q", "origin", "main");
      const before = snapshot(f.member);
      // z/ cannot be written: putting z/b.toml back to HEAD fails after a.toml was dropped.
      fs.chmodSync(join(f.member, "z"), 0o555);
      try {
        const { settled, pulled } = await settle(f.member);
        expect(settled.failure).toContain("z/b.toml");
        expect(settled).toMatchObject({ dropped: [], overlapping: ["a.toml", "z/b.toml"] });
        expect(pulled._tag).toBe("Failure");
        expect(snapshot(f.member)).toBe(before);
        const problems = await run(permissionProblems(f.member, settled.overlapping));
        expect(problems).toEqual([expect.stringContaining("z/ cannot be written: `chmod u+w")]);
        runStep(unmergedStep(f.member, settled.overlapping, problems));
      } finally {
        fs.chmodSync(join(f.member, "z"), 0o755);
      }
      expect((await settle(f.member)).pulled._tag).toBe("Success");
      expect(read(f.member, "z/b.toml")).toBe("b = 2\nm = 1\n");
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "names a file git cannot read, and its step works once read permission is back",
    async () => {
      const f = fleet("unreadable", { "t3-fleet.toml": FLEET, "bin/run.sh": "v1\n" });
      commitOn(f.authority, { "bin/run.sh": "v1, branch\n" }, "x");
      write(f.member, { "bin/run.sh": "v1, mine\n" });
      fs.chmodSync(join(f.member, "bin/run.sh"), 0o000);
      try {
        const { settled, pulled } = await settle(f.member);
        expect(settled.overlapping).toEqual(["bin/run.sh"]);
        expect(pulled._tag).toBe("Failure");
        const problems = await run(permissionProblems(f.member, settled.overlapping));
        expect(problems).toEqual([
          expect.stringContaining("bin/run.sh cannot be read: `chmod u+r"),
        ]);
        runStep(unmergedStep(f.member, settled.overlapping, problems));
      } finally {
        if (fs.existsSync(join(f.member, "bin/run.sh")))
          fs.chmodSync(join(f.member, "bin/run.sh"), 0o644);
      }
      expect((await settle(f.member)).pulled._tag).toBe("Success");
      expect(git(f.member, "stash", "show", "-p")).toContain("v1, mine");
    },
  );

  it("an untracked file the branch adds too: its step stashes it, and sync goes on", async () => {
    const f = fleet("untracked");
    commitOn(f.authority, { "skills/new/SKILL.md": "# branch\n" }, "new");
    write(f.member, { "skills/new/SKILL.md": "# mine\n" });
    const { settled, pulled } = await settle(f.member);
    expect(settled.overlapping).toEqual(["skills/new/SKILL.md"]);
    expect(pulled._tag).toBe("Failure");
    runStep(unmergedStep(f.member, settled.overlapping));
    expect((await settle(f.member)).pulled._tag).toBe("Success");
    expect(read(f.member, "skills/new/SKILL.md")).toBe("# branch\n");
    expect(git(f.member, "stash", "show", "-p", "--include-untracked")).toContain("# mine");
  });

  it("a mode changed since the proposal is an edit: left as it is, named", async () => {
    const f = fleet("mode-loss", { "t3-fleet.toml": FLEET, "bin/run.sh": "v1\n" });
    const script = { text: "#!/bin/sh\necho v2\n", mode: 0o755 };
    const p = propose(f.member, { "bin/run.sh": script });
    approveWith(f.authority, p, { "bin/run.sh": script });
    fs.chmodSync(join(f.member, "bin/run.sh"), 0o644);
    const before = snapshot(f.member);
    const { settled, pulled } = await settle(f.member);
    expect(settled).toMatchObject({ dropped: [], overlapping: ["bin/run.sh"] });
    expect(pulled._tag).toBe("Failure");
    expect(snapshot(f.member)).toBe(before);
    expect(modeOf(f.member, "bin/run.sh")).toBe(0o644);
  });

  it("a copy identical to what arrives is put back with its own mode when the move fails", async () => {
    const f = fleet("mode-rollback", { "t3-fleet.toml": FLEET });
    commitOn(f.authority, { "bin/run.sh": { text: "same\n", mode: 0o755 } }, "x");
    write(f.member, { "bin/run.sh": { text: "same\n", mode: 0o755 } });
    // Only the bytes match: a different mode is an edit, and the pull refuses before changing anything.
    commitOn(f.authority, { "bin/other.sh": { text: "same\n", mode: 0o644 } }, "y");
    write(f.member, { "bin/other.sh": { text: "same\n", mode: 0o755 } });
    const before = snapshot(f.member);
    expect((await settle(f.member)).pulled._tag).toBe("Failure");
    expect(snapshot(f.member)).toBe(before);
    // Content and mode the same, and the merge itself refused: back exactly as it was.
    write(f.member, { "bin/other.sh": { text: "same\n", mode: 0o644 } });
    const identical = snapshot(f.member);
    const fake = join(home, "fake-git");
    fs.mkdirSync(fake, { recursive: true });
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(
      join(fake, "git"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = merge ] && { echo refused >&2; exit 1; }; done\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    const path = process.env["PATH"];
    process.env["PATH"] = `${fake}:${path ?? ""}`;
    try {
      expect((await settle(f.member)).pulled._tag).toBe("Failure");
    } finally {
      process.env["PATH"] = path;
    }
    expect(snapshot(f.member)).toBe(identical);
    expect(modeOf(f.member, "bin/run.sh")).toBe(0o755);
  });

  it("reads the approved proposal from the trailer alone, never a line of the message", async () => {
    const f = fleet("forged");
    const p = propose(f.member, { "t3-fleet.toml": servers("notes") });
    commitOn(
      f.authority,
      { "t3-fleet.toml": servers("posthog") },
      `Approve member's proposal (by authority)\n\nskills/x\n${proposalTrailer(p)}\nend.txt\n\n${proposalTrailer("f".repeat(40))}`,
    );
    const before = snapshot(f.member);
    const { settled, pulled } = await settle(f.member);
    expect(settled.dropped).toEqual([]);
    expect(pulled._tag).toBe("Failure");
    expect(snapshot(f.member)).toBe(before);
  });

  it("leaves an edit made after the proposal, and the step it names gets past it", async () => {
    const f = fleet("later");
    const p = propose(f.member, { "t3-fleet.toml": servers("notes") });
    approveWith(f.authority, p, { "t3-fleet.toml": servers("posthog", "notes") });
    write(f.member, { "t3-fleet.toml": servers("notes", "x") });
    const before = snapshot(f.member);
    const { settled, pulled } = await settle(f.member);
    expect(settled).toMatchObject({ dropped: [], overlapping: ["t3-fleet.toml"], pending: [] });
    expect(pulled._tag).toBe("Failure");
    expect(snapshot(f.member)).toBe(before);

    runStep(unmergedStep(f.member, settled.overlapping));
    expect((await settle(f.member)).pulled._tag).toBe("Success");
    expect(read(f.member, "t3-fleet.toml")).toBe(servers("posthog", "notes"));
    expect(git(f.member, "stash", "show", "-p")).toContain('"x"');
  });

  it("leaves a proposal that waits for approval, and says so", async () => {
    const f = fleet("pending");
    propose(f.member, { "t3-fleet.toml": servers("notes") });
    commitOn(f.authority, { "t3-fleet.toml": servers("posthog") }, "x");
    const before = snapshot(f.member);
    const { settled, pulled } = await settle(f.member);
    expect(settled).toMatchObject({ dropped: [], pending: ["t3-fleet.toml"] });
    expect(pulled._tag).toBe("Failure");
    expect(snapshot(f.member)).toBe(before);
  });

  it("never drops what sync holds back, or anything once the proposal commit is gone", async () => {
    const f = fleet("held");
    const p = propose(f.member, { "t3-fleet.toml": servers("notes") });
    approveWith(f.authority, p, { "t3-fleet.toml": servers("posthog", "notes") });
    const held = await settle(f.member, new Set(["t3-fleet.toml"]));
    expect(held.settled.dropped).toEqual([]);
    git(f.member, "update-ref", "-d", PROPOSAL_REF);
    fs.writeFileSync(lastProposalPath(home), `${"0".repeat(40)}\n`);
    const gone = await settle(f.member);
    expect(gone.settled).toMatchObject({ proposal: null, dropped: [] });
    expect(gone.pulled._tag).toBe("Failure");
  });

  it("leaves everything as it was when the pull is refused, identical untracked copies included", async () => {
    const f = fleet("refused");
    commitOn(f.authority, { "instructions/claude/CLAUDE.md": "rules\n" }, "instructions");
    commitOn(f.authority, { "skills/y/SKILL.md": "y, branch\n" }, "y");
    // Not pulled yet: an identical copy of the incoming file, and an edit that overlaps.
    write(f.member, {
      "instructions/claude/CLAUDE.md": "rules\n",
      "skills/y/SKILL.md": "y, mine\n",
    });
    const before = snapshot(f.member);
    const { pulled } = await settle(f.member);
    expect(pulled._tag).toBe("Failure");
    expect(snapshot(f.member)).toBe(before);
  });
});
