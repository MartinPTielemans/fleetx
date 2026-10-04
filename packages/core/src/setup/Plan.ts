/**
 * What setup will do, worked out before anything is written: from what this
 * machine has (Discover.ts) and what the fleet already has (an empty fleet
 * on the first machine).
 *
 * A plan has the same groups the user sees: added to the repo, linked,
 * conflicts, left alone, secrets, and the optional extras. Conflicts carry
 * their choices and the default the owner chose; `decide` turns a plan and
 * the choices made into the actions Apply.ts runs. Pure, so every rule here
 * is tested without a machine.
 *
 * A choice between two copies on this machine (two skills of one name, or
 * Claude and Codex disagreeing) comes first; the copy chosen is then
 * compared with the fleet's like any other, as a second conflict that only
 * applies when the two differ.
 */
import { secretRefs, shapeOf, type Missing, type Secret } from "./Credentials.ts";
import type { Discovery, FoundServer, SkillCopy, SkillSource } from "./Discover.ts";

/** What the fleet's repo already has, as this machine sees it. */
export interface FleetView {
  /** Skills in the repo, by name, with their hashes. */
  readonly skills: ReadonlyMap<string, string>;
  /** Their SKILL.md, for showing a difference. */
  readonly skillTexts: ReadonlyMap<string, string>;
  /** Definitions in mcp/, by name. */
  readonly servers: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  /** `[mcp] servers` as this machine gets them. */
  readonly declared: ReadonlyArray<string>;
  /** `[mcp] ignore` as this machine gets it: servers the fleet leaves alone here. */
  readonly ignored: ReadonlyArray<string>;
  /** `[[instructions]]` as this machine gets them, with the file each names. */
  readonly instructions: ReadonlyArray<{
    readonly src: string;
    readonly dest: string;
    readonly text: string | null;
  }>;
  /** Secret names the repo already uses. */
  readonly secretNames: ReadonlyArray<string>;
}

export const EMPTY_FLEET: FleetView = {
  skills: new Map(),
  skillTexts: new Map(),
  servers: new Map(),
  declared: [],
  ignored: [],
  instructions: [],
  secretNames: [],
};

/**
 *   first   no fleet yet: this machine starts one
 *   join    another machine's fleet, cloned
 *   again   this machine is already set up: what still differs
 */
export type Mode = "first" | "join" | "again";

export type Choice = "mine" | "fleet" | "both" | "here" | `copy:${number}`;

export interface Conflict {
  readonly id: string;
  readonly kind: "skill" | "server" | "instruction";
  readonly name: string;
  readonly title: string;
  /** Text to show before asking: a diff, or the two definitions. */
  readonly detail: string;
  readonly choices: ReadonlyArray<{ readonly value: Choice; readonly label: string }>;
  readonly default: Choice;
  /** The local choice this comparison with the fleet follows; it applies only when the chosen copy differs. */
  readonly after?: string;
}

/** Where a server is registered once setup is done. */
export type Scope =
  /** On every machine: `[defaults.mcp] servers`. */
  | "fleet"
  /** On this machine only: its node file's `[mcp] "servers.add"`. */
  | "machine"
  /** In the repo, registered nowhere until a node lists it (a Claude project's server). */
  | "declared";

export interface PlanSkill {
  /** Its name in the repo. */
  readonly name: string;
  readonly copy: SkillCopy;
  /** Every entry setup moves aside for it, in every skills directory. */
  readonly entries: ReadonlyArray<SkillCopy>;
}

export interface PlanServer {
  readonly name: string;
  readonly found: FoundServer;
  readonly scope: Scope;
  /** Why it is not on every machine. */
  readonly why: string | null;
}

export interface PlanInstruction {
  readonly src: string;
  readonly dest: string;
  readonly at: string;
  readonly text: string;
}

export type PlanConflict = Conflict &
  (
    | {
        readonly kind: "skill";
        readonly copies: ReadonlyArray<PlanSkill>;
        /** The fleet's hash, for a comparison that follows a local choice. */
        readonly fleetHash?: string;
      }
    | {
        readonly kind: "server";
        readonly options: ReadonlyArray<PlanServer>;
        readonly fleetShape?: string;
      }
    | { readonly kind: "instruction"; readonly mine: PlanInstruction }
  );

