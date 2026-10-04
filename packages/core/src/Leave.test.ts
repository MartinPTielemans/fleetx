// A fleet in a temp directory (a bare remote, an authority's clone and a
// member's), and a temp HOME for the machine that leaves. launchctl,
// systemctl, claude and codex are fakes that log their calls.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync, spawnSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import {
  armor,
  Decrypter,
  Encrypter,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { loadConfigFrom } from "./Config.ts";
import {
  applyLeave,
  planLeave,
  removeService,
  setupSnapshotPath,
  type LeavePlan,
} from "./Leave.ts";

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
const put = (dir: string, rel: string, text: string, mode?: number) => {
  fs.mkdirSync(dirname(join(dir, rel)), { recursive: true });
  fs.writeFileSync(join(dir, rel), text, mode === undefined ? {} : { mode });
};
const read = (dir: string, rel: string) => fs.readFileSync(join(dir, rel), "utf8");
const isLink = (p: string) => fs.lstatSync(p).isSymbolicLink();
const onMain = (origin: string, rel: string, ref = "main") => {
  const show = spawnSync("git", ["show", `${ref}:${rel}`], { cwd: origin, encoding: "utf8" });
  return show.status === 0 ? show.stdout : null;
};
const encrypt = async (recipients: ReadonlyArray<string>, text: string) => {
  const e = new Encrypter();
  for (const r of recipients) e.addRecipient(r);
  return armor.encode(await e.encrypt(text));
};
const decrypt = async (identity: string, armored: string) => {
  const d = new Decrypter();
  d.addIdentity(identity);
  return d.decrypt(armor.decode(armored), "text");
};

const FAKES = ["launchctl", "systemctl", "claude", "codex"];
let savedPath: string | undefined;
let savedHome: string | undefined;
beforeEach(() => {
  savedPath = process.env["PATH"];
  savedHome = process.env["HOME"];
});
afterEach(() => {
  process.env["PATH"] = savedPath;
  process.env["HOME"] = savedHome;
});

/**
 * A fleet of box (authority), laptop (member, the machine that leaves) and,
 * with `twoAuthorities`, desk (another authority). HOME is laptop's.
 */
const makeFleet = async (
  options: {
    readonly self?: string;
    readonly twoAuthorities?: boolean;
    readonly node?: string;
  } = {},
) => {
  const root = fs.mkdtempSync(join(tmpdir(), "t3-fleet-leave-"));
  const home = join(root, "home");
  fs.mkdirSync(home);
  process.env["HOME"] = home;
  const bin = join(root, "bin");
  fs.mkdirSync(bin);
  for (const fake of FAKES)
    put(
      bin,
      fake,
      `#!/bin/sh\necho "${fake} $*" >> "${root}/calls"\n[ "${fake} $1" = "launchctl print" ] && exit 113\nexit 0\n`,
      0o755,
    );
  process.env["PATH"] = `${bin}:${savedPath ?? ""}`;
  put(
    home,
    ".config/t3-fleet/gitconfig",
    "[user]\n\tname = T3 Fleet\n\temail = t3-fleet@localhost\n",
  );

  const keys: Record<string, string> = {};
  const recipients: Record<string, string> = {};
  for (const n of ["box", "laptop", "desk"]) {
    keys[n] = await generateX25519Identity();
    recipients[n] = await identityToRecipient(keys[n] ?? "");
  }
  const self = options.self ?? "laptop";
  put(home, ".config/t3-fleet/age-key.txt", `${keys[self]}\n`, 0o600);

  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  const box = join(root, "box");
  git(root, "init", "-q", "-b", "main", "box");
  git(box, "remote", "add", "origin", origin);
  put(box, "t3-fleet.toml", '[fleet]\nbranch = "main"\n');
  put(box, "nodes/box.toml", 'roles = ["authority"]\n');
  put(
    box,
    "nodes/desk.toml",
    options.twoAuthorities === true ? 'roles = ["authority"]\n' : 'roles = ["member"]\n',
  );
  put(
    box,
    "nodes/laptop.toml",
    options.node ??
      [
        'roles = ["member"]',
        "[skills]",
        'store = "~/.agents/skills"',
        'clients = ["~/.claude/skills"]',
        "[[dotfiles]]",
        'src = "zshrc"',
        'dest = "~/.zshrc"',
        "[mcp]",
        'servers = ["fetch", "docs"]',
        'gateway = "https://relay.tailnet.ts.net:8399"',
        "",
      ].join("\n"),
  );
  put(box, "skills/a/SKILL.md", "a from the repo\n");
  put(box, "dotfiles/zshrc", "export FLEET=1\n");
  const names = Object.keys(recipients).sort();
  put(
    box,
    "secrets/recipients.toml",
    `# keys\n${names.map((n) => `${n} = "${recipients[n]}"`).join("\n")}\n`,
  );
  put(
    box,
    "secrets/secrets.env.age",
    await encrypt(Object.values(recipients), "API=1\nT3_FLEET_MCP_TOKEN_LAPTOP=x\n"),
  );
  git(box, "add", "-A");
  git(box, "commit", "-qm", "fleet");
  git(box, "push", "-q", "-u", "origin", "main");
  const repo = join(root, self);
  if (self !== "box") git(root, "clone", "-q", origin, self);
  const config = await run(loadConfigFrom(repo, self));
  const calls = () => (fs.existsSync(join(root, "calls")) ? read(root, "calls") : "");
  return { root, home, origin, box, repo, keys, recipients, config, calls };
};

