// A fleet in a temp directory (a bare remote; hub, an authority; laptop, the
// member that leaves; desk, a member or a second authority), and a temp HOME
// for the machine that leaves. launchctl and systemctl are fakes that keep
// state in files, so a stop can be made to fail; nothing else is faked: the
// files leave writes are parsed back.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {
  armor,
  Decrypter,
  Encrypter,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { loadConfigFrom } from "./Config.ts";
import {
  applyLeave,
  currentDeparture,
  ENROLLMENT_ID,
  enrollmentOf,
  departureOf,
  departurePath,
  planLeave,
  retireDeparture,
  unfinishedDeparture,
  type Departure,
  type LeavePlan,
} from "./Leave.ts";
import { writeAtomically } from "./leave/Files.ts";
import { isDeparture } from "./leave/Fleet.ts";
import { editCodexServers } from "./leave/Mcp.ts";
import { settingsUpdates, throughT3, unrouted } from "./leave/Models.ts";
import { removeService } from "./leave/Services.ts";
import { approve, autoApprovable, autoApproves, listProposals } from "./Staging.ts";
import { encryptedForIn, recipientSet } from "./Secrets.ts";
import { exchange } from "./Sync.ts";
import { underSyncLock } from "./SyncLock.ts";

const layer = Layer.merge(NodeServices.layer, FetchHttpClient.layer);
const run = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices | HttpClient.HttpClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
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
const exists = (dir: string, rel: string) => fs.existsSync(join(dir, rel));
const isLink = (p: string) => fs.lstatSync(p).isSymbolicLink();
const modeOf = (p: string) => fs.statSync(p).mode & 0o777;
const onBranch = (origin: string, rel: string, ref = "main") => {
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
const planText = (plan: LeavePlan) =>
  [plan.refusal ?? "", ...plan.steps.flatMap((s) => [s.title, ...s.lines]), ...plan.notes].join(
    "\n",
  );

let savedPath: string | undefined;
let savedHome: string | undefined;
// Claude's config moves with these; the tests' must stay in their temp HOME.
const CLAUDE_ENV = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_CUSTOM_OAUTH_URL"];
const savedClaude: Record<string, string | undefined> = {};
beforeEach(() => {
  savedPath = process.env["PATH"];
  savedHome = process.env["HOME"];
  for (const k of CLAUDE_ENV) {
    savedClaude[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  process.env["PATH"] = savedPath;
  process.env["HOME"] = savedHome;
  for (const k of CLAUDE_ENV)
    if (savedClaude[k] === undefined) delete process.env[k];
    else process.env[k] = savedClaude[k];
});

/**
 * launchctl: a job is loaded while $root/loaded/<label> exists; bootout
 * clears it unless $root/stuck exists. systemctl: a unit is active while
 * $root/active/<unit> exists; disable --now clears it unless $root/stuck.
 */
const FAKE_LAUNCHCTL = (root: string) => `#!/bin/sh
echo "launchctl $*" >> "${root}/calls"
label="\${2##*/}"
case "$1" in
  print) [ -e "${root}/loaded/$label" ] && exit 0; exit 113 ;;
  bootout) [ -e "${root}/stuck" ] || rm -f "${root}/loaded/$label"; exit 0 ;;
esac
exit 0
`;
const FAKE_SYSTEMCTL = (root: string) => `#!/bin/sh
echo "systemctl $*" >> "${root}/calls"
[ "$1" = --user ] && shift
case "$1" in
  disable) shift; [ "$1" = --now ] && shift; [ -e "${root}/stuck" ] || for u in "$@"; do rm -f "${root}/active/$u"; done; exit 0 ;;
  is-active) [ "$2" = --quiet ] && u="$3" || u="$2"; [ -e "${root}/active/$u" ] && { echo active; exit 0; }; echo inactive; exit 3 ;;
  is-enabled) echo disabled; exit 1 ;;
esac
exit 0
`;

const GATEWAY = "https://relay.tailnet.ts.net:8399";
const LAPTOP = [
  'roles = ["member"]',
  "[skills]",
  'store = "~/.agents/skills"',
  'clients = ["~/.claude/skills"]',
  "[[dotfiles]]",
  'src = "zshrc"',
  'dest = "~/.zshrc"',
  "[mcp]",
  'servers = ["fetch", "docs", "notes"]',
  "hub = true",
  `gateway = "${GATEWAY}"`,
  "",
].join("\n");

const makeFleet = async (
  options: {
    readonly self?: string;
    readonly desk?: "member" | "authority";
    readonly node?: string;
  } = {},
) => {
  const root = fs.mkdtempSync(join(tmpdir(), "t3-fleet-leave-"));
  const home = join(root, "home");
  fs.mkdirSync(home);
  process.env["HOME"] = home;
  const bin = join(root, "bin");
  put(bin, "launchctl", FAKE_LAUNCHCTL(root), 0o755);
  put(bin, "systemctl", FAKE_SYSTEMCTL(root), 0o755);
  fs.mkdirSync(join(root, "loaded"));
  fs.mkdirSync(join(root, "active"));
  process.env["PATH"] = `${bin}:${savedPath ?? ""}`;
  put(
    home,
    ".config/t3-fleet/gitconfig",
    "[user]\n\tname = T3 Fleet\n\temail = t3-fleet@localhost\n",
  );

  const keys: Record<string, string> = {};
  const recipients: Record<string, string> = {};
  for (const n of ["hub", "laptop", "desk"]) {
    keys[n] = await generateX25519Identity();
    recipients[n] = await identityToRecipient(keys[n] ?? "");
  }
  const self = options.self ?? "laptop";
  put(home, ".config/t3-fleet/age-key.txt", `${keys[self]}\n`, 0o600);

  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  const hub = join(root, "hub");
  git(root, "init", "-q", "-b", "main", "hub");
  git(hub, "remote", "add", "origin", origin);
  put(hub, "t3-fleet.toml", '[fleet]\nbranch = "main"\n');
  put(hub, "nodes/hub.toml", 'roles = ["authority"]\n');
  put(hub, "nodes/desk.toml", `roles = ["${options.desk ?? "member"}"]\n`);
  put(hub, "nodes/laptop.toml", options.node ?? LAPTOP);
  put(hub, "skills/a/SKILL.md", "a from the repo\n");
  put(hub, "skills/shared/ref.md", "shared from the repo\n");
  put(hub, "skills/b/SKILL.md", "b from the repo\n");
  // A skill linking a shared file in the repo, by a relative link.
  fs.symlinkSync("../shared/ref.md", join(hub, "skills/a/ref.md"));
  put(hub, "dotfiles/zshrc", "export FLEET=1\n");
  put(hub, "mcp/fetch.json", '{ "kind": "remote", "url": "https://fetch.example/mcp" }\n');
  put(
    hub,
    "mcp/docs.json",
    '{ "kind": "stdio", "command": "~/bin/docs-mcp", "args": ["--quiet"] }\n',
  );
  put(hub, "mcp/notes.json", '{ "kind": "stdio", "command": "notes-mcp" }\n');
  put(
    hub,
    "secrets/recipients.toml",
    `# keys\n${Object.keys(recipients)
      .sort()
      .map((n) => `${n} = "${recipients[n]}"`)
      .join("\n")}\n`,
  );
  put(
    hub,
    "secrets/secrets.env.age",
    await encrypt(Object.values(recipients), "API=one\nT3_FLEET_MCP_TOKEN_LAPTOP=x\n"),
  );
  git(hub, "add", "-A");
  git(hub, "commit", "-qm", "fleet");
  git(hub, "push", "-q", "-u", "origin", "main");
  const repo = join(root, self);
  if (self !== "hub") git(root, "clone", "-q", origin, self);
  put(home, ".config/t3-fleet/config.toml", `repo = "${repo}"\nnode = "${self}"\n`);
  const config = await run(loadConfigFrom(repo, self));
  const calls = () => (exists(root, "calls") ? read(root, "calls") : "");
  const planFor = (departure: Departure, purge = false, platform = "darwin") =>
    run(
      planLeave(departure, {
        home,
        purge,
        platform,
        root: false,
        systemDir: join(root, "etc-systemd"),
        stopWait: 1,
      }),
    );
  const plan = (purge = false, platform = "darwin") =>
    planFor(departureOf(config), purge, platform);
  return { root, home, origin, hub, repo, keys, recipients, config, calls, plan, planFor };
};

type Fleet = Awaited<ReturnType<typeof makeFleet>>;
const titles = (plan: LeavePlan) => plan.steps.map((s) => s.title);
const commitAll = (dir: string, message: string) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  git(dir, "push", "-q", "origin", "HEAD:main");
};

/** The member's machine as setup left it: services, links, routing, MCP and setup's snapshot. */
const setUpLaptop = (f: Fleet) => {
  const { home, root } = f;
  for (const role of ["sync", "listen", "models"]) {
    put(home, `Library/LaunchAgents/dev.t3-fleet.${role}.plist`, "<plist/>");
    put(root, `loaded/dev.t3-fleet.${role}`, "");
  }
  fs.mkdirSync(join(home, ".agents/skills"), { recursive: true });
  fs.mkdirSync(join(home, ".claude/skills"), { recursive: true });
  fs.symlinkSync(join(f.repo, "skills/a"), join(home, ".agents/skills/a"));
  fs.symlinkSync(join(home, ".agents/skills/a"), join(home, ".claude/skills/a"));
  fs.symlinkSync(join(f.repo, "dotfiles/zshrc"), join(home, ".zshrc"));
  fs.symlinkSync(join(f.repo, "skills/gone"), join(home, ".agents/skills/gone"));
  put(home, "elsewhere/mine/SKILL.md", "mine\n");
  fs.symlinkSync(join(home, "elsewhere/mine"), join(home, ".claude/skills/mine"));
  // Someone else's directory with the name the first version of leave staged copies under.
  put(home, ".agents/skills/a.t3-fleet-leave/keep.txt", "not ours\n");
  // T3 routed: the legacy claudeAgent field (which claudeWork inherits), and codexMain's own.
  put(
    home,
    ".t3/userdata/settings.json",
    JSON.stringify({
      providers: { claudeAgent: { binaryPath: `${home}/.local/bin/t3-fleet-claude` } },
      providerInstances: {
        claudeWork: { driver: "claudeAgent", config: {} },
        codexMain: { driver: "codex", config: { binaryPath: "t3-fleet-codex" } },
      },
    }),
  );
  put(
    home,
    ".t3/userdata/settings.json.t3-fleet-models-backup",
    JSON.stringify({ providers: { claudeAgent: { binaryPath: "/opt/claude" } } }),
  );
  put(home, ".local/bin/t3-fleet-claude", "#!/bin/sh\n", 0o755);
  put(home, ".local/bin/t3-fleet-codex", "#!/bin/sh\n", 0o755);
  put(home, ".local/bin/t3-fleet", "bundle\n", 0o755);
  put(home, ".config/t3-fleet/secrets.env", "T3_FLEET_RELAY_TOKEN=relay-token\n", 0o600);
  put(
    home,
    ".claude.json",
    JSON.stringify(
      {
        numStartups: 3,
        mcpServers: {
          fetch: {
            type: "http",
            url: `${GATEWAY}/mcp/fetch`,
            headers: { Authorization: "Bearer relay-token" },
          },
          docs: { type: "stdio", command: `${home}/bin/docs-mcp`, args: ["--quiet"] },
          // The user replaced notes with their own since setup.
          notes: { type: "stdio", command: "my-notes" },
          later: { type: "stdio", command: "later" },
        },
      },
      null,
      2,
    ),
    0o600,
  );
  put(
    home,
    ".codex/config.toml",
    [
      "# my codex",
      'model = "o3"',
      "",
      "[mcp_servers.fetch]",
      `url = "${GATEWAY}/mcp/fetch"`,
      'bearer_token_env_var = "T3_FLEET_RELAY_TOKEN"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      "[profiles.fast]",
      'model = "o4-mini"',
      "",
    ].join("\n"),
    0o640,
  );
  put(home, ".local/state/t3-fleet/setup/moved/b/SKILL.md", "b before setup\n");
  fs.symlinkSync(join(f.repo, "skills/b"), join(home, ".agents/skills/b"));
  put(home, ".local/state/t3-fleet/setup/moved/zprofile", "my zprofile\n");
  fs.symlinkSync(join(home, "elsewhere/mine"), join(home, ".zprofile"));
  const fetchBefore = {
    command: "uvx",
    args: ["mcp-fetch"],
    env: { FETCH_TOKEN: "sk-secret-123" },
  };
  put(
    home,
    ".local/state/t3-fleet/setup/before.json",
    JSON.stringify({
      takenAt: 1,
      claude: { mcpServers: { fetch: fetchBefore, notes: { command: "old-notes" } } },
      codex: { mcp_servers: { fetch: fetchBefore } },
      moved: [
        { path: "~/.agents/skills/b", backup: "~/.local/state/t3-fleet/setup/moved/b" },
        { path: "~/.zprofile", backup: "~/.local/state/t3-fleet/setup/moved/zprofile" },
      ],
    }),
    0o600,
  );
  return { fetchBefore };
};

describe("a member leaving", () => {
  it("gives back everything, proposes its departure, and parses back what it wrote", async () => {
    const f = await makeFleet();
    const { fetchBefore } = setUpLaptop(f);
    const { home } = f;
    const plan = await f.plan();
    expect(plan.refusal).toBeNull();
    expect(titles(plan)).toEqual([
      "Propose removing laptop from the fleet (members cannot push to main)",
      // Routing goes back before the model proxy stops.
      "Point T3's providers back at what they ran before, and remove the launchers",
      "Stop and remove the sync timer, the listener, the model proxy",
      "Turn 3 links into the config repo into real copies",
      "Put back what setup moved aside",
      "Put back the MCP servers Claude and Codex had before setup",
    ]);
    const text = planText(plan);
    // No value from any entry reaches the plan.
    expect(text).not.toContain("sk-secret-123");
    expect(text).not.toContain("relay-token");
    expect(text).not.toContain("uvx");
    expect(text).toContain("~/.agents/skills/gone points into the config repo");
    expect(text).toContain("notes in Claude was changed since T3 Fleet registered it");
    expect(text).toContain("~/.zprofile is your own now");
    expect(text).toContain("T3 is not running, so in ~/.t3/userdata/settings.json");
    expect(f.calls()).toBe("");

    const outcomes = await run(applyLeave(plan));
    expect(outcomes.map((o) => o.ok)).toEqual(plan.steps.map(() => true));

    // Services: stopped, then their plists removed.
    for (const role of ["sync", "listen", "models"]) {
      expect(exists(f.root, `loaded/dev.t3-fleet.${role}`)).toBe(false);
      expect(exists(home, `Library/LaunchAgents/dev.t3-fleet.${role}.plist`)).toBe(false);
    }
    // Links: real copies with the nested repo link copied in; the user's link and others' files untouched.
    for (const at of [".agents/skills/a", ".claude/skills/a"]) {
      expect(isLink(join(home, at))).toBe(false);
      expect(read(home, `${at}/SKILL.md`)).toBe("a from the repo\n");
      expect(isLink(join(home, `${at}/ref.md`))).toBe(false);
      expect(read(home, `${at}/ref.md`)).toBe("shared from the repo\n");
    }
    expect(read(home, ".zshrc")).toBe("export FLEET=1\n");
    expect(isLink(join(home, ".zshrc"))).toBe(false);
    expect(isLink(join(home, ".claude/skills/mine"))).toBe(true);
    expect(isLink(join(home, ".agents/skills/gone"))).toBe(true);
    expect(read(home, ".agents/skills/a.t3-fleet-leave/keep.txt")).toBe("not ours\n");
    expect(
      fs.readdirSync(join(home, ".agents/skills")).filter((n) => n.includes(".t3-fleet-leave-")),
    ).toEqual([]);
    // Backups: b went back over T3 Fleet's link; ~/.zprofile is the user's own link, so its backup stays.
    expect(read(home, ".agents/skills/b/SKILL.md")).toBe("b before setup\n");
    expect(fs.readlinkSync(join(home, ".zprofile"))).toBe(join(home, "elsewhere/mine"));
    expect(read(home, ".local/state/t3-fleet/setup/moved/zprofile")).toBe("my zprofile\n");
    // Models: the legacy field (claudeWork inherits it) and codexMain's own, both restored.
    const settings = JSON.parse(read(home, ".t3/userdata/settings.json")) as {
      providers: { claudeAgent: { binaryPath?: string } };
      providerInstances: { codexMain: { config: { binaryPath?: string } } };
    };
    expect(settings.providers.claudeAgent.binaryPath).toBe("/opt/claude");
    expect(settings.providerInstances.codexMain.config.binaryPath).toBeUndefined();
    expect(exists(home, ".local/bin/t3-fleet-claude")).toBe(false);
    expect(exists(home, ".local/bin/t3-fleet-codex")).toBe(false);
    expect(exists(home, ".local/bin/t3-fleet")).toBe(true);
    // Claude, parsed back: fetch is the user's again, docs gone, notes and later untouched, mode kept.
    const claude = JSON.parse(read(home, ".claude.json")) as Record<string, unknown>;
    expect(claude["numStartups"]).toBe(3);
    expect(claude["mcpServers"]).toEqual({
      fetch: fetchBefore,
      notes: { type: "stdio", command: "my-notes" },
      later: { type: "stdio", command: "later" },
    });
    expect(modeOf(join(home, ".claude.json"))).toBe(0o600);
    // Codex, parsed back: one fetch table, everything else as it was, mode kept.
    const codexText = read(home, ".codex/config.toml");
    expect(codexText.match(/^\[mcp_servers\.fetch\]$/gm)).toHaveLength(1);
    expect(codexText).toContain("# my codex");
    expect(parseToml(codexText)).toEqual({
      model: "o3",
      mcp_servers: { other: { command: "other" }, fetch: fetchBefore },
      profiles: { fast: { model: "o4-mini" } },
    });
    expect(modeOf(join(home, ".codex/config.toml"))).toBe(0o640);
    // The fleet: a departure proposal; main and the checkout untouched.
    const staging = "t3-fleet/staging/laptop";
    expect(onBranch(f.origin, "nodes/laptop.toml", staging)).toBeNull();
    expect(onBranch(f.origin, "secrets/recipients.toml", staging)).not.toContain("laptop");
    expect(
      git(f.origin, "diff", "--name-status", `${staging}^`, staging).trim().split("\n"),
    ).toEqual(["D\tnodes/laptop.toml", "M\tsecrets/recipients.toml", "M\tsecrets/secrets.env.age"]);
    expect(onBranch(f.origin, "nodes/laptop.toml")).not.toBeNull();
    expect(git(f.repo, "status", "--porcelain")).toBe("");
    // Recorded as finished; local state kept without --purge.
    expect(JSON.parse(read(home, ".local/state/t3-fleet/leave.json"))).toMatchObject({
      node: "laptop",
      finished: true,
    });
    expect(exists(home, ".config/t3-fleet/age-key.txt")).toBe(true);
    // Run again: nothing left but what is waiting on an authority.
    const again = await f.plan();
    expect(again.steps).toEqual([]);
    expect(again.notes.join("\n")).toContain("waits for an authority: t3-fleet approve laptop");
  });

  it("is not withdrawn by an ordinary sync, and approval re-encrypts the authority's current secrets", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    await run(applyLeave(await f.plan()));
    // A sync on the member (one its timer started just before, say) leaves the departure alone.
    const node = f.config.nodes.find((n) => n.name === "laptop");
    if (node === undefined) throw new Error("no laptop");
    await run(underSyncLock(exchange(f.config, node, [])));
    expect(onBranch(f.origin, "nodes/laptop.toml", "t3-fleet/staging/laptop")).toBeNull();
    expect(onBranch(f.origin, "nodes/hub.toml", "t3-fleet/staging/laptop")).not.toBeNull();
    // The secrets change before an authority approves; the member is long gone by then.
    const hubHome = join(f.root, "hub-home");
    process.env["HOME"] = hubHome;
    put(hubHome, ".config/t3-fleet/gitconfig", "[user]\n\tname = T\n\temail = t@example.com\n");
    put(hubHome, ".config/t3-fleet/age-key.txt", `${f.keys["hub"]}\n`, 0o600);
    put(f.hub, "secrets/secrets.env.age", await encrypt(Object.values(f.recipients), "API=two\n"));
    put(
      f.hub,
      "t3-fleet.toml",
      '[fleet]\nbranch = "main"\n\n[notify]\ndesktop = ["hub", "laptop"]\n',
    );
    commitAll(f.hub, "new secret");
    const [proposal] = await run(listProposals(f.hub, "main"));
    if (proposal === undefined) throw new Error("no proposal");
    const approved = await run(approve(f.hub, "main", proposal, "hub"));
    expect(onBranch(f.origin, "nodes/laptop.toml")).toBeNull();
    // Gone from the fleet, gone from its notifications too (review B-LOW).
    expect(onBranch(f.origin, "t3-fleet.toml")).toContain('desktop = ["hub"]');
    expect(approved.notes).toContain("took laptop out of [notify] desktop");
    expect(onBranch(f.origin, "secrets/recipients.toml")).not.toContain(f.recipients["laptop"]);
    const sealed = onBranch(f.origin, "secrets/secrets.env.age") ?? "";
    expect(await decrypt(f.keys["hub"] ?? "", sealed)).toBe("API=two\n");
    await expect(decrypt(f.keys["laptop"] ?? "", sealed)).rejects.toThrow();
    expect(onBranch(f.origin, "nodes/hub.toml", "t3-fleet/staging/laptop")).toBeNull();
  });

  it("keeps its MCP registrations without a snapshot, says which use the hub, and removes only t3-fleet mcp", async () => {
    const f = await makeFleet();
    put(
      f.home,
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          fetch: { type: "http", url: `${GATEWAY}/mcp/fetch` },
          fleet: { type: "stdio", command: "t3-fleet", args: ["mcp"] },
        },
      }),
    );
    const plan = await f.plan();
    expect(plan.notes.join("\n")).toContain("no setup snapshot");
    expect(plan.notes.join("\n")).toContain("fetch in Claude go through the fleet's hub");
    const mcp = plan.steps.find((s) => s.title.startsWith("Remove T3 Fleet's own MCP server"));
    expect(mcp?.lines).toEqual([
      "Claude: remove fleet (T3 Fleet's own server, which cannot work once this machine has left)",
    ]);
    await run(applyLeave(plan));
    const claude = JSON.parse(read(f.home, ".claude.json")) as { mcpServers: object };
    expect(Object.keys(claude.mcpServers)).toEqual(["fetch"]);
  });
});