export interface Plan {
  readonly mode: Mode;
  readonly node: string;
  /** Whether this machine commits its changes (first, or an authority) rather than proposing them. */
  readonly commits: boolean;
  /** Skills, servers and instructions the repo lacks: added (or proposed) as they are. */
  readonly add: {
    readonly skills: ReadonlyArray<PlanSkill>;
    readonly servers: ReadonlyArray<PlanServer>;
    readonly instructions: ReadonlyArray<PlanInstruction>;
  };
  /** What this machine has that is already the fleet's: only linked. */
  readonly same: {
    readonly skills: ReadonlyArray<PlanSkill>;
    readonly servers: ReadonlyArray<PlanServer>;
    readonly instructions: ReadonlyArray<PlanInstruction>;
  };
  /** Differences with a choice to make, each kept for `decide`. */
  readonly conflicts: ReadonlyArray<PlanConflict>;
  /** Servers T3 Fleet leaves alone on this machine (its node's `[mcp] "ignore.add"`). */
  readonly ignored: ReadonlyArray<{ readonly name: string; readonly why: string }>;
  readonly leftAlone: ReadonlyArray<{ readonly what: string; readonly why: string }>;
  readonly secrets: ReadonlyArray<Secret>;
  readonly missing: ReadonlyArray<Missing>;
}

/** Collected by name. */
const byName = <A extends { readonly name: string }>(items: ReadonlyArray<A>) => {
  const groups = new Map<string, Array<A>>();
  for (const item of items) groups.set(item.name, [...(groups.get(item.name) ?? []), item]);
  return groups;
};

const skillLabel = (c: SkillCopy) =>
  `the copy in ${c.root}${c.source === null ? "" : ` (from ${c.source.url})`}`;

const definitionText = (d: Readonly<Record<string, unknown>>) => JSON.stringify(d, null, 2);

export const lineDiff = (a: string, b: string, aLabel: string, bLabel: string) => {
  const x = a.split("\n");
  const y = b.split("\n");
  const out = [`--- ${aLabel}`, `+++ ${bLabel}`];
  // Longest common subsequence: these files are small.
  const lcs: Array<Array<number>> = Array.from({ length: x.length + 1 }, () =>
    Array.from({ length: y.length + 1 }, () => 0),
  );
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      (lcs[i] as Array<number>)[j] =
        x[i] === y[j]
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, lcs[i]?.[j + 1] ?? 0);
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push(`  ${x[i]}`);
      i++;
      j++;
    } else if (
      i < x.length &&
      (j >= y.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))
    ) {
      out.push(`- ${x[i]}`);
      i++;
    } else {
      out.push(`+ ${y[j]}`);
      j++;
    }
  }
  return out.join("\n");
};

export interface PlanInput {
  readonly mode: Mode;
  readonly node: string;
  /** Whether this machine is (or becomes) an authority. */
  readonly authority: boolean;
  readonly found: Discovery;
  readonly fleet: FleetView;
  /**
   * Whether a client's entry is exactly what the mcp area registers for the
   * fleet's definition of that name on this machine: the fleet's own
   * registration, never a difference (again mode; RegisteredByFleet.ts).
   */
  readonly registered?: (server: FoundServer) => boolean;
}

/** The diff to show for a conflict, once the choices it follows are made (the chosen copy's). */
export const detailOf = (
  conflict: PlanConflict,
  choices: Readonly<Record<string, Choice>>,
  fleet: FleetView,
) => {
  if (conflict.after === undefined || conflict.kind === "instruction") return conflict.detail;
  const pick = Number(/^copy:(\d+)$/.exec(choices[conflict.after] ?? "")?.[1] ?? 0);
  if (conflict.kind === "skill") {
    const copy = (conflict.copies[pick] ?? conflict.copies[0])?.copy;
    return copy === undefined
      ? conflict.detail
      : lineDiff(
          fleet.skillTexts.get(conflict.name) ?? "",
          copy.text,
          `the fleet's skills/${conflict.name}/SKILL.md`,
          `${copy.root}/${conflict.name}/SKILL.md`,
        );
  }
  const one = conflict.options[pick] ?? conflict.options[0];
  const theirs = fleet.servers.get(conflict.name);
  return one === undefined || theirs === undefined
    ? conflict.detail
    : lineDiff(
        definitionText(theirs),
        definitionText(one.found.extracted.definition),
        `the fleet's mcp/${conflict.name}.json`,
        `${one.found.client === "claude" ? "Claude's" : "Codex's"} ${conflict.name}`,
      );
};