const titles = (plan: LeavePlan) => plan.steps.map((s) => s.title);

describe("a member leaving", () => {
  it("plans every step, and changes nothing until applied", async () => {
    const f = await makeFleet();
    put(f.home, "Library/LaunchAgents/dev.t3-fleet.sync.plist", "<plist/>");
    const plan = await run(planLeave(f.config, { home: f.home, purge: false, platform: "darwin" }));
    expect(plan.refusal).toBeNull();
    expect(titles(plan)).toEqual([
      "Propose removing laptop from the fleet (members cannot push to main)",
      "Stop and remove the sync timer",
    ]);
    expect(plan.notes.join("\n")).toContain("kept ~/.config/t3-fleet");
    expect(plan.notes.join("\n")).toContain(`the config repo checkout stays at ${f.repo}`);
    expect(plan.notes.join("\n")).toContain("T3_FLEET_MCP_TOKEN_LAPTOP");
    expect(f.calls()).toBe("");
    expect(fs.existsSync(join(f.home, "Library/LaunchAgents/dev.t3-fleet.sync.plist"))).toBe(true);
  });

  it("stops its services, copies links into place, unroutes T3, restores MCP, and proposes its removal", async () => {
    const f = await makeFleet();
    const { home } = f;
    for (const role of ["sync", "listen", "models"])
      put(home, `Library/LaunchAgents/dev.t3-fleet.${role}.plist`, "<plist/>");
    // Store → repo, client → store; a dotfile into the repo; a link of the user's own elsewhere.
    fs.mkdirSync(join(home, ".agents/skills"), { recursive: true });
    fs.mkdirSync(join(home, ".claude/skills"), { recursive: true });
    fs.symlinkSync(join(f.repo, "skills/a"), join(home, ".agents/skills/a"));
    fs.symlinkSync(join(home, ".agents/skills/a"), join(home, ".claude/skills/a"));
    fs.symlinkSync(join(f.repo, "dotfiles/zshrc"), join(home, ".zshrc"));
    put(home, "elsewhere/mine/SKILL.md", "mine\n");
    fs.symlinkSync(join(home, "elsewhere/mine"), join(home, ".claude/skills/mine"));
    // T3 routed through a launcher, with the copy routing kept.
    const settings = (binaryPath: string) =>
      JSON.stringify({ providers: { claudeAgent: { binaryPath } } });
    put(home, ".t3/userdata/settings.json", settings(`${home}/.local/bin/t3-fleet-claude`));
    put(home, ".t3/userdata/settings.json.t3-fleet-models-backup", settings("/opt/claude"));
    put(home, ".local/bin/t3-fleet-claude", "#!/bin/sh\n", 0o755);
    put(home, ".local/bin/t3-fleet", "bundle\n", 0o755);
    // Setup's snapshot: fetch was the user's own before setup replaced it; a skill was moved aside.
    put(
      home,
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          fetch: { type: "http", url: "https://relay.tailnet.ts.net:8399/mcp/fetch" },
          docs: { type: "http", url: "https://relay.tailnet.ts.net:8399/mcp/docs" },
          later: { type: "stdio", command: "later" },
        },
      }),
    );
    put(
      home,
      ".codex/config.toml",
      '[mcp_servers.fetch]\nurl = "https://relay.tailnet.ts.net:8399/mcp/fetch"\n',
    );
    put(home, ".local/state/t3-fleet/setup/moved/b/SKILL.md", "b before setup\n");
    fs.symlinkSync(join(f.repo, "skills/a"), join(home, ".agents/skills/b"));
    put(
      home,
      ".local/state/t3-fleet/setup/before.json",
      JSON.stringify({
        takenAt: 1,
        claude: { mcpServers: { fetch: { command: "uvx", args: ["mcp-fetch"] } } },
        codex: { mcp_servers: { fetch: { command: "uvx", args: ["mcp-fetch"], env: { A: "1" } } } },
        moved: [{ path: "~/.agents/skills/b", backup: "~/.local/state/t3-fleet/setup/moved/b" }],
      }),
      0o600,
    );

    const plan = await run(planLeave(f.config, { home, purge: false, platform: "darwin" }));
    expect(titles(plan)).toEqual([
      "Propose removing laptop from the fleet (members cannot push to main)",
      "Stop and remove the sync timer, the listener, the model proxy",
      "Turn 3 links into the config repo into real copies",
      "Put back what setup moved aside",
      "Point T3's providers back at what they ran before, and remove the launchers",
      "Put back the MCP servers Claude and Codex had before setup",
    ]);
    const outcomes = await run(applyLeave(plan));
    expect(outcomes.map((o) => o.ok)).toEqual(plan.steps.map(() => true));

    // Services: each booted out and its plist gone.
    for (const role of ["sync", "listen", "models"]) {
      expect(f.calls()).toMatch(new RegExp(`launchctl bootout gui/\\d+/dev\\.t3-fleet\\.${role}`));
      expect(fs.existsSync(join(home, `Library/LaunchAgents/dev.t3-fleet.${role}.plist`))).toBe(
        false,
      );
    }
    // Links: real copies, the user's own link untouched.
    for (const at of [".agents/skills/a", ".claude/skills/a"]) {
      expect(isLink(join(home, at))).toBe(false);
      expect(read(home, `${at}/SKILL.md`)).toBe("a from the repo\n");
    }
    expect(isLink(join(home, ".zshrc"))).toBe(false);
    expect(read(home, ".zshrc")).toBe("export FLEET=1\n");
    expect(isLink(join(home, ".claude/skills/mine"))).toBe(true);
    // Moved back, instead of copied.
    expect(isLink(join(home, ".agents/skills/b"))).toBe(false);
    expect(read(home, ".agents/skills/b/SKILL.md")).toBe("b before setup\n");
    // Models.
    expect(JSON.parse(read(home, ".t3/userdata/settings.json"))).toEqual(
      JSON.parse(settings("/opt/claude")),
    );
    expect(fs.existsSync(join(home, ".local/bin/t3-fleet-claude"))).toBe(false);
    expect(fs.existsSync(join(home, ".local/bin/t3-fleet"))).toBe(true);
    // MCP: fleet entries removed, the user's restored, a later one of theirs left alone.
    expect(f.calls()).toContain("claude mcp remove -s user fetch");
    expect(f.calls()).toContain("claude mcp remove -s user docs");
    expect(f.calls()).toContain(
      'claude mcp add-json -s user fetch {"command":"uvx","args":["mcp-fetch"]}',
    );
    expect(f.calls()).not.toContain("later");
    expect(f.calls()).toContain("codex mcp remove fetch");
    expect(read(home, ".codex/config.toml")).toContain('[mcp_servers.fetch]\ncommand = "uvx"');
    expect(read(home, ".codex/config.toml")).toContain('[mcp_servers.fetch.env]\nA = "1"');
    // The fleet: a proposal on its staging branch; main untouched.
    const staging = "t3-fleet/staging/laptop";
    expect(onMain(f.origin, "nodes/laptop.toml", staging)).toBeNull();
    expect(onMain(f.origin, "nodes/box.toml", staging)).not.toBeNull();
    expect(onMain(f.origin, "nodes/laptop.toml")).not.toBeNull();
    const recipients = onMain(f.origin, "secrets/recipients.toml", staging) ?? "";
    expect(recipients).not.toContain("laptop");
    expect(recipients).toContain(f.recipients["box"]);
    const sealed = onMain(f.origin, "secrets/secrets.env.age", staging) ?? "";
    expect(await decrypt(f.keys["box"] ?? "", sealed)).toContain("API=1");
    await expect(decrypt(f.keys["laptop"] ?? "", sealed)).rejects.toThrow();
    expect(outcomes[0]?.lines.join("\n")).toMatch(/t3-fleet approve laptop [0-9a-f]{7}/);
    // Local state kept; the checkout never touched.
    expect(fs.existsSync(join(home, ".config/t3-fleet/age-key.txt"))).toBe(true);
    expect(git(f.repo, "status", "--porcelain")).toBe("");
  });

  it("keeps its MCP registrations without a snapshot, and says which go through the hub", async () => {
    const f = await makeFleet();
    put(
      f.home,
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          fetch: { type: "http", url: "https://relay.tailnet.ts.net:8399/mcp/fetch" },
          "t3-fleet": { type: "stdio", command: "t3-fleet", args: ["mcp"] },
        },
      }),
    );
    const plan = await run(planLeave(f.config, { home: f.home, purge: false, platform: "darwin" }));
    const notes = plan.notes.join("\n");
    expect(notes).toContain("no setup snapshot");
    expect(notes).toContain(
      "fetch (Claude) go through the fleet's hub at https://relay.tailnet.ts.net:8399",
    );
    // Only T3 Fleet's own server goes: it cannot work once the machine has left.
    const mcp = plan.steps.find((s) => s.title.startsWith("Remove T3 Fleet's own MCP server"));
    expect(mcp?.lines).toEqual(["$ claude mcp remove -s user t3-fleet"]);
  });
});

