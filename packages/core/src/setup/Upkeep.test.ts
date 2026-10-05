// What each of setup's switches writes, on and off: [fleet] apply and [defaults.t3] update,
// [notify], [defaults.mcp] hub; the ntfy topic kept as a secret; the hub's steps; byChoice.
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_APPLY,
  isNtfyUrl,
  KEEP_AREAS,
  newNtfyUrl,
  NTFY_SECRET,
  UPDATE_AREAS,
} from "../Upkeep.ts";
import {
  mcpHubEdits,
  persistable,
  pushesToNtfy,
  restored,
  secretsToStore,
  settingsLines,
  upkeepEdits,
  upkeepFor,
  type SetupInput,
  type Upkeep,
} from "./Apply.ts";
import { fromClaude, secretNamer } from "./Credentials.ts";
import type { Discovery, FoundServer, SkillCopy } from "./Discover.ts";
import { buildPlan, EMPTY_FLEET, type FleetView } from "./Plan.ts";
import { hubStepTitles } from "./PlanWords.ts";
import { newFleetFile } from "./Repo.ts";
import { edits } from "./TomlEdit.ts";
import { upkeepOf, uiConflicts } from "./Wizard.ts";

const fresh = newFleetFile({ checkout: "~/fleet", servers: ["ctx"], instructions: [] });

const written = (upkeep: Upkeep | undefined, text = fresh) => {
  const edit = edits(text, ...upkeepEdits(upkeep, "laptop"));
  if ("error" in edit) throw new Error(edit.error);
  return {
    text: edit.text,
    toml: parseToml(edit.text) as {
      fleet: Record<string, unknown>;
      defaults: Record<string, Record<string, unknown> | undefined>;
      notify?: Record<string, unknown>;
    },
  };
};

const off: Upkeep = { autoUpdate: null, desktop: false, ntfy: null };
const URL = "https://ntfy.sh/t3fleet0abcdefghijklmnopqrstuvw";

describe("keep things up to date automatically", () => {
  it("on: sync applies every safe area, updates included, and T3 updates when no thread runs", () => {
    const { toml, text } = written({ ...off, autoUpdate: true });
    expect(toml.fleet["apply"]).toEqual([...DEFAULT_APPLY]);
    expect(DEFAULT_APPLY).toEqual(expect.arrayContaining([...UPDATE_AREAS, ...KEEP_AREAS]));
    expect(toml.defaults["t3"]).toEqual({ update: "when-idle" });
    expect(text).toContain("# Areas whose safe fixes sync applies by itself; updates included");
  });

  it("off: only what keeps a machine the fleet's; the updates wait for the user", () => {
    const { toml } = written({ ...off, autoUpdate: false });
    expect(toml.fleet["apply"]).toEqual([...KEEP_AREAS]);
    for (const area of UPDATE_AREAS) expect(toml.fleet["apply"]).not.toContain(area);
    expect(toml.defaults["t3"]).toBeUndefined();
    // Turned off on a fleet that had it on: T3 goes back to being offered, not done.
    const before = written({ ...off, autoUpdate: true }).text;
    expect(written({ ...off, autoUpdate: false }, before).toml.defaults["t3"]).toEqual({
      update: "manual",
    });
  });

  it("not asked (a fleet being joined): its own [fleet] apply stays", () => {
    expect(written(off).text).toBe(fresh);
    expect(written(undefined).text).toBe(fresh);
    expect(upkeepFor("join", { autoUpdate: true, desktop: false, ntfy: null }).autoUpdate).toBe(
      null,
    );
  });
});

describe("notifications", () => {
  it("on this computer: this node in [notify] desktop, once", () => {
    const once = written({ ...off, desktop: true });
    expect(once.toml.notify).toEqual({ desktop: ["laptop"] });
    expect(written({ ...off, desktop: true }, once.text).text).toBe(once.text);
    // Another machine joins the list; it does not replace it.
    const desk = edits(once.text, ...upkeepEdits({ ...off, desktop: true }, "desk"));
    expect("text" in desk && parseToml(desk.text)["notify"]).toEqual({
      desktop: ["laptop", "desk"],
    });
  });

  it("off: no [notify] at all", () => {
    expect(written(off).toml.notify).toBeUndefined();
  });

  it("to a phone: [notify] ntfy names the secret; the topic is stored as it, never saved with the run", () => {
    const { toml, text } = written({ ...off, ntfy: { url: URL } });
    expect(toml.notify).toEqual({ ntfy: NTFY_SECRET });
    expect(text).not.toContain(URL);
    expect(pushesToNtfy(text)).toBe(true);
    expect(pushesToNtfy(fresh)).toBe(false);

    const input = {
      join: null,
      remote: null,
      actions: { secrets: [] },
      extras: { relay: null, models: null, t3: false },
      upkeep: { ...off, ntfy: { url: URL } },
    } as unknown as SetupInput;
    expect(secretsToStore(input)).toEqual([
      { name: NTFY_SECRET, value: URL, where: "the ntfy topic setup made" },
    ]);
    const saved = persistable(input);
    expect(JSON.stringify(saved)).not.toContain(URL);
    expect(restored(saved, `${NTFY_SECRET}=${URL}\n`)).toMatchObject({
      upkeep: { ntfy: { url: URL } },
    });
    expect(restored(saved, "")).toEqual({ missing: [NTFY_SECRET] });
    expect(secretsToStore({ ...input, upkeep: off })).toEqual([]);
  });

  it("makes topics nobody guesses, and refuses ones it did not make", () => {
    const a = newNtfyUrl();
    expect(isNtfyUrl(a)).toBe(true);
    expect(a).not.toBe(newNtfyUrl());
    expect(isNtfyUrl("https://ntfy.sh/alerts")).toBe(false);
    expect(isNtfyUrl(`http://ntfy.sh/${"a".repeat(30)}`)).toBe(false);
    expect(isNtfyUrl(`https://evil.example/${"a".repeat(30)}`)).toBe(false);
  });
});