/** Whether a conflict is still a question once the choices it follows are made. */
export const applies = (
  conflict: PlanConflict,
  choices: Readonly<Record<string, Choice>>,
  all: ReadonlyArray<PlanConflict>,
) => {
  if (conflict.after === undefined) return true;
  const first = all.find((c) => c.id === conflict.after);
  const pick = Number(
    /^copy:(\d+)$/.exec(choices[conflict.after] ?? first?.default ?? "")?.[1] ?? 0,
  );
  if (conflict.kind === "skill")
    return (conflict.copies[pick] ?? conflict.copies[0])?.copy.hash !== conflict.fleetHash;
  if (conflict.kind === "server") {
    const one = conflict.options[pick] ?? conflict.options[0];
    return one !== undefined && shapeOf(one.found.extracted.definition) !== conflict.fleetShape;
  }
  return true;
};

export const buildPlan = ({ mode, node, authority, found, fleet, registered }: PlanInput): Plan => {
  const commits = mode === "first" || authority;
  const add = {
    skills: [] as Array<PlanSkill>,
    servers: [] as Array<PlanServer>,
    instructions: [] as Array<PlanInstruction>,
  };
  const same = {
    skills: [] as Array<PlanSkill>,
    servers: [] as Array<PlanServer>,
    instructions: [] as Array<PlanInstruction>,
  };
  const conflicts: Array<PlanConflict> = [];
  const ignored: Array<{ name: string; why: string }> = [];
  const leftAlone: Array<{ what: string; why: string }> = [];
  const mineOrPropose = commits
    ? "keep mine (it replaces the fleet's)"
    : "keep mine and propose it (the fleet's stays until approved)";
  // On a machine set up already, a difference from the fleet is drift, not a proposal.
  const fleetFirst = mode === "again";

  // Skills: one per name. Copies that differ on this machine are a choice first.
  for (const [name, copies] of byName(found.skills)) {
    const hashes = [...new Set(copies.map((c) => c.hash))];
    const inFleet = fleet.skills.get(name);
    const skillDiff = (copy: SkillCopy) =>
      lineDiff(
        fleet.skillTexts.get(name) ?? "",
        copy.text,
        `the fleet's skills/${name}/SKILL.md`,
        `${copy.root}/${name}/SKILL.md${copy.files === null ? "" : ` (${copy.files})`}`,
      );
    const skillConflict = (
      list: ReadonlyArray<PlanSkill>,
      extra: { readonly after?: string; readonly fleetHash?: string },
    ): PlanConflict => ({
      id: `skill:${name}`,
      kind: "skill",
      name,
      title: `skill ${name} differs from the fleet's`,
      detail: skillDiff(list[0]?.copy as SkillCopy),
      choices: [
        { value: "mine", label: mineOrPropose },
        { value: "fleet", label: "use the fleet's (mine is kept as a backup)" },
        { value: "both", label: `keep both: mine as ${name}@${node}` },
      ],
      default: fleetFirst ? "fleet" : "mine",
      copies: list,
      ...extra,
    });
    if (hashes.length > 1) {
      // Newest first: the default.
      const distinct = hashes
        .map(
          (h) =>
            copies
              .filter((c) => c.hash === h)
              .sort((a, b) => b.modified - a.modified)[0] as SkillCopy,
        )
        .sort((a, b) => b.modified - a.modified);
      const list = distinct.map((c) => ({ name, copy: c, entries: copies }));
      conflicts.push({
        id: `skill-here:${name}`,
        kind: "skill",
        name,
        title: `skill ${name}: ${distinct.length} different copies on this machine`,
        detail: distinct
          .map(
            (c, i) =>
              `${i === 0 ? "newest" : "older"}: ${c.root}/${name}${c.source ? ` (from ${c.source.url})` : ""}`,
          )
          .join("\n"),
        choices: distinct.map((c, i) => ({
          value: `copy:${i}` as const,
          label: `use ${skillLabel(c)}`,
        })),
        default: "copy:0",
        copies: list,
      });
      if (inFleet !== undefined)
        conflicts.push(skillConflict(list, { after: `skill-here:${name}`, fleetHash: inFleet }));
      continue;
    }
    const one = { name, copy: copies[0] as SkillCopy, entries: copies };
    if (inFleet === undefined) add.skills.push(one);
    else if (inFleet === hashes[0]) same.skills.push(one);
    else conflicts.push(skillConflict([one], {}));
  }
  for (const p of found.plugins)
    leftAlone.push({
      what: `skill ${p.name} (${p.at})`,
      why: "a Claude plugin's; Claude's plugin system keeps it",
    });

  // MCP servers. Both clients' entries for one name are one server.
  const userScope = found.servers.filter((s) => s.project === null);
  const projectScope = found.servers.filter((s) => s.project !== null);
  const takenNames = new Set(userScope.map((s) => s.name));
  const serverOf = (s: FoundServer, name: string): PlanServer =>
    s.project !== null
      ? { name, found: s, scope: "declared", why: `a server of the Claude project ${s.project}` }
      : s.extracted.local !== null
        ? { name, found: s, scope: "machine", why: s.extracted.local }
        : { name, found: s, scope: "fleet", why: null };
  const serverConflict = (
    name: string,
    options: ReadonlyArray<PlanServer>,
    detail: string,
    extra: { readonly after?: string; readonly fleetShape?: string },
  ): PlanConflict => ({
    id: `server:${name}`,
    kind: "server",
    name,
    title: `MCP server ${name} differs from the fleet's`,
    detail,
    choices: [
      { value: "mine", label: mineOrPropose },
      { value: "fleet", label: "use the fleet's" },
      { value: "here", label: "keep mine on this machine only" },
    ],
    // A server the fleet declares already is the fleet's to change from a machine set up already.
    default: fleetFirst ? "fleet" : "mine",
    options,
    ...extra,
  });
  for (const [name, all] of byName(userScope)) {
    if (fleet.ignored.includes(name)) continue;
    // The fleet's own registration, exactly as the mcp area wrote it, is no difference.
    const entries = all.filter((e) => !(registered?.(e) ?? false));
    if (entries.length === 0) continue;
    const leave = entries.find((e) => e.extracted.leave !== null);
    if (leave !== undefined && !fleet.servers.has(name)) {
      ignored.push({ name, why: leave.extracted.leave ?? "" });
      continue;
    }
    const theirs = fleet.servers.get(name);
    const shapes = [...new Set(entries.map((e) => shapeOf(e.extracted.definition)))];
    if (shapes.length > 1) {
      const claude = entries.find((e) => e.client === "claude") as FoundServer;
      const codex = entries.find((e) => e.client === "codex") as FoundServer;
      const options = [serverOf(claude, name), serverOf(codex, name)];
      conflicts.push({
        id: `server-here:${name}`,
        kind: "server",
        name,
        title: `MCP server ${name}: Claude and Codex have it differently`,
        detail: lineDiff(
          definitionText(claude.extracted.definition),
          definitionText(codex.extracted.definition),
          "Claude's",
          "Codex's",
        ),
        choices: [
          { value: "copy:0", label: "use Claude's" },
          { value: "copy:1", label: "use Codex's" },
        ],
        default: "copy:0",
        options,
      });
      if (theirs !== undefined)
        conflicts.push(
          serverConflict(
            name,
            options,
            `the one chosen above is not the fleet's mcp/${name}.json`,
            {
              after: `server-here:${name}`,
              fleetShape: shapeOf(theirs),
            },
          ),
        );
      continue;
    }
    const first = entries.find((e) => e.client === "claude") ?? (entries[0] as FoundServer);
    const server = serverOf(first, name);
    if (theirs === undefined) add.servers.push(server);
    else if (shapeOf(theirs) === shapeOf(first.extracted.definition)) same.servers.push(server);
    else
      conflicts.push(
        serverConflict(
          name,
          [server],
          lineDiff(
            definitionText(theirs),
            definitionText(first.extracted.definition),
            `the fleet's mcp/${name}.json`,
            `${entries.map((e) => (e.client === "claude" ? "Claude's" : "Codex's")).join(" and ")} ${name}`,
          ),
          {},
        ),
      );
  }
  for (const s of projectScope) {
    if (s.extracted.leave !== null) {
      leftAlone.push({
        what: `${s.name} (Claude project ${s.project ?? ""})`,
        why: s.extracted.leave,
      });
      continue;
    }
    // A project's server may share a user server's name; it gets the project's added.
    const project =
      (s.project ?? "")
        .split("/")
        .pop()
        ?.toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-") || "project";
    const shape = shapeOf(s.extracted.definition);
    const known = [s.name, `${s.name}-${project}`].find((n) => {
      const theirs = fleet.servers.get(n);
      return theirs !== undefined && shapeOf(theirs) === shape;
    });
    if (known !== undefined) {
      same.servers.push(serverOf(s, known));
      continue;
    }
    let name = s.name;
    if (takenNames.has(name) || fleet.servers.has(name)) name = `${s.name}-${project}`;
    takenNames.add(name);
    add.servers.push(serverOf(s, name));
  }

  // Instructions.
  for (const file of found.instructions) {
    const theirs = fleet.instructions.find((i) => i.dest === file.dest);
    const mine: PlanInstruction = {
      src: theirs?.src ?? file.src,
      dest: file.dest,
      at: file.at,
      text: file.text,
    };
    if (theirs === undefined) add.instructions.push(mine);
    else if (theirs.text === file.text) same.instructions.push(mine);
    else
      conflicts.push({
        id: `instruction:${file.dest}`,
        kind: "instruction",
        name: file.dest,
        title: `${file.dest} differs from the fleet's`,
        detail: lineDiff(theirs.text ?? "", file.text, `the fleet's ${theirs.src}`, file.dest),
        choices: [
          { value: "mine", label: mineOrPropose },
          { value: "fleet", label: "use the fleet's (mine is kept as a backup)" },
          { value: "here", label: "keep mine on this machine only" },
        ],
        default: fleetFirst ? "fleet" : "mine",
        mine,
      });
  }

  // Secrets and missing values of every server that may be written.
  const secrets: Array<Secret> = [];
  const missing: Array<Missing> = [];
  const candidates = [
    ...add.servers,
    ...conflicts.flatMap((c) => (c.kind === "server" ? c.options : [])),
  ];
  for (const s of candidates) {
    for (const secret of s.found.extracted.secrets)
      if (!secrets.some((x) => x.name === secret.name))
        secrets.push({ ...secret, where: `${s.name}: ${secret.where}` });
    for (const m of s.found.extracted.missing)
      if (!missing.some((x) => x.name === m.name))
        missing.push({ ...m, why: `${s.name}: ${m.why}` });
    if (s.found.extracted.dropped.length > 0)
      leftAlone.push({
        what: `${s.name}: ${s.found.extracted.dropped.join(", ")}`,
        why: "a definition cannot carry these client settings",
      });
  }
  for (const a of found.agents)
    leftAlone.push({
      what: `${a.name === "claude" ? "Claude Code" : "Codex"} ${a.version ?? ""}`.trim(),
      why:
        a.path === null
          ? "not installed; setup installs no agent CLI"
          : `installed by ${a.installedBy ?? "an unknown installer"} at ${a.path}; setup never installs or upgrades agent CLIs`,
    });

  return { mode, node, commits, add, same, conflicts, ignored, leftAlone, secrets, missing };
};