describe("an authority leaving", () => {
  it("is refused when it is the only authority, and nothing runs", async () => {
    const f = await makeFleet({ self: "box" });
    const plan = await run(planLeave(f.config, { home: f.home, purge: true, platform: "darwin" }));
    expect(plan.refusal).toContain("only authority");
    expect(plan.steps).toEqual([]);
  });

  it("commits and pushes its removal when another authority remains", async () => {
    const f = await makeFleet({ self: "box", twoAuthorities: true });
    git(f.box, "push", "-q", "origin", "main:t3-fleet/state/box");
    const plan = await run(planLeave(f.config, { home: f.home, purge: false, platform: "darwin" }));
    expect(titles(plan)).toEqual(["Remove box from the fleet (commit and push, as an authority)"]);
    const outcomes = await run(applyLeave(plan));
    expect(outcomes[0]?.ok).toBe(true);
    expect(onMain(f.origin, "nodes/box.toml")).toBeNull();
    expect(onMain(f.origin, "nodes/desk.toml")).not.toBeNull();
    expect(onMain(f.origin, "secrets/recipients.toml")).not.toContain(f.recipients["box"]);
    const sealed = onMain(f.origin, "secrets/secrets.env.age") ?? "";
    expect(await decrypt(f.keys["desk"] ?? "", sealed)).toContain("API=1");
    expect(onMain(f.origin, "nodes/box.toml", "t3-fleet/state/box")).toBeNull();
  });
});