describe("Codex's config.toml", () => {
  it("replaces a server's tables and keeps every other line", async () => {
    const text = [
      "# top",
      "[mcp_servers.fetch]",
      'url = "u"',
      "[mcp_servers.fetch.env]",
      'A = "1"',
      "# about other",
      '[mcp_servers."other one"]',
      'command = "o"',
      "",
    ].join("\n");
    const edited = await run(editCodexServers(text, { fetch: { command: "uvx" }, gone: null }));
    expect(edited).toContain("# top");
    expect(edited).toContain("# about other");
    expect(parseToml(edited)).toEqual({
      mcp_servers: { "other one": { command: "o" }, fetch: { command: "uvx" } },
    });
  });

  it("refuses, changing nothing, a server it cannot edit table by table", async () => {
    const f = await makeFleet();
    setUpLaptop(f);
    const inline = `mcp_servers = { fetch = { url = "${GATEWAY}/mcp/fetch", bearer_token_env_var = "T3_FLEET_RELAY_TOKEN" } }\n`;
    put(f.home, ".codex/config.toml", inline);
    const outcomes = await run(applyLeave(await f.plan()));
    expect(outcomes.at(-1)).toMatchObject({ ok: false });
    expect(outcomes.at(-1)?.lines.join("")).toContain("edit it by hand");
    expect(read(f.home, ".codex/config.toml")).toBe(inline);
    // Not finished: a later leave goes on from there.
    expect(JSON.parse(read(f.home, ".local/state/t3-fleet/leave.json")).finished).toBe(false);
  });

  it("creates a missing config private", async () => {
    const f = await makeFleet();
    const { fetchBefore } = setUpLaptop(f);
    fs.rmSync(join(f.home, ".codex"), { recursive: true });
    await run(applyLeave(await f.plan()));
    expect(modeOf(join(f.home, ".codex/config.toml"))).toBe(0o600);
    expect(parseToml(read(f.home, ".codex/config.toml"))).toEqual({
      mcp_servers: { fetch: fetchBefore },
    });
  });
});