/** Where a member's new secrets wait, encrypted, for an authority to merge (ProposedSecrets.ts). */
export const PROPOSED_SECRETS = "secrets-proposed";

/** What Apply.ts writes and moves, once every conflict has its choice. */
export interface Actions {
  /** Skills written to the repo's skills/, by repo name. */
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly from: string;
    readonly source: SkillSource | null;
  }>;
  /** Definitions written to mcp/, and where each is registered. */
  readonly servers: ReadonlyArray<{
    readonly name: string;
    readonly definition: Readonly<Record<string, unknown>>;
    readonly scope: Scope;
  }>;
  /** Fleet servers this machine leaves out: it keeps its own entry. */
  readonly serversHereOnly: ReadonlyArray<string>;
  /** Servers T3 Fleet leaves alone here (`[mcp] "ignore.add"`), and why. */
  readonly ignored: ReadonlyArray<{ readonly name: string; readonly why: string }>;
  readonly instructions: ReadonlyArray<{
    readonly src: string;
    readonly dest: string;
    readonly text: string;
  }>;
  /** Fleet instruction entries this machine leaves out, keeping its own file. */
  readonly instructionsHereOnly: ReadonlyArray<{ readonly src: string; readonly dest: string }>;
  /** Paths replaced by a link: skill entries and instruction files. `link` null: only moved aside. */
  readonly links: ReadonlyArray<{ readonly path: string; readonly link: string | null }>;
  readonly secrets: ReadonlyArray<Secret>;
}