describe("--purge", () => {
  it("removes T3 Fleet's local state, keeping the skills from before joining", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    put(f.home, ".config/t3-fleet/secrets.env", "API=1\n", 0o600);
    put(f.home, ".local/state/t3-fleet/sync.log", "log\n");
    put(f.home, ".local/state/t3-fleet/skill-backups/1/.claude-skills/x/SKILL.md", "x\n");
    put(f.home, ".local/share/t3-fleet/t3-fleet.mjs", "bundle\n");
    fs.mkdirSync(join(f.home, ".local/bin"), { recursive: true });
    fs.symlinkSync(
      join(f.home, ".local/share/t3-fleet/t3-fleet.mjs"),
      join(f.home, ".local/bin/t3-fleet"),
    );
    const plan = await run(planLeave(f.config, { home: f.home, purge: true, platform: "darwin" }));
    expect(plan.notes.join("\n")).toContain("kept ~/.local/state/t3-fleet/skill-backups");
    expect(plan.notes.join("\n")).not.toContain("--purge removes them");
    const outcomes = await run(applyLeave(plan));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    for (const gone of [
      ".config/t3-fleet",
      ".local/state/t3-fleet/sync.log",
      ".local/share/t3-fleet",
    ])
      expect(fs.existsSync(join(f.home, gone))).toBe(false);
    expect(fs.lstatSync(join(f.home, ".local/bin"), { throwIfNoEntry: false })?.isDirectory()).toBe(
      true,
    );
    expect(fs.existsSync(join(f.home, ".local/bin/t3-fleet"))).toBe(false);
    expect(read(f.home, ".local/state/t3-fleet/skill-backups/1/.claude-skills/x/SKILL.md")).toBe(
      "x\n",
    );
    expect(fs.existsSync(join(f.repo, "nodes/laptop.toml"))).toBe(true);
  });
});