describe("links", () => {
  const markerFor = (f: Fleet, at: string, ready: boolean) =>
    JSON.stringify({ path: at, source: join(f.repo, "skills/a"), how: "copy", ready });

  it("finishes a copy an interrupted run left with the link moved aside", async () => {
    const f = await makeFleet();
    const at = join(f.home, ".agents/skills/a");
    const staging = join(f.home, ".agents/skills/.a.t3-fleet-leave-XyZ123");
    put(staging, "copy/SKILL.md", "a copied\n");
    fs.symlinkSync(join(f.repo, "skills/a"), join(staging, "link"));
    put(staging, "marker.json", markerFor(f, at, true));
    const plan = await f.plan();
    expect(plan.steps.find((s) => s.title.startsWith("Turn"))?.lines).toContain(
      "~/.agents/skills/a  ← finish what an interrupted run left half-done",
    );
    await run(applyLeave(plan));
    expect(isLink(at)).toBe(false);
    expect(read(f.home, ".agents/skills/a/SKILL.md")).toBe("a copied\n");
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("puts the link back when an interrupted copy was not finished", async () => {
    const f = await makeFleet();
    const at = join(f.home, ".agents/skills/a");
    const staging = join(f.home, ".agents/skills/.a.t3-fleet-leave-AbC456");
    put(staging, "copy/half", "");
    fs.symlinkSync(join(f.repo, "skills/a"), join(staging, "link"));
    put(staging, "marker.json", markerFor(f, at, false));
    await run(applyLeave(await f.plan()));
    expect(isLink(at)).toBe(true);
    expect(fs.existsSync(staging)).toBe(false);
    // The next run copies it properly.
    await run(applyLeave(await f.plan()));
    expect(isLink(at)).toBe(false);
    expect(read(f.home, ".agents/skills/a/SKILL.md")).toBe("a from the repo\n");
  });

  it("keeps the link when the copy fails, and leaves no staging behind", async () => {
    const f = await makeFleet();
    const at = join(f.home, ".agents/skills/a");
    fs.mkdirSync(dirname(at), { recursive: true });
    fs.symlinkSync(join(f.repo, "skills/a"), at);
    put(f.repo, "skills/a/private.md", "unreadable\n", 0o000);
    try {
      const outcomes = await run(applyLeave(await f.plan()));
      expect(outcomes.find((o) => o.title.startsWith("Turn"))?.ok).toBe(false);
      expect(isLink(at)).toBe(true);
      expect(fs.readdirSync(dirname(at))).toEqual(["a"]);
    } finally {
      fs.chmodSync(join(f.repo, "skills/a/private.md"), 0o644);
    }
  });
});

describe("--purge", () => {
  it("keeps every backup of the user's own files, moving setup's out of what it deletes", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    put(f.home, ".config/t3-fleet/secrets.env", "API=one\n", 0o600);
    put(f.home, ".local/state/t3-fleet/sync.log", "log\n");
    put(f.home, ".local/state/t3-fleet/skill-backups/1/.claude-skills/x/SKILL.md", "x\n");
    put(f.home, ".local/share/t3-fleet/t3-fleet.mjs", "bundle\n");
    fs.mkdirSync(join(f.home, ".local/bin"), { recursive: true });
    fs.symlinkSync(
      join(f.home, ".local/share/t3-fleet/t3-fleet.mjs"),
      join(f.home, ".local/bin/t3-fleet"),
    );
    // The user replaced setup's link with a real file of their own: the backup is not restored.
    put(f.home, ".local/state/t3-fleet/setup/moved/zshenv", "zshenv before setup\n");
    put(f.home, ".zshenv", "my newer zshenv\n");
    put(
      f.home,
      ".local/state/t3-fleet/setup/before.json",
      JSON.stringify({
        takenAt: 1,
        moved: [{ path: "~/.zshenv", backup: "~/.local/state/t3-fleet/setup/moved/zshenv" }],
      }),
    );
    const plan = await f.plan(true);
    const text = planText(plan);
    expect(text).toContain(
      "setup's backup ~/.local/state/t3-fleet/setup/moved/zshenv is kept, moved to ~/.local/state/t3-fleet/setup-backups/.zshenv",
    );
    expect(text).toContain("kept ~/.local/state/t3-fleet/skill-backups");
    const outcomes = await run(applyLeave(plan));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(read(f.home, ".zshenv")).toBe("my newer zshenv\n");
    expect(read(f.home, ".local/state/t3-fleet/setup-backups/.zshenv")).toBe(
      "zshenv before setup\n",
    );
    expect(read(f.home, ".local/state/t3-fleet/skill-backups/1/.claude-skills/x/SKILL.md")).toBe(
      "x\n",
    );
    for (const gone of [
      ".config/t3-fleet",
      ".local/state/t3-fleet/sync.log",
      ".local/state/t3-fleet/setup",
      ".local/state/t3-fleet/leave.json",
      ".local/state/t3-fleet/sync.lock",
      ".local/share/t3-fleet",
      ".local/bin/t3-fleet",
    ])
      expect(exists(f.home, gone)).toBe(false);
    expect(exists(f.repo, "nodes/laptop.toml")).toBe(true);
  });
});

describe("an authority leaving", () => {
  it("is refused when it is the only authority, and nothing runs", async () => {
    const f = await makeFleet({ self: "hub" });
    const plan = await f.plan(true);
    expect(plan.refusal).toContain("only authority");
    expect(plan.steps).toEqual([]);
    expect(await run(applyLeave(plan))).toEqual([]);
    expect(exists(f.home, ".local/state/t3-fleet/leave.json")).toBe(false);
  });

  it("goes by origin's authorities, not a stale checkout's, when it plans and again when it runs", async () => {
    const f = await makeFleet({ self: "hub", desk: "authority" });
    const other = join(f.root, "other");
    git(f.root, "clone", "-q", f.origin, "other");
    const demote = () => {
      put(other, "nodes/desk.toml", 'roles = ["member"]\n');
      commitAll(other, "demote desk");
    };
    const promote = () => {
      put(other, "nodes/desk.toml", 'roles = ["authority"]\n');
      commitAll(other, "promote desk");
    };
    // The checkout still says desk is an authority; origin no longer does.
    demote();
    expect((await f.plan()).refusal).toContain("only authority");
    // Planned while desk was one again, demoted before it runs.
    promote();
    const plan = await f.plan();
    expect(plan.refusal).toBeNull();
    demote();
    const outcomes = await run(applyLeave(plan));
    expect(outcomes[0]).toMatchObject({ ok: false });
    expect(outcomes[0]?.lines.join("")).toContain("only authority");
    expect(onBranch(f.origin, "nodes/hub.toml")).not.toBeNull();
  });

  it("removes itself, and a later run resumes once its node file is gone", async () => {
    const f = await makeFleet({ self: "hub", desk: "authority" });
    git(f.hub, "push", "-q", "origin", "main:t3-fleet/state/hub");
    put(f.home, "Library/LaunchAgents/dev.t3-fleet.sync.plist", "<plist/>");
    put(f.root, "loaded/dev.t3-fleet.sync", "");
    put(f.root, "stuck", "");
    const first = await run(applyLeave(await f.plan()));
    expect(first.map((o) => o.ok)).toEqual([true, false]);
    expect(first[1]?.lines.join("")).toContain("launchd still has dev.t3-fleet.sync loaded");
    expect(exists(f.home, "Library/LaunchAgents/dev.t3-fleet.sync.plist")).toBe(true);
    expect(onBranch(f.origin, "nodes/hub.toml")).toBeNull();
    expect(onBranch(f.origin, "nodes/desk.toml")).not.toBeNull();
    const sealed = onBranch(f.origin, "secrets/secrets.env.age") ?? "";
    expect(await decrypt(f.keys["desk"] ?? "", sealed)).toContain("API=one");
    await expect(decrypt(f.keys["hub"] ?? "", sealed)).rejects.toThrow();
    expect(
      spawnSync("git", ["rev-parse", "--verify", "t3-fleet/state/hub"], { cwd: f.origin }).status,
    ).not.toBe(0);
    // The checkout followed, so the config no longer has hub: leave goes on from its record.
    expect(exists(f.hub, "nodes/hub.toml")).toBe(false);
    fs.rmSync(join(f.root, "stuck"));
    const { departure, resumed } = await run(currentDeparture(f.home));
    expect(resumed).toBe(true);
    expect(departure).toMatchObject({ node: "hub", finished: false });
    const again = await f.planFor(departure);
    expect(titles(again)).toEqual(["Stop and remove the sync timer"]);
    expect((await run(applyLeave(again))).every((o) => o.ok)).toBe(true);
    // And --purge later still works, from the finished record.
    const later = await run(currentDeparture(f.home));
    expect(later.departure.finished).toBe(true);
    await run(applyLeave(await f.planFor(later.departure, true)));
    expect(exists(f.home, ".config/t3-fleet")).toBe(false);
    expect(exists(f.home, ".local/state/t3-fleet")).toBe(false);
  });
});

describe("services", () => {
  it("keeps a systemd unit that is still running, and stops there", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    put(f.home, ".config/systemd/user/t3-fleet-sync.service", "[Service]\n");
    put(f.home, ".config/systemd/user/t3-fleet-sync.timer", "[Timer]\n");
    put(f.home, ".config/systemd/user/t3-fleet-listen.service", "[Service]\n");
    put(f.root, "active/t3-fleet-sync.timer", "");
    put(f.root, "active/t3-fleet-listen.service", "");
    put(f.root, "stuck", "");
    const outcomes = await run(applyLeave(await f.plan(true, "linux")));
    const services = outcomes.find((o) => o.title.startsWith("Stop and remove"));
    expect(services).toMatchObject({ ok: false });
    expect(services?.lines.join("")).toContain("t3-fleet-sync.timer is still running");
    expect(exists(f.home, ".config/systemd/user/t3-fleet-sync.timer")).toBe(true);
    // Purge never ran.
    expect(exists(f.home, ".config/t3-fleet/age-key.txt")).toBe(true);
    fs.rmSync(join(f.root, "stuck"));
    const again = await run(applyLeave(await f.plan(true, "linux")));
    expect(again.every((o) => o.ok)).toBe(true);
    for (const unit of ["t3-fleet-sync.service", "t3-fleet-sync.timer", "t3-fleet-listen.service"])
      expect(exists(f.home, `.config/systemd/user/${unit}`)).toBe(false);
  });

  it("keeps a launchd plist whose job does not unload", () => {
    const root = fs.mkdtempSync(join(tmpdir(), "t3-fleet-launchd-"));
    put(root, "bin/launchctl", FAKE_LAUNCHCTL(root), 0o755);
    put(root, "loaded/dev.t3-fleet.models", "");
    put(root, "stuck", "");
    put(root, "Library/LaunchAgents/dev.t3-fleet.models.plist", "<plist/>");
    const r = spawnSync("sh", ["-c", removeService("darwin", "user", "models", 1)], {
      env: { ...process.env, HOME: root, PATH: `${root}/bin:${process.env["PATH"] ?? ""}` },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("still has dev.t3-fleet.models loaded");
    expect(fs.existsSync(join(root, "Library/LaunchAgents/dev.t3-fleet.models.plist"))).toBe(true);
  });

  it("refuses before anything changes when system units need root, saying what to run", async () => {
    const f = await makeFleet();
    put(f.root, "etc-systemd/t3-fleet-sync.timer", "[Timer]\n");
    put(f.root, "etc-systemd/t3-fleet-sync.service", "[Service]\n");
    const plan = await f.plan(true, "linux");
    expect(plan.steps).toEqual([]);
    expect(plan.refusal).toContain("only root can stop");
    expect(plan.refusal).toContain(
      "sudo sh -c 'systemctl disable --now t3-fleet-sync.timer t3-fleet-sync.service",
    );
    expect(plan.refusal).not.toContain("--user");
    expect(await run(applyLeave(plan))).toEqual([]);
    expect(onBranch(f.origin, "nodes/hub.toml", "t3-fleet/staging/laptop")).toBeNull();
    expect(exists(f.root, "etc-systemd/t3-fleet-sync.timer")).toBe(true);
    expect(exists(f.home, ".config/t3-fleet/age-key.txt")).toBe(true);
  });
});

describe("model routing", () => {
  it("refuses up front when T3 runs but its CLI cannot be found, and changes nothing", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    const settings = JSON.stringify({
      providers: { claudeAgent: { binaryPath: "t3-fleet-claude" } },
    });
    put(f.home, ".t3/userdata/settings.json", settings);
    put(f.home, ".local/bin/t3-fleet-claude", "#!/bin/sh\n", 0o755);
    // This test's own process stands in for a T3 server whose CLI cannot be found.
    put(
      f.home,
      ".t3/userdata/server-runtime.json",
      JSON.stringify({ pid: process.pid, origin: "http://127.0.0.1:1" }),
    );
    // Refused when it plans, before anything (the proxy above all) is stopped.
    const plan = await f.plan();
    expect(plan.refusal).toContain("quit T3 and run leave again");
    expect(plan.steps).toEqual([]);
    expect(await run(applyLeave(plan))).toEqual([]);
    expect(read(f.home, ".t3/userdata/settings.json")).toBe(settings);
    expect(exists(f.home, ".local/bin/t3-fleet-claude")).toBe(true);
  });

  it("removes only launchers T3's settings no longer use", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    put(
      f.home,
      ".t3/userdata/settings.json",
      JSON.stringify({ providerInstances: { pi: { driver: "pi", config: {} } } }),
    );
    put(f.home, ".local/bin/t3-fleet-claude", "#!/bin/sh\n", 0o755);
    const outcomes = await run(applyLeave(await f.plan()));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(exists(f.home, ".local/bin/t3-fleet-claude")).toBe(false);
  });
});

