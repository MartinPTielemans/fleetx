// Real git repositories in a temp directory; the effects under test run with Node's services.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { addSkills, keepUpdate, listSkills, previewUpdate, skillDescription } from "./SkillSources.ts";

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const fails = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) => Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(NodeServices.layer)));
const git = (cwd: string, ...args: Array<string>) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });

describe("skillDescription", () => {
  it("reads a one-line description from the front matter", () => {
    expect(skillDescription("---\nname: a\ndescription: Reviews a diff\n---\nbody")).toBe("Reviews a diff");
    expect(skillDescription('---\ndescription: "Quoted: yes"\n---\n')).toBe("Quoted: yes");
    expect(skillDescription("---\ndescription: >\n  folded\n---\n")).toBeNull();
    expect(skillDescription("no front matter\ndescription: nope")).toBeNull();
  });
});

describe("updating vendored skills", () => {
  const root = mkdtempSync(join(tmpdir(), "fleetx-skills-"));
  const source = join(root, "upstream");
  const repo = join(root, "fleet");
  const skill = (text: string) => writeFileSync(join(source, "review", "SKILL.md"), `---\ndescription: Reviews\n---\n${text}\n`);

  beforeAll(async () => {
    // The scratch clone lives under $HOME.
    process.env["HOME"] = root;
    mkdirSync(join(source, "review"), { recursive: true });
    skill("v1");
    git(root, "init", "-q", "upstream");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "v1");
    mkdirSync(join(repo, "skills"), { recursive: true });
    git(root, "init", "-q", "fleet");
    await run(addSkills(repo, source, ["review"]));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "add review");
  });

  it("lists the repo's skills with their source", async () => {
    expect(await run(listSkills(repo))).toEqual([{ name: "review", description: "Reviews", source: { name: "upstream", url: source } }]);
  });

  it("previews an upstream change and leaves the repo as it was", async () => {
    expect((await run(previewUpdate(repo, []))).digest).toBe("");
    skill("v2");
    writeFileSync(join(source, "review", "NEW.md"), "new file\n");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "v2");

    const preview = await run(previewUpdate(repo, ["review"]));
    expect(preview.files).toEqual(["skills/review"]);
    expect(preview.diff).toContain("+v2");
    expect(preview.diff).toContain("NEW.md");
    expect(git(repo, "status", "--porcelain")).toBe("");

    expect(await fails(keepUpdate(repo, ["review"], "not-the-digest"))).toBe("upstream changed since the preview; preview again");
    expect(git(repo, "status", "--porcelain")).toBe("");

    expect(await run(keepUpdate(repo, ["review"], preview.digest))).toEqual(["skills/review"]);
    expect(readFileSync(join(repo, "skills", "review", "SKILL.md"), "utf8")).toContain("v2");
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    expect(git(repo, "status", "--porcelain")).not.toBe("");
  });

  it("refuses to preview over edits of the skill's own", async () => {
    expect(await fails(previewUpdate(repo, ["review"]))).toContain("changes not yet committed or proposed");
    expect(readFileSync(join(repo, "skills", "review", "SKILL.md"), "utf8")).toContain("v2");
  });
});