describe("services under systemd", () => {
  it("disables and removes user units, the sync timer with its service", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    put(f.home, ".config/systemd/user/t3-fleet-sync.service", "[Service]\n");
    put(f.home, ".config/systemd/user/t3-fleet-sync.timer", "[Timer]\n");
    put(f.home, ".config/systemd/user/t3-fleet-listen.service", "[Service]\n");
    const plan = await run(
      planLeave(f.config, { home: f.home, purge: false, platform: "linux", root: false }),
    );
    const step = plan.steps.find((s) => s.title.startsWith("Stop and remove"));
    expect(step?.title).toBe("Stop and remove the sync timer, the listener");
    await run(step?.apply ?? Effect.succeed([]));
    expect(f.calls()).toContain(
      "systemctl --user disable --now t3-fleet-sync.timer t3-fleet-sync.service",
    );
    expect(f.calls()).toContain("systemctl --user disable --now t3-fleet-listen.service");
    expect(f.calls()).toContain("systemctl --user daemon-reload");
    for (const unit of ["t3-fleet-sync.service", "t3-fleet-sync.timer", "t3-fleet-listen.service"])
      expect(fs.existsSync(join(f.home, ".config/systemd/user", unit))).toBe(false);
  });

  it("uses system units for root", () => {
    const script = removeService("linux", true, "models", 75);
    expect(script).toContain("systemctl disable --now t3-fleet-models.service");
    expect(script).toContain("rm -f /etc/systemd/system/t3-fleet-models.service");
    expect(script).not.toContain("--user");
  });
});

it("finds setup's snapshot where setup writes it", () => {
  expect(setupSnapshotPath("/h")).toBe("/h/.local/state/t3-fleet/setup/before.json");
});