it("records the departure where a later run finds it", () => {
  expect(departurePath("/h")).toBe("/h/.local/state/t3-fleet/leave.json");
});

describe("writing the user's files", () => {
  it("writes nothing when the file changed since it was read", async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "t3-fleet-write-"));
    put(dir, "f.json", "theirs\n", 0o640);
    const result = await run(
      writeAtomically(join(dir, "f.json"), "ours\n", "what we read\n").pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    expect(read(dir, "f.json")).toBe("theirs\n");
    expect(fs.readdirSync(dir)).toEqual(["f.json"]);
    await run(writeAtomically(join(dir, "f.json"), "ours\n", "theirs\n"));
    expect(read(dir, "f.json")).toBe("ours\n");
    expect(modeOf(join(dir, "f.json"))).toBe(0o640);
  });
});

describe("T3's settings, through T3", () => {
  it("patches the legacy field and upserts an instance as it is on disk, binaryPath aside", () => {
    const settings = {
      providers: { claudeAgent: { binaryPath: "t3-fleet-claude" } },
      providerInstances: {
        codexMain: {
          driver: "codex",
          displayName: "Main",
          config: { binaryPath: "t3-fleet-codex", homePath: "/h" },
        },
      },
    };
    expect(
      settingsUpdates(settings, [
        { where: "legacy", id: "claudeAgent", launcher: "t3-fleet-claude", restore: null },
        { where: "instance", id: "codexMain", launcher: "t3-fleet-codex", restore: "/opt/codex" },
      ]),
    ).toEqual([
      {
        patch: { providers: { claudeAgent: { binaryPath: "claude" } } },
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: "codexMain",
          instance: {
            driver: "codex",
            displayName: "Main",
            config: { binaryPath: "/opt/codex", homePath: "/h" },
          },
        },
      },
    ]);
  });
});