describe("the MCP hub", () => {
  it("on: [defaults.mcp] hub, its gateway the relay's URL, the fleet's servers kept", () => {
    const edit = mcpHubEdits(fresh, "https://box.tailnet.ts.net:8399");
    if ("error" in edit) throw new Error(edit.error);
    expect((parseToml(edit.text) as { defaults: { mcp: unknown } }).defaults.mcp).toEqual({
      servers: ["ctx"],
      hub: true,
      gateway: "https://box.tailnet.ts.net:8399",
    });
  });

  it("the plan's hub steps are the ones bring-up says, with MCP hosting only when on", () => {
    const on = hubStepTitles({ node: "box", mcp: true });
    const no = hubStepTitles({ node: "box" });
    expect(on).toHaveLength(5);
    expect(no).toHaveLength(5);
    expect(on[0]).toBe(
      "Add box to the fleet as its relay and MCP hub, with a new relay token among the secrets",
    );
    expect(on[4]).toBe("Sync box, so it starts the relay and hosts your MCP servers");
    expect(no.join("\n")).not.toContain("MCP");
    expect(hubStepTitles({ node: "box", mcp: false })).toEqual(no);
  });

  it("is said in the plan's settings when the relay hosts it (the terminal's --relay --mcp-hub)", () => {
    const input = (url: string | null) =>
      ({
        node: "box",
        extras: { relay: { url, token: null, mcp: true }, models: null, t3: false },
      }) as unknown as SetupInput;
    expect(settingsLines(input("https://box.tailnet.ts.net:8399"))).toEqual([
      "Host the fleet's MCP servers on box: sign in to each once, there ([defaults.mcp] hub)",
    ]);
    expect(settingsLines(input(null))).toEqual([]);
  });
});

describe("the wizard's request, as the engine takes it", () => {
  const request = {
    repo: { kind: "local" as const },
    node: "laptop",
    hub: null,
    extras: [],
    autoUpdate: false,
    notify: { desktop: true, ntfy: URL },
  };
  it("takes updates only for a new fleet", () => {
    expect(upkeepOf("first", request)).toEqual({
      autoUpdate: false,
      desktop: true,
      ntfy: { url: URL },
    });
    expect(upkeepOf("join", request).autoUpdate).toBe(null);
    expect(upkeepOf("again", request).autoUpdate).toBe(null);
  });
});

// ── byChoice: a fleet comparison that follows a choice on this machine ──────────

const HOME = "/home/u";
const skill = (n: string, root: string, hash: string, modified: number): SkillCopy => ({
  name: n,
  root,
  entry: `${root.replace("~", HOME)}/${n}`,
  dir: `${root.replace("~", HOME)}/${n}`,
  hash,
  modified,
  source: null,
  text: `---\nname: ${n}\n---\n${hash}\n`,
  files: null,
});
const server = (n: string, entry: Record<string, unknown>): FoundServer => ({
  name: n,
  client: "claude",
  project: null,
  entry,
  extracted: fromClaude(n, entry, { home: HOME, env: {}, name: secretNamer([]) })!,
});

describe("byChoice", () => {
  const fleet: FleetView = {
    ...EMPTY_FLEET,
    skills: new Map([["review", "b"]]),
    skillTexts: new Map([["review", "---\nname: review\n---\nb\n"]]),
  };
  const found: Discovery = {
    node: "desktop",
    skills: [
      skill("review", "~/.agents/skills", "a", 2),
      skill("review", "~/.claude/skills", "b", 1),
    ],
    plugins: [],
    servers: [server("solo", { command: "solo" })],
    instructions: [],
    t3: { running: false, version: null, channel: null, providers: [] },
    agents: [],
    raw: { claude: null, codex: null },
    unreadable: [],
  };
  const plan = buildPlan({ mode: "join", node: "desktop", authority: false, found, fleet });
  const ui = uiConflicts(plan, fleet);

  it("gives the diff for each earlier choice, and null where that choice settles it", () => {
    const review = ui.find((c) => c.id === "skill:review");
    expect(review?.after).toBe("skill-here:review");
    // The newest copy (copy:0) differs from the fleet's; the other one is the fleet's.
    expect(Object.keys(review?.byChoice ?? {})).toEqual(["copy:0", "copy:1"]);
    expect(review?.byChoice?.["copy:1"]).toBe(null);
    expect(review?.byChoice?.["copy:0"]).toMatch(/^- b$/m);
    expect(review?.byChoice?.["copy:0"]).toMatch(/^\+ a$/m);
    expect(review?.byChoice?.["copy:0"]).toBe(review?.detail);
  });

  it("leaves a conflict that follows nothing without one", () => {
    const here = ui.find((c) => c.id === "skill-here:review");
    expect(here?.after).toBe(null);
    expect(here !== undefined && "byChoice" in here).toBe(false);
  });
});