/**
 * The plan with its conflicts decided: `choices` maps a conflict's id to the
 * choice made, and missing ones take the default. `entered` are values given
 * for missing secrets; a server still without one of its values stays on
 * this machine, left alone, until setup runs again with it.
 */
export const decide = (
  plan: Plan,
  choices: Readonly<Record<string, Choice>>,
  paths: { readonly home: string; readonly checkout: string },
  entered: ReadonlyArray<Secret> = [],
): Actions => {
  const skills: Array<Actions["skills"][number]> = [];
  const servers: Array<Actions["servers"][number]> = [];
  const serversHereOnly: Array<string> = [];
  const ignored: Array<{ name: string; why: string }> = [...plan.ignored];
  const instructions: Array<Actions["instructions"][number]> = [];
  const instructionsHereOnly: Array<Actions["instructionsHereOnly"][number]> = [];
  const links = new Map<string, string | null>();
  const abs = (p: string) => (p.startsWith("~/") ? `${paths.home}${p.slice(1)}` : p);
  const store = `${paths.home}/.agents/skills`;
  const has = new Set([...plan.secrets.map((s) => s.name), ...entered.map((s) => s.name)]);

  /** Each entry of a skill moved aside; the skill linked under `name` where agents read it. */
  const linkSkill = (s: PlanSkill, name: string) => {
    for (const e of s.entries) links.set(e.entry, null);
    links.set(`${store}/${name}`, `${paths.checkout}/skills/${name}`);
    if (s.entries.some((e) => e.root === "~/.claude/skills"))
      links.set(`${paths.home}/.claude/skills/${name}`, `${store}/${name}`);
  };
  const writeSkill = (s: PlanSkill, name: string) => {
    skills.push({ name, from: s.copy.dir, source: s.copy.source });
    linkSkill(s, name);
  };
  const writeServer = (s: PlanServer, name = s.name) => {
    const lacking = secretRefs(s.found.extracted.definition).filter(
      (r) => s.found.extracted.missing.some((m) => m.name === r) && !has.has(r),
    );
    if (lacking.length > 0) {
      ignored.push({
        name,
        why: `${lacking.join(", ")} has no value here yet; run setup again once it is set`,
      });
      return;
    }
    servers.push({ name, definition: s.found.extracted.definition, scope: s.scope });
  };
  const linkInstruction = (i: PlanInstruction) =>
    links.set(abs(i.dest), `${paths.checkout}/${i.src}`);

  for (const s of plan.add.skills) writeSkill(s, s.name);
  for (const s of plan.same.skills) linkSkill(s, s.name);
  for (const s of plan.add.servers) writeServer(s);
  for (const i of plan.add.instructions) {
    instructions.push({ src: i.src, dest: i.dest, text: i.text });
    linkInstruction(i);
  }
  for (const i of plan.same.instructions) linkInstruction(i);

  const pickOf = (id: string, fallback: Choice) =>
    Number(/^copy:(\d+)$/.exec(choices[id] ?? fallback)?.[1] ?? 0);
  for (const c of plan.conflicts) {
    const choice = choices[c.id] ?? c.default;
    const followed = plan.conflicts.some((x) => x.after === c.id);
    if (c.kind === "skill") {
      const pick = c.after !== undefined ? pickOf(c.after, "copy:0") : pickOf(c.id, c.default);
      const one = c.copies[pick] ?? (c.copies[0] as PlanSkill);
      if (c.id.startsWith("skill-here:")) {
        // Compared with the fleet's next, when the fleet has one.
        if (!followed) writeSkill(one, c.name);
      } else if (!applies(c, choices, plan.conflicts)) linkSkill(one, c.name);
      else if (choice === "mine") writeSkill(one, c.name);
      else if (choice === "fleet") linkSkill(one, c.name);
      else {
        writeSkill({ ...one, entries: [] }, `${c.name}@${plan.node}`);
        linkSkill(one, c.name);
      }
    } else if (c.kind === "server") {
      const pick = c.after !== undefined ? pickOf(c.after, "copy:0") : pickOf(c.id, c.default);
      const one = c.options[pick] ?? (c.options[0] as PlanServer);
      if (c.id.startsWith("server-here:")) {
        if (!followed) writeServer(one, c.name);
      } else if (!applies(c, choices, plan.conflicts)) continue;
      else if (choice === "mine") writeServer(one);
      else if (choice === "here") serversHereOnly.push(c.name);
    } else {
      if (choice === "mine") {
        instructions.push({ src: c.mine.src, dest: c.mine.dest, text: c.mine.text });
        linkInstruction(c.mine);
      } else if (choice === "fleet") linkInstruction(c.mine);
      else instructionsHereOnly.push({ src: c.mine.src, dest: c.mine.dest });
    }
  }

  const needed = new Set(servers.flatMap((s) => secretRefs(s.definition)));
  return {
    skills,
    servers,
    serversHereOnly,
    ignored,
    instructions,
    instructionsHereOnly,
    links: [...links].map(([path, link]) => ({ path, link })),
    secrets: [...plan.secrets, ...entered].filter((s) => needed.has(s.name)),
  };
};