// ---- review, round two: each of these failed before its fix ----------------

describe("round two", () => {
  it("keeps a backup whose restore was skipped because its destination changed after planning", async () => {
    const f = await makeFleet();
    const at = join(f.home, ".zshrc");
    fs.symlinkSync(join(f.repo, "dotfiles/zshrc"), at);
    put(f.home, ".local/state/t3-fleet/setup/moved/zshrc", "original user data");
    put(
      f.home,
      ".local/state/t3-fleet/setup/before.json",
      JSON.stringify({
        takenAt: 1,
        moved: [{ path: at, backup: join(f.home, ".local/state/t3-fleet/setup/moved/zshrc") }],
      }),
    );
    const plan = await f.plan(true);
    expect(titles(plan)).toContain("Put back what setup moved aside");
    fs.unlinkSync(at);
    fs.writeFileSync(at, "new user data");
    const outcomes = await run(applyLeave(plan));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(read(f.home, ".zshrc")).toBe("new user data");
    expect(read(f.home, ".local/state/t3-fleet/setup-backups/.zshrc")).toBe("original user data");
  });

  it("stages nested copies outside the copy, so a file named like the staging is left alone", async () => {
    const f = await makeFleet();
    put(f.repo, "skills/a/ref.md.t3-fleet-leave-nested", "legitimate sibling");
    fs.mkdirSync(join(f.home, ".agents/skills"), { recursive: true });
    fs.symlinkSync(join(f.repo, "skills/a"), join(f.home, ".agents/skills/a"));
    const outcomes = await run(applyLeave(await f.plan()));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(read(f.home, ".agents/skills/a/ref.md.t3-fleet-leave-nested")).toBe(
      "legitimate sibling",
    );
    expect(read(f.home, ".agents/skills/a/ref.md")).toBe("shared from the repo\n");
  });

  it("waits for Claude's lock and keeps what Claude wrote while holding it", async () => {
    const f = await makeFleet();
    const { fetchBefore } = setUpLaptop(f);
    const plan = await f.plan();
    const lock = join(f.home, ".claude.json.lock");
    fs.mkdirSync(lock);
    // Claude, holding its lock, writes a setting of its own, then lets go.
    // @effect-diagnostics-next-line globalTimers:off
    setTimeout(() => {
      const config = JSON.parse(read(f.home, ".claude.json")) as Record<string, unknown>;
      put(f.home, ".claude.json", JSON.stringify({ ...config, written: "by Claude" }, null, 2));
      fs.rmSync(lock, { recursive: true });
    }, 300);
    const outcomes = await run(applyLeave(plan));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    const claude = JSON.parse(read(f.home, ".claude.json")) as Record<string, unknown>;
    expect(claude["written"]).toBe("by Claude");
    expect((claude["mcpServers"] as Record<string, unknown>)["fetch"]).toEqual(fetchBefore);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("does not take a commit message for a departure: approval, auto-approval and sync go by the change", async () => {
    const f = await makeFleet();
    put(f.repo, "skills/new/SKILL.md", "new");
    git(f.repo, "add", "skills");
    git(f.repo, "commit", "-qm", "ordinary skills edit\n\nT3-Fleet-Departure: laptop");
    git(f.repo, "push", "-q", "origin", "HEAD:refs/heads/t3-fleet/staging/laptop");
    const [proposal] = await run(listProposals(f.hub, "main"));
    if (proposal === undefined) throw new Error("no proposal");
    // A skills-only change, approved as what it is: laptop stays.
    expect(autoApprovable(proposal, ["skills/"])).toBe(true);
    await run(approve(f.hub, "main", proposal, "hub"));
    expect(onBranch(f.origin, "nodes/laptop.toml")).not.toBeNull();
    expect(onBranch(f.origin, "skills/new/SKILL.md")).toBe("new");
  });

  it("never auto-approves a real departure, and sync protects only that", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    await run(applyLeave(await f.plan()));
    const [departure] = await run(listProposals(f.hub, "main"));
    if (departure === undefined) throw new Error("no proposal");
    // Under trusting prefixes, by its paths it would pass; as a departure it never does.
    expect(autoApprovable(departure, ["nodes/", "secrets/"])).toBe(true);
    expect(await run(autoApproves(f.hub, departure, ["nodes/", "secrets/"]))).toBe(false);
    // A marked proposal that is not a departure gets no protection from sync.
    git(f.repo, "fetch", "-q", "origin");
    git(f.repo, "reset", "-q", "--hard", "origin/main");
    put(f.repo, "skills/new/SKILL.md", "new");
    git(f.repo, "add", "skills");
    git(f.repo, "commit", "-qm", "not a departure\n\nT3-Fleet-Departure: laptop");
    git(f.repo, "push", "-q", "--force", "origin", "HEAD:refs/heads/t3-fleet/staging/laptop");
    git(f.repo, "reset", "-q", "--hard", "origin/main");
    const node = f.config.nodes.find((n) => n.name === "laptop");
    if (node === undefined) throw new Error("no laptop");
    await run(underSyncLock(exchange(f.config, node, [])));
    expect(
      spawnSync("git", ["rev-parse", "--verify", "-q", "t3-fleet/staging/laptop"], {
        cwd: f.origin,
      }).status,
    ).not.toBe(0);
  });

  it("goes by origin's role: a member since promoted to the only authority is refused, planned or running", async () => {
    const f = await makeFleet();
    const recorded = departureOf(f.config);
    put(f.hub, "nodes/hub.toml", 'roles = ["member"]\n');
    put(f.hub, "nodes/laptop.toml", 'roles = ["authority"]\n');
    commitAll(f.hub, "laptop is the only authority");
    const plan = await f.planFor(recorded);
    expect(plan.refusal).toContain("only authority");
    // Planned while hub was an authority too, demoted before it runs.
    put(f.hub, "nodes/hub.toml", 'roles = ["authority"]\n');
    commitAll(f.hub, "hub again");
    const ok = await f.planFor(recorded);
    expect(ok.refusal).toBeNull();
    put(f.hub, "nodes/hub.toml", 'roles = ["member"]\n');
    commitAll(f.hub, "hub demoted");
    const outcomes = await run(applyLeave(ok));
    expect(outcomes[0]).toMatchObject({ ok: false });
    expect(outcomes[0]?.lines.join("")).toContain("only authority");
    expect(onBranch(f.origin, "nodes/laptop.toml")).not.toBeNull();
    expect(
      spawnSync("git", ["rev-parse", "--verify", "-q", "t3-fleet/staging/laptop"], {
        cwd: f.origin,
      }).status,
    ).not.toBe(0);
  });

  it("refuses to resume a departure recorded for another enrollment", async () => {
    const f = await makeFleet();
    const old = {
      ...departureOf(f.config),
      enrollment: {
        remote: "https://example.com/old-fleet.git",
        key: f.recipients["laptop"] ?? null,
      },
    };
    put(f.home, ".local/state/t3-fleet/leave.json", JSON.stringify(old));
    const result = await run(currentDeparture(f.home).pipe(Effect.flip));
    expect(result).toContain("another enrollment");
    expect(result).toContain("old-fleet.git");
    // The same enrollment resumes.
    const remote = git(f.repo, "remote", "get-url", "origin").trim();
    put(
      f.home,
      ".local/state/t3-fleet/leave.json",
      JSON.stringify({ ...old, enrollment: { remote, key: f.recipients["laptop"] ?? null } }),
    );
    expect((await run(currentDeparture(f.home))).resumed).toBe(true);
  });

  it("records a departure with nothing left to do as finished", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    await run(applyLeave(await f.plan()));
    put(
      f.home,
      ".local/state/t3-fleet/leave.json",
      read(f.home, ".local/state/t3-fleet/leave.json").replace(
        '"finished":true',
        '"finished":false',
      ),
    );
    const { departure } = await run(currentDeparture(f.home));
    const plan = await f.planFor(departure);
    expect(plan.steps).toEqual([]);
    await run(applyLeave(plan));
    expect(JSON.parse(read(f.home, ".local/state/t3-fleet/leave.json")).finished).toBe(true);
  });

  it("restores T3's settings only where they still name the planned launcher", () => {
    const routed = [
      {
        where: "legacy" as const,
        id: "codex",
        launcher: "t3-fleet-codex",
        restore: "/old/user/choice",
      },
    ];
    const newer = { providers: { codex: { binaryPath: "/new/user/choice" } } };
    expect(settingsUpdates(newer, routed)).toEqual([]);
    expect(unrouted(newer, routed)).toEqual(newer);
  });

  it("keeps a unit whose state systemctl could not report", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    put(
      f.root,
      "bin/systemctl",
      '#!/bin/sh\n[ "$1" = --user ] && shift\n[ "$1" = daemon-reload ] && exit 0\necho "Failed to connect to bus" >&2\nexit 1\n',
      0o755,
    );
    put(f.home, ".config/systemd/user/t3-fleet-models.service", "unit");
    const outcomes = await run(applyLeave(await f.plan(false, "linux")));
    const services = outcomes.find((o) => o.title.startsWith("Stop and remove"));
    expect(services).toMatchObject({ ok: false });
    expect(services?.lines.join("")).toContain(
      "could not tell whether t3-fleet-models.service stopped",
    );
    expect(exists(f.home, ".config/systemd/user/t3-fleet-models.service")).toBe(true);
  });

  it("keeps a launchd plist when launchctl cannot say the job is gone", () => {
    const root = fs.mkdtempSync(join(tmpdir(), "t3-fleet-launchd-"));
    put(root, "bin/launchctl", '#!/bin/sh\n[ "$1" = print ] && exit 5\nexit 0\n', 0o755);
    put(root, "Library/LaunchAgents/dev.t3-fleet.sync.plist", "<plist/>");
    const r = spawnSync("sh", ["-c", removeService("darwin", "user", "sync", 1)], {
      env: { ...process.env, HOME: root, PATH: `${root}/bin:${process.env["PATH"] ?? ""}` },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not tell whether launchd unloaded dev.t3-fleet.sync");
    expect(fs.existsSync(join(root, "Library/LaunchAgents/dev.t3-fleet.sync.plist"))).toBe(true);
  });

  it("keeps an MCP entry whose fields the user changed, though its URL is T3 Fleet's", async () => {
    const f = await makeFleet();
    setUpLaptop(f);
    const config = JSON.parse(read(f.home, ".claude.json")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    config.mcpServers["fetch"] = {
      ...config.mcpServers["fetch"],
      headers: { Authorization: "Bearer user-new-token" },
      disabled: true,
    };
    put(f.home, ".claude.json", JSON.stringify(config));
    const plan = await f.plan();
    expect(planText(plan)).toContain("fetch in Claude was changed since T3 Fleet registered it");
    await run(applyLeave(plan));
    const after = (JSON.parse(read(f.home, ".claude.json")) as typeof config).mcpServers["fetch"];
    expect(after).toMatchObject({
      disabled: true,
      headers: { Authorization: "Bearer user-new-token" },
    });
  });

  it("does not restore a backup over the user's own link to another repo file", async () => {
    const f = await makeFleet();
    setUpLaptop(f);
    const at = join(f.home, ".zprofile");
    fs.unlinkSync(at);
    fs.symlinkSync(join(f.repo, "skills/shared/ref.md"), at);
    await run(applyLeave(await f.plan()));
    expect(fs.readlinkSync(at)).toBe(join(f.repo, "skills/shared/ref.md"));
    expect(read(f.home, ".local/state/t3-fleet/setup/moved/zprofile")).toBe("my zprofile\n");
  });

  it("leaves a skill that links back into itself as a link, and says so", async () => {
    const f = await makeFleet();
    fs.symlinkSync(join(f.repo, "skills/a"), join(f.repo, "skills/a/self"));
    fs.mkdirSync(join(f.home, ".agents/skills"), { recursive: true });
    fs.symlinkSync(join(f.repo, "skills/a"), join(f.home, ".agents/skills/a"));
    const plan = await f.plan();
    expect(planText(plan)).toContain("~/.agents/skills/a is left a link");
    expect(plan.steps.some((s) => s.title.startsWith("Turn"))).toBe(false);
    await run(applyLeave(plan));
    expect(isLink(join(f.home, ".agents/skills/a"))).toBe(true);
  });

  it("reports a failed session revoke, even when sending failed too", async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "t3-fleet-t3-"));
    put(
      dir,
      "t3",
      '#!/bin/sh\ncase "$3" in issue) echo \'{"sessionId":"s1","token":"tok"}\' ;; revoke) echo "no such session" >&2; exit 1 ;; esac\n',
      0o755,
    );
    const result = await run(
      throughT3(
        {
          _tag: "running",
          origin: "http://127.0.0.1:1",
          cli: { command: join(dir, "t3"), args: [], env: {} },
        },
        [{ where: "legacy", id: "codex", launcher: "t3-fleet-codex", restore: null }],
      ).pipe(Effect.flip),
    );
    expect(result).toContain("did not answer");
    expect(result).toContain("revoking T3 session s1 failed");
    expect(result).toContain("t3 auth session revoke s1");
  });

  it("refuses to replace a Claude config that is a link to nothing", async () => {
    const f = await makeFleet();
    setUpLaptop(f);
    fs.rmSync(join(f.home, ".claude.json"));
    fs.symlinkSync(join(f.home, "dotfiles/claude.json"), join(f.home, ".claude.json"));
    const outcomes = await run(applyLeave(await f.plan()));
    const mcp = outcomes.find((o) => o.title.startsWith("Put back the MCP servers"));
    expect(mcp).toMatchObject({ ok: false });
    expect(mcp?.lines.join("")).toContain("which is missing; leaving it as it is");
    expect(isLink(join(f.home, ".claude.json"))).toBe(true);
  });

  it("finishes moving a backup back after its destination's link went into staging", async () => {
    const f = await makeFleet();
    const at = join(f.home, "custom/data");
    const backup = join(f.home, ".local/state/t3-fleet/setup/moved/data");
    const staging = join(f.home, "custom/.data.t3-fleet-leave-ABC123");
    put(
      staging,
      "marker.json",
      JSON.stringify({ path: at, source: backup, how: "move", ready: true }),
    );
    fs.symlinkSync(join(f.repo, "skills/a"), join(staging, "link"));
    put(backup, "mine", "original user data");
    put(
      f.home,
      ".local/state/t3-fleet/setup/before.json",
      JSON.stringify({ takenAt: 1, moved: [{ path: at, backup }] }),
    );
    const outcomes = await run(applyLeave(await f.plan(true)));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(read(f.home, "custom/data/mine")).toBe("original user data");
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("keeps an unfinished copy when someone else's directory is at its destination now", async () => {
    const f = await makeFleet();
    const at = join(f.home, ".agents/skills/a");
    const staging = join(f.home, ".agents/skills/.a.t3-fleet-leave-ABC123");
    put(staging, "copy/SKILL.md", "a copied");
    put(staging, "copy/unsaved", "only copy of user edit");
    put(
      staging,
      "marker.json",
      JSON.stringify({ path: at, source: join(f.repo, "skills/a"), how: "copy", ready: true }),
    );
    put(at, "new", "new user directory");
    const outcomes = await run(applyLeave(await f.plan()));
    expect(outcomes.find((o) => o.title.startsWith("Turn"))?.lines.join("\n")).toContain(
      "are left as they are",
    );
    expect(read(f.home, ".agents/skills/.a.t3-fleet-leave-ABC123/copy/unsaved")).toBe(
      "only copy of user edit",
    );
    expect(read(f.home, ".agents/skills/a/new")).toBe("new user directory");
  });
});

// ---- review, round three ------------------------------------------------------

/**
 * A T3 server, as far as leave talks to it: a WebSocket ticket over HTTP, and
 * server.getSettings and server.updateSettings over a WebSocket (one JSON
 * message per text frame). `onTicket` runs when the ticket is asked for: a
 * user changing settings while leave is getting its session.
 */
const fakeT3 = async (
  live: { providerInstances: Record<string, Record<string, unknown>> },
  onTicket: () => void,
) => {
  const updates: Array<unknown> = [];
  const server = createServer((_req, res) => {
    onTicket();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ticket: "t" }));
  });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1")
      .update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (value: unknown) => {
      const body = Buffer.from(JSON.stringify(value));
      const head =
        body.length < 126
          ? Buffer.from([129, body.length])
          : body.length < 65536
            ? Buffer.from([129, 126, body.length >> 8, body.length & 255])
            : Buffer.alloc(0);
      socket.write(Buffer.concat([head, body]));
    };
    let pending = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 2) {
        const op = (pending[0] ?? 0) & 15;
        let size = (pending[1] ?? 0) & 127;
        let offset = 2;
        if (size === 126) {
          if (pending.length < 4) return;
          size = pending.readUInt16BE(2);
          offset = 4;
        }
        const masked = ((pending[1] ?? 0) & 128) !== 0;
        if (pending.length < offset + (masked ? 4 : 0) + size) return;
        const mask = masked ? pending.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        const body = Buffer.from(pending.subarray(offset, offset + size));
        if (mask !== null)
          for (let i = 0; i < body.length; i++) body[i] = (body[i] ?? 0) ^ (mask[i % 4] ?? 0);
        pending = pending.subarray(offset + size);
        if (op === 8) {
          socket.end();
          continue;
        }
        if (op !== 1) continue;
        const parsed = JSON.parse(body.toString()) as unknown;
        for (const msg of (Array.isArray(parsed) ? parsed : [parsed]) as Array<
          Record<string, unknown>
        >) {
          if (msg["_tag"] !== "Request") continue;
          const payload = msg["payload"] as Record<string, unknown>;
          if (msg["tag"] === "server.updateSettings") {
            updates.push(payload);
            const mutation = payload["providerInstanceMutation"] as
              | { instanceId: string; instance: Record<string, unknown> }
              | undefined;
            if (mutation !== undefined)
              live.providerInstances[mutation.instanceId] = mutation.instance;
          }
          send({
            _tag: "Exit",
            requestId: msg["id"],
            exit: { _tag: "Success", value: msg["tag"] === "server.getSettings" ? live : {} },
          });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { origin: `http://127.0.0.1:${port}`, updates, close };
};

describe("round three", () => {
  it("keeps setup's directory whole when the snapshot cannot be read", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    put(f.home, ".local/state/t3-fleet/setup/moved/original", "only copy of user's data");
    put(f.home, ".local/state/t3-fleet/setup/before.json", "{interrupted snapshot");
    const plan = await f.plan(true);
    expect(planText(plan)).toContain("is kept whole");
    const outcomes = await run(applyLeave(plan));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(read(f.home, ".local/state/t3-fleet/setup-backups/setup/moved/original")).toBe(
      "only copy of user's data",
    );
    expect(exists(f.home, ".config/t3-fleet")).toBe(false);
  });

  it("keeps setup's directory whole when it holds anything the snapshot does not list", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    put(f.home, ".local/state/t3-fleet/setup/backup/unlisted", "user data");
    put(
      f.home,
      ".local/state/t3-fleet/setup/before.json",
      JSON.stringify({ takenAt: 1, moved: [] }),
    );
    const outcomes = await run(applyLeave(await f.plan(true)));
    expect(outcomes.at(-1)?.lines.join("\n")).toContain(
      "it still holds 2 things the snapshot does not account for",
    );
    expect(read(f.home, ".local/state/t3-fleet/setup-backups/setup/backup/unlisted")).toBe(
      "user data",
    );
  });

  it("keeps a backup that is a link to nothing, by lstat", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    const backup = join(f.home, ".local/state/t3-fleet/setup/moved/old-link");
    fs.mkdirSync(dirname(backup), { recursive: true });
    fs.symlinkSync("/missing/user-target", backup);
    put(f.home, "old-link", "new user's content");
    put(
      f.home,
      ".local/state/t3-fleet/setup/before.json",
      JSON.stringify({ takenAt: 1, moved: [{ path: join(f.home, "old-link"), backup }] }),
    );
    const outcomes = await run(applyLeave(await f.plan(true)));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    const kept = join(f.home, ".local/state/t3-fleet/setup-backups/old-link");
    expect(fs.readlinkSync(kept)).toBe("/missing/user-target");
    expect(read(f.home, "old-link")).toBe("new user's content");
  });

  it("refuses a departure recorded for another checkout, though name, origin and key are the same", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    const recorded = {
      ...departureOf(f.config),
      enrollment: await run(enrollmentOf(f.home, f.repo, true)),
    };
    put(f.home, ".local/state/t3-fleet/leave.json", JSON.stringify(recorded));
    // Joined again as laptop, with the same key, into a new checkout.
    const fresh = join(f.root, "fresh-checkout");
    git(f.root, "clone", "-q", f.origin, fresh);
    put(f.home, ".config/t3-fleet/config.toml", `repo = "${fresh}"\nnode = "laptop"\n`);
    const elsewhere = await run(currentDeparture(f.home).pipe(Effect.flip));
    expect(elsewhere).toContain("another enrollment");
    expect(elsewhere).toContain(`its checkout is ${fs.realpathSync(fresh)}`);
    // Or into a fresh clone in the very same place.
    put(f.home, ".config/t3-fleet/config.toml", `repo = "${f.repo}"\nnode = "laptop"\n`);
    fs.rmSync(f.repo, { recursive: true });
    git(f.root, "clone", "-q", f.origin, f.repo);
    const reclone = await run(currentDeparture(f.home).pipe(Effect.flip));
    expect(reclone).toContain("its checkout is a new clone");
    // The old checkout itself resumes.
    fs.writeFileSync(join(f.repo, ".git", ENROLLMENT_ID), `${recorded.enrollment.id}\n`);
    expect((await run(currentDeparture(f.home))).resumed).toBe(true);
  });

  it("checks who the machine is again under the lock, and runs nothing when it changed after planning", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    const plan = await f.plan(true);
    // Re-keyed while the plan waited for its confirmation.
    put(f.home, ".config/t3-fleet/age-key.txt", `${await generateX25519Identity()}\n`, 0o600);
    const refused = await run(applyLeave(plan).pipe(Effect.flip));
    expect(refused).toContain("this machine changed since leave planned");
    expect(refused).toContain("its key is another one");
    expect(exists(f.home, ".config/t3-fleet/age-key.txt")).toBe(true);
    expect(exists(f.home, ".local/state/t3-fleet/leave.json")).toBe(false);
    expect(
      spawnSync("git", ["rev-parse", "--verify", "-q", "t3-fleet/staging/laptop"], {
        cwd: f.origin,
      }).status,
    ).not.toBe(0);
  });

  it("sends T3's instance as T3 has it just before the update, keeping edits made meanwhile", async () => {
    const live = {
      providerInstances: {
        custom: {
          driver: "codex",
          displayName: "Before",
          enabled: true,
          config: { binaryPath: "t3-fleet-codex", homePath: "/old" },
        } as Record<string, unknown>,
      },
    };
    // The user edits the instance while leave gets its session and ticket.
    const t3 = await fakeT3(live, () => {
      live.providerInstances.custom = {
        ...live.providerInstances.custom,
        displayName: "User new name",
        enabled: false,
        config: { binaryPath: "t3-fleet-codex", homePath: "/new" },
      };
    });
    const dir = fs.mkdtempSync(join(tmpdir(), "t3-fleet-t3-"));
    put(
      dir,
      "t3",
      '#!/bin/sh\ncase "$3" in issue) echo \'{"sessionId":"s1","token":"tok"}\' ;; revoke) echo "Revoked session s1" ;; esac\n',
      0o755,
    );
    try {
      await run(
        throughT3(
          {
            _tag: "running",
            origin: t3.origin,
            cli: { command: join(dir, "t3"), args: [], env: {} },
          },
          [{ where: "instance", id: "custom", launcher: "t3-fleet-codex", restore: "codex" }],
        ),
      );
      expect(t3.updates).toHaveLength(1);
      expect(live.providerInstances.custom).toEqual({
        driver: "codex",
        displayName: "User new name",
        enabled: false,
        config: { binaryPath: "codex", homePath: "/new" },
      });
    } finally {
      await t3.close();
    }
  });

  it("sends nothing to T3 when the instance stopped naming the launcher before the update", async () => {
    const live = {
      providerInstances: {
        custom: { driver: "codex", config: { binaryPath: "t3-fleet-codex" } } as Record<
          string,
          unknown
        >,
      },
    };
    const t3 = await fakeT3(live, () => {
      live.providerInstances.custom = { driver: "codex", config: { binaryPath: "/my/codex" } };
    });
    const dir = fs.mkdtempSync(join(tmpdir(), "t3-fleet-t3-"));
    put(
      dir,
      "t3",
      '#!/bin/sh\ncase "$3" in issue) echo \'{"sessionId":"s1","token":"tok"}\' ;; revoke) echo "Revoked session s1" ;; esac\n',
      0o755,
    );
    try {
      await run(
        throughT3(
          {
            _tag: "running",
            origin: t3.origin,
            cli: { command: join(dir, "t3"), args: [], env: {} },
          },
          [{ where: "instance", id: "custom", launcher: "t3-fleet-codex", restore: "codex" }],
        ),
      );
      expect(t3.updates).toEqual([]);
      expect(live.providerInstances.custom).toEqual({
        driver: "codex",
        config: { binaryPath: "/my/codex" },
      });
    } finally {
      await t3.close();
    }
  });
});

