// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { describe, expect, it } from "vite-plus/test";

import { SkillsArea } from "./Skills.ts";

/** The skills area reads only files; any request it made would fail here. */
const services = Layer.mergeAll(NodeServices.layer, Layer.succeed(HttpClient.HttpClient)(HttpClient.make(() => Effect.die("no network in this test"))));

const skill = (dir: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: foo\n---\n${text}\n`);
};

describe("skills", () => {
  it("keeps a real directory in the way as a backup that never comes back as a stray", async () => {
    const home = mkdtempSync(join(tmpdir(), "t3f-skills-"));
    const checkout = join(home, "fleet");
    skill(join(checkout, "skills/foo"), "repo copy");
    // The machine had its own foo before it joined, and one an older T3 Fleet already set aside.
    skill(join(home, ".claude/skills/foo"), "local copy");
    skill(join(home, ".claude/skills/bar.t3-fleet-backup.20261001120000"), "old backup");
    const desired = { store: "~/.agents/skills", clients: ["~/.claude/skills"] };
    const ctx = { home, checkout, env: { ...process.env, HOME: home }, engine: null, node: "laptop", roles: [], relay: null };
    const round = async () => {
      const observed = await Effect.runPromise(SkillsArea.observe(desired, ctx).pipe(Effect.provide(services)));
      return SkillsArea.diagnose({ node: "laptop", desired, observed, fleet: [], authority: null });
    };

    const first = await round();
    expect(first.map((f) => f.key)).toEqual(["skills-unlinked"]);
    execFileSync("bash", ["-c", first[0]?.fix?.command ?? ""], { env: { ...process.env, HOME: home, T3_FLEET_CHECKOUT: checkout } });

    expect(await round()).toEqual([]);
    const backups = join(home, ".local/state/t3-fleet/skill-backups");
    const [stamp] = readdirSync(backups);
    // Named after the client directory (.claude-skills for ~/.claude/skills; this home is not under /Users or /home).
    const [client] = readdirSync(join(backups, stamp ?? ""));
    expect(client).toMatch(/\.claude-skills$/);
    expect(readdirSync(join(backups, stamp ?? "", client ?? ""))).toEqual(["foo"]);
  });
});