describe("an unfinished departure, and setup", () => {
  it("is what setup refuses to start over, until leave finishes it or it is retired", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    expect((await run(unfinishedDeparture(f.home)))._tag).toBe("None");
    put(
      f.home,
      ".local/state/t3-fleet/leave.json",
      JSON.stringify({ ...departureOf(f.config), finished: false }),
    );
    expect(await run(unfinishedDeparture(f.home))).toMatchObject({ value: { node: "laptop" } });
    const to = await run(retireDeparture(f.home));
    expect(to).toMatch(/\/leave-retired-\d+\.json$/);
    expect(JSON.parse(fs.readFileSync(to ?? "", "utf8"))).toMatchObject({ node: "laptop" });
    expect((await run(unfinishedDeparture(f.home)))._tag).toBe("None");
    expect((await run(currentDeparture(f.home))).resumed).toBe(false);
    expect(await run(retireDeparture(f.home))).toBeNull();
  });
});

// ---- the final review ------------------------------------------------------------

describe("final review", () => {
  for (const [change, says] of [
    ["deletes the key", "its key is gone or cannot be read"],
    ["corrupts the key", "its key is gone or cannot be read"],
    ["removes origin", "its config repo origin is gone or cannot be read"],
  ] as const)
    it(`runs nothing when, after planning, the machine ${change}`, async () => {
      const f = await makeFleet({ node: 'roles = ["member"]\n' });
      const plan = await f.plan(true);
      if (change === "deletes the key") fs.rmSync(join(f.home, ".config/t3-fleet/age-key.txt"));
      else if (change === "corrupts the key")
        put(f.home, ".config/t3-fleet/age-key.txt", "not an identity\n", 0o600);
      else git(f.repo, "remote", "remove", "origin");
      const refused = await run(applyLeave(plan).pipe(Effect.flip));
      expect(refused).toContain("this machine changed since leave planned");
      expect(refused).toContain(says);
      expect(exists(f.home, ".local/state/t3-fleet/leave.json")).toBe(false);
      expect(exists(f.home, ".config/t3-fleet/config.toml")).toBe(true);
      expect(
        spawnSync("git", ["rev-parse", "--verify", "-q", "t3-fleet/staging/laptop"], {
          cwd: f.origin,
        }).status,
      ).not.toBe(0);
    });

  it("keeps setup's directory when it holds an empty directory nobody listed", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    fs.mkdirSync(join(f.home, ".local/state/t3-fleet/setup/unlisted-empty-backup"), {
      recursive: true,
    });
    put(
      f.home,
      ".local/state/t3-fleet/setup/before.json",
      JSON.stringify({ takenAt: 1, moved: [] }),
    );
    const outcomes = await run(applyLeave(await f.plan(true)));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(
      fs
        .statSync(join(f.home, ".local/state/t3-fleet/setup-backups/setup/unlisted-empty-backup"))
        .isDirectory(),
    ).toBe(true);
  });

  it("removes setup's directory when what is left are only the snapshot and its backups' emptied places", async () => {
    const f = await makeFleet();
    const backup = join(f.home, ".local/state/t3-fleet/setup/backup/1/.agents/skills/b");
    put(backup, "SKILL.md", "b before setup\n");
    fs.mkdirSync(join(f.home, ".agents/skills"), { recursive: true });
    fs.symlinkSync(join(f.repo, "skills/b"), join(f.home, ".agents/skills/b"));
    put(
      f.home,
      ".local/state/t3-fleet/setup/before.json",
      JSON.stringify({ takenAt: 1, moved: [{ path: "~/.agents/skills/b", backup }] }),
    );
    const outcomes = await run(applyLeave(await f.plan(true)));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(read(f.home, ".agents/skills/b/SKILL.md")).toBe("b before setup\n");
    expect(exists(f.home, ".local/state/t3-fleet/setup")).toBe(false);
    expect(exists(f.home, ".local/state/t3-fleet/setup-backups")).toBe(false);
  });

  it("says where --retire --dry-run would set the record aside, and moves nothing", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    put(f.home, ".local/state/t3-fleet/leave.json", JSON.stringify(departureOf(f.config)));
    const to = await run(retireDeparture(f.home, { dryRun: true }));
    expect(to).toMatch(/\/leave-retired-\d+\.json$/);
    expect(exists(f.home, ".local/state/t3-fleet/leave.json")).toBe(true);
    expect(fs.existsSync(to ?? "")).toBe(false);
    expect((await run(unfinishedDeparture(f.home)))._tag).toBe("Some");
  });

  it("lets an authority's own sync approve a member's ordinary edit of its node file, never a departure", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    put(
      f.hub,
      "t3-fleet.toml",
      '[fleet]\nbranch = "main"\nauto_commit = ["skills/", "nodes/"]\nauto_approve = ["nodes/", "secrets/"]\n',
    );
    commitAll(f.hub, "trust nodes/");
    git(f.repo, "pull", "-q", "--ff-only", "origin", "main");
    // The member edits its own node file; its sync proposes it.
    put(f.repo, "nodes/laptop.toml", 'roles = ["member"]\n[mcp]\nservers = []\n');
    const member = await run(loadConfigFrom(f.repo, "laptop"));
    const laptop = member.nodes.find((n) => n.name === "laptop");
    if (laptop === undefined) throw new Error("no laptop");
    await run(underSyncLock(exchange(member, laptop, [])));
    // The authority's own sync, unattended, approves it.
    const authorityHome = join(f.root, "hub-home");
    process.env["HOME"] = authorityHome;
    put(
      authorityHome,
      ".config/t3-fleet/gitconfig",
      "[user]\n\tname = T\n\temail = t@example.com\n",
    );
    put(authorityHome, ".config/t3-fleet/age-key.txt", `${f.keys["hub"]}\n`, 0o600);
    const authority = await run(loadConfigFrom(f.hub, "hub"));
    const hub = authority.nodes.find((n) => n.name === "hub");
    if (hub === undefined) throw new Error("no hub");
    const lines: Array<string> = [];
    await run(underSyncLock(exchange(authority, hub, lines)));
    expect(lines.join("\n")).toContain("approved laptop's proposal");
    expect(onBranch(f.origin, "nodes/laptop.toml")).toContain("servers = []");
    // A real departure under the same trust stays for a person to approve.
    process.env["HOME"] = f.home;
    git(f.repo, "checkout", "-q", "--", ".");
    git(f.repo, "pull", "-q", "--ff-only", "origin", "main");
    const again = await run(loadConfigFrom(f.repo, "laptop"));
    await run(applyLeave(await f.planFor(departureOf(again))));
    process.env["HOME"] = authorityHome;
    const after: Array<string> = [];
    await run(underSyncLock(exchange(await run(loadConfigFrom(f.hub, "hub")), hub, after)));
    expect(after.join("\n")).not.toContain("approved laptop's");
    expect(onBranch(f.origin, "nodes/laptop.toml")).not.toBeNull();
    expect(onBranch(f.origin, "nodes/hub.toml", "t3-fleet/staging/laptop")).not.toBeNull();
  });
});

// ---- #27: both files of the secrets, in one commit ----------------------------------

describe("the secrets' two files, from a recipients.toml written before encrypted-for", () => {
  /** What `rev` changed under secrets/: both files, or the test says which. */
  const secretsChanged = (repo: string, rev: string) =>
    git(repo, "diff", "--name-only", `${rev}^`, rev, "--", "secrets/").trim().split("\n").sort();
  const legacy = (f: Fleet) => {
    const text = onBranch(f.origin, "secrets/recipients.toml") ?? "";
    expect(text).not.toContain("# encrypted-for:");
  };

  it("an authority's removal commits both, recording the set the secrets were encrypted to", async () => {
    const f = await makeFleet({ self: "hub", desk: "authority" });
    legacy(f);
    expect((await run(applyLeave(await f.plan()))).every((o) => o.ok)).toBe(true);
    expect(secretsChanged(f.origin, "main")).toEqual([
      "secrets/recipients.toml",
      "secrets/secrets.env.age",
    ]);
    const { hub: _hub, ...rest } = f.recipients;
    expect(encryptedForIn(onBranch(f.origin, "secrets/recipients.toml") ?? "")).toBe(
      await run(recipientSet(Object.values(rest))),
    );
    expect(git(f.hub, "status", "--porcelain")).toBe("");
  });

  it("a member's proposal and its approval each commit both, and both checkouts are clean", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    legacy(f);
    await run(applyLeave(await f.plan()));
    const staging = "t3-fleet/staging/laptop";
    expect(secretsChanged(f.origin, staging)).toEqual([
      "secrets/recipients.toml",
      "secrets/secrets.env.age",
    ]);
    const { laptop: _laptop, ...rest } = f.recipients;
    const remaining = await run(recipientSet(Object.values(rest)));
    expect(encryptedForIn(onBranch(f.origin, "secrets/recipients.toml", staging) ?? "")).toBe(
      remaining,
    );
    await expect(
      decrypt(f.keys["laptop"] ?? "", onBranch(f.origin, "secrets/secrets.env.age", staging) ?? ""),
    ).rejects.toThrow();
    expect(git(f.repo, "status", "--porcelain")).toBe("");
    // An authority approves it: one commit, both files, its own copy encrypted again.
    const hubHome = join(f.root, "hub-home");
    process.env["HOME"] = hubHome;
    put(hubHome, ".config/t3-fleet/gitconfig", "[user]\n\tname = T\n\temail = t@example.com\n");
    put(hubHome, ".config/t3-fleet/age-key.txt", `${f.keys["hub"]}\n`, 0o600);
    const [proposal] = await run(listProposals(f.hub, "main"));
    if (proposal === undefined) throw new Error("no proposal");
    await run(approve(f.hub, "main", proposal, "hub"));
    expect(secretsChanged(f.origin, "main")).toEqual([
      "secrets/recipients.toml",
      "secrets/secrets.env.age",
    ]);
    expect(encryptedForIn(onBranch(f.origin, "secrets/recipients.toml") ?? "")).toBe(remaining);
    expect(
      await decrypt(f.keys["hub"] ?? "", onBranch(f.origin, "secrets/secrets.env.age") ?? ""),
    ).toContain("API=one");
    expect(git(f.hub, "status", "--porcelain")).toBe("");
  });
});

describe("a proposal that cannot be read", () => {
  it("is never approved unattended: an undiffable commit needs a person", async () => {
    const f = await makeFleet({ node: 'roles = ["member"]\n' });
    put(
      f.hub,
      "t3-fleet.toml",
      '[fleet]\nbranch = "main"\nauto_approve = ["nodes/", "secrets/", "skills/"]\n',
    );
    commitAll(f.hub, "trust nodes/");
    // A root commit on laptop's staging branch: it has no parent to diff against.
    const scratch = join(f.root, "orphan");
    git(f.root, "init", "-q", "-b", "x", "orphan");
    put(scratch, "skills/x/SKILL.md", "x\n");
    git(scratch, "add", "-A");
    git(scratch, "commit", "-qm", "orphan");
    git(scratch, "push", "-q", f.origin, "HEAD:refs/heads/t3-fleet/staging/laptop");
    const commit = git(scratch, "rev-parse", "HEAD").trim();
    expect(await run(isDeparture(f.hub, commit, "laptop").pipe(Effect.flip))).toContain(
      "cannot tell what",
    );
    const proposal = {
      node: "laptop",
      branch: "t3-fleet/staging/laptop",
      commit,
      files: [] as Array<string>,
      stat: "",
    };
    expect(autoApprovable(proposal, ["nodes/"])).toBe(true);
    expect(await run(autoApproves(f.hub, proposal, ["nodes/"]))).toBe(false);
    // The authority's own sync, unattended: nothing is approved, the proposal stays.
    const hubHome = join(f.root, "hub-home");
    process.env["HOME"] = hubHome;
    put(hubHome, ".config/t3-fleet/gitconfig", "[user]\n\tname = T\n\temail = t@example.com\n");
    put(hubHome, ".config/t3-fleet/age-key.txt", `${f.keys["hub"]}\n`, 0o600);
    const main = git(f.origin, "rev-parse", "main").trim();
    const config = await run(loadConfigFrom(f.hub, "hub"));
    const hub = config.nodes.find((n) => n.name === "hub");
    if (hub === undefined) throw new Error("no hub");
    const lines: Array<string> = [];
    await run(underSyncLock(exchange(config, hub, lines)));
    expect(lines.join("\n")).not.toContain("approved laptop's");
    expect(git(f.origin, "rev-parse", "main").trim()).toBe(main);
    expect(git(f.origin, "rev-parse", "t3-fleet/staging/laptop").trim()).toBe(commit);
    expect(onBranch(f.origin, "nodes/laptop.toml")).not.toBeNull();
  });
});
