/**
 * The setup wizard's decisions, without React: which steps there are for what
 * the user said, what still stops each one, the requests the answers make,
 * which of a plan's conflicts are still questions, and how far a run is.
 * Screens read these; tests pin them.
 */
import type {
  UiPlanConflict,
  UiProbe,
  UiSetupCheck,
  UiSetupPlan,
  UiSetupPlanRequest,
  UiSetupRepo,
  UiSetupState,
} from "@t3-fleet/core/SetupApi";
import { newNtfyUrl, UPKEEP_DEFAULTS } from "@t3-fleet/core/Upkeep";

export type StepId = "machines" | "repo" | "hub" | "plan" | "apply" | "done";

export type Extra = UiSetupPlanRequest["extras"][number];

export interface Answers {
  /** This machine's node name. */
  readonly node: string;
  /** null until answered. */
  readonly alwaysOn: boolean | null;
  readonly others: number;
  readonly repo: "github" | "url" | "local" | null;
  /** The new repository's name, for "github". */
  readonly githubName: string;
  readonly url: string;
  readonly extras: ReadonlyArray<Extra>;
  readonly hubSsh: string;
  readonly hubNode: string;
  /** "Skip the hub for now": set up without one. */
  readonly hubSkipped: boolean;
  /** The hub hosts the fleet's MCP servers ([defaults.mcp] hub). */
  readonly hubMcp: boolean;
  /** Sync applies updates by itself ([fleet] apply). */
  readonly autoUpdate: boolean;
  /** An OS notification on this computer for every fleet alert. */
  readonly notifyDesktop: boolean;
  /** Push alerts to a phone with ntfy, at `ntfyUrl`. */
  readonly ntfy: boolean;
  /** The topic made when ntfy was turned on; gone when it is turned off, and never kept across a reload. */
  readonly ntfyUrl: string;
}

export const initialAnswers = (state: UiSetupState): Answers => ({
  node: state.suggestedName,
  alwaysOn: null,
  others: 0,
  repo: state.github === null ? null : "github",
  githubName: "fleet",
  url: "",
  extras: [],
  hubSsh: "",
  hubNode: "",
  hubSkipped: false,
  hubMcp: UPKEEP_DEFAULTS.mcpHub,
  autoUpdate: UPKEEP_DEFAULTS.autoUpdate,
  notifyDesktop: UPKEEP_DEFAULTS.desktop,
  ntfy: UPKEEP_DEFAULTS.ntfy,
  ntfyUrl: "",
});

/** Turning ntfy on makes a topic; turning it off forgets it, so it is in no request or storage after. */
export const ntfyPatch = (answers: Answers, on: boolean): Partial<Answers> =>
  !on
    ? { ntfy: false, ntfyUrl: "" }
    : answers.ntfyUrl === ""
      ? { ntfy: true, ntfyUrl: newNtfyUrl() }
      : { ntfy: true };

/**
 * The answers as kept across a reload: everything but the ntfy topic, which
 * is a secret (anyone with it reads the alerts), so ntfy comes back off.
 */
export const persistable = (answers: Answers): Answers => ({
  ...answers,
  ntfy: false,
  ntfyUrl: "",
});

export const STEP_LABEL: Readonly<Record<StepId, string>> = {
  machines: "Your machines",
  repo: "Where it lives",
  hub: "Your hub",
  plan: "Review",
  apply: "Set up",
  done: "Add machines",
};

/** The steps for these answers, in order: the hub's only with an always-on machine. */
export const stepsFor = (answers: Pick<Answers, "alwaysOn">): ReadonlyArray<StepId> =>
  answers.alwaysOn === true
    ? ["machines", "repo", "hub", "plan", "apply", "done"]
    : ["machines", "repo", "plan", "apply", "done"];

/** As `t3-fleet invite` takes them: lowercase letters, digits and dashes, not starting with a dash. */
const NODE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Why a node name will not do, or null when it will. */
export const nodeNameProblem = (name: string): string | null => {
  if (name.trim() === "") return "Give it a name";
  if (!NODE.test(name)) return "Lowercase letters, digits and dashes only";
  return null;
};

/** A GitHub repository name: what github.com accepts. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Whether a string looks like a git remote: https, ssh, or scp-like (git@host:path). */
export const looksLikeRemote = (url: string) =>
  /^(?:https?|ssh|git):\/\/[^\s/]+\/\S+$/.test(url.trim()) ||
  /^[\w.-]+@[\w.-]+:\S+$/.test(url.trim()) ||
  /^\/\S+$/.test(url.trim());

/** Pre-flight checks that stop setup. */
export const blocking = (checks: ReadonlyArray<UiSetupCheck>) =>
  checks.filter((c) => c.severity === "error");

/** A short node name from a probed hostname: "box.tailnet.ts.net" → "box". */
export const suggestHubName = (hostname: string | null, ssh: string): string => {
  const from = hostname ?? ssh.replace(/^.*@/, "");
  const short =
    from
      .split(".")[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") ?? "";
  return short === "" || !NODE.test(short) ? "hub" : short;
};

/**
 * What stops a step's Continue, in words for under the button, or null when
 * nothing does. `probe` is the last check of the hub's ssh destination.
 */
export const blocker = (
  step: StepId,
  answers: Answers,
  context: { readonly state: UiSetupState; readonly probe: UiProbe | null },
): string | null => {
  switch (step) {
    case "machines": {
      if (blocking(context.state.checks).length > 0)
        return "Fix what stops setup, then check again";
      const name = nodeNameProblem(answers.node);
      if (name !== null) return `This computer's name: ${name.toLowerCase()}`;
      if (answers.alwaysOn === null) return "Say whether you have an always-on machine";
      return null;
    }
    case "repo":
      if (answers.repo === null) return "Choose where your setup lives";
      if (answers.repo === "github") {
        if (context.state.github === null) return "Sign in to GitHub with gh first";
        return REPO_NAME.test(answers.githubName) ? null : "Give the repository a name";
      }
      if (answers.repo === "url")
        return looksLikeRemote(answers.url) ? null : "Paste the repository's URL";
      return null;
    case "hub": {
      if (answers.hubSkipped) return null;
      const probe = context.probe;
      if (probe === null || probe.ssh !== answers.hubSsh.trim()) return "Check the hub first";
      if (!probe.reachable) return "The hub could not be reached";
      if (!probe.ready) return "The hub is missing something it needs";
      const name = nodeNameProblem(answers.hubNode);
      if (name !== null) return `The hub's name: ${name.toLowerCase()}`;
      if (answers.hubNode === answers.node) return "The hub needs a name of its own";
      return null;
    }
    default:
      return null;
  }
};

export const repoOf = (answers: Answers): UiSetupRepo =>
  answers.repo === "github"
    ? { kind: "github", name: answers.githubName.trim() }
    : answers.repo === "url"
      ? { kind: "url", url: answers.url.trim() }
      : { kind: "local" };

/** The plan request for these answers; the hub only when there is one and it was not skipped. */
export const planRequest = (answers: Answers): UiSetupPlanRequest => ({
  repo: repoOf(answers),
  node: answers.node.trim(),
  hub:
    answers.alwaysOn === true && !answers.hubSkipped && answers.hubSsh.trim() !== ""
      ? { ssh: answers.hubSsh.trim(), node: answers.hubNode.trim(), mcp: answers.hubMcp }
      : null,
  extras: answers.extras,
  autoUpdate: answers.autoUpdate,
  notify: {
    desktop: answers.notifyDesktop,
    ntfy: answers.ntfy && answers.ntfyUrl !== "" ? answers.ntfyUrl : null,
  },
});

// ── the plan's settings ─────────────────────────────────────────────────

/** "Notify you on laptop … ([notify] desktop)" → the sentence, and where it goes in the config. */
export const settingParts = (line: string) => {
  const m = /^(.*) \((\[[^\]]+\][^)]*)\)$/.exec(line);
  return m === null
    ? { text: line, where: null }
    : { text: m[1] ?? line, where: (m[2] ?? "").split(";")[0] ?? null };
};

// ── the plan's conflicts ─────────────────────────────────────────────────

export type Choices = Readonly<Record<string, string>>;

/** A conflict's current choice: the user's, else its default. */
export const choiceOf = (conflict: UiPlanConflict, choices: Choices) =>
  choices[conflict.id] ?? conflict.default;

/**
 * Whether a conflict is still a question once those it follows are chosen,
 * and the diff to show for it then.
 */
export const conflictNow = (
  conflict: UiPlanConflict,
  choices: Choices,
  all: ReadonlyArray<UiPlanConflict>,
): { readonly applies: boolean; readonly detail: string } => {
  if (conflict.after === null || conflict.byChoice === undefined)
    return { applies: true, detail: conflict.detail };
  const first = all.find((c) => c.id === conflict.after);
  const picked = first === undefined ? undefined : choiceOf(first, choices);
  const detail = picked === undefined ? undefined : conflict.byChoice[picked];
  if (detail === undefined) return { applies: true, detail: conflict.detail };
  return detail === null ? { applies: false, detail: conflict.detail } : { applies: true, detail };
};

/** The conflicts that are questions now, in the plan's order. */
export const openConflicts = (plan: UiSetupPlan, choices: Choices) =>
  plan.conflicts.filter((c) => conflictNow(c, choices, plan.conflicts).applies);

/**
 * The choices still meaningful for a new plan: each names a conflict the plan
 * still has and one of its choices. The rest are dropped, back to defaults.
 */
export const keepChoices = (choices: Choices, plan: UiSetupPlan): Choices =>
  Object.fromEntries(
    Object.entries(choices).filter(([id, value]) =>
      plan.conflicts.some((c) => c.id === id && c.choices.some((x) => x.value === value)),
    ),
  );

/** Every applying conflict's choice, explicit, for apply. */
export const chosen = (plan: UiSetupPlan, choices: Choices): Record<string, string> =>
  Object.fromEntries(openConflicts(plan, choices).map((c) => [c.id, choiceOf(c, choices)]));

const missingNames = (plan: Pick<UiSetupPlan, "missing">) =>
  new Set(plan.missing.map((m) => m.name));

/**
 * Missing credentials typed in, for apply: only those this plan asks for; one
 * left blank or marked "set later" is left out.
 */
export const typedValues = (
  values: Readonly<Record<string, string>>,
  later: ReadonlySet<string>,
  plan: Pick<UiSetupPlan, "missing">,
): Record<string, string> => {
  const asked = missingNames(plan);
  return Object.fromEntries(
    Object.entries(values).filter(
      ([name, value]) => asked.has(name) && !later.has(name) && value !== "",
    ),
  );
};

/** What was typed in (or marked "set later") for credentials a new plan still asks for; the rest forgotten. */
export const keepCredentials = (
  values: Readonly<Record<string, string>>,
  later: ReadonlySet<string>,
  plan: Pick<UiSetupPlan, "missing">,
): { values: Readonly<Record<string, string>>; later: ReadonlySet<string> } => {
  const asked = missingNames(plan);
  return {
    values: Object.fromEntries(Object.entries(values).filter(([name]) => asked.has(name))),
    later: new Set([...later].filter((name) => asked.has(name))),
  };
};

// ── making the plan ─────────────────────────────────────────────────────

/**
 * The plan as the review shows it. `key` is the request it was asked for,
 * `gen` the newest ask: an answer to an older one is dropped, so a slow
 * reply cannot replace a newer plan, or an error leave an old one standing.
 */
export interface PlanLoad {
  readonly data: UiSetupPlan | null;
  readonly key: string;
  readonly gen: number;
  readonly loading: boolean;
  readonly error: unknown;
}

export const NO_PLAN: PlanLoad = { data: null, key: "", gen: 0, loading: false, error: null };

/** Asked again (generation `gen`) for the request `key`: the last plan stays on screen, dimmed. */
export const planAsked = (load: PlanLoad, key: string, gen: number): PlanLoad => ({
  ...load,
  key,
  gen,
  loading: true,
  error: null,
});

/** The answer to ask `gen`; one that failed leaves no plan to apply. */
export const planAnswered = (
  load: PlanLoad,
  gen: number,
  answer: { readonly data: UiSetupPlan } | { readonly error: unknown },
): PlanLoad =>
  gen !== load.gen
    ? load
    : "data" in answer
      ? { ...load, data: answer.data, loading: false, error: null }
      : { ...load, data: null, loading: false, error: answer.error };

/** Whether "Set up" may apply this plan: the answer to the answers as they are now, and nothing failed. */
export const planReady = (
  load: PlanLoad,
  requestKey: string,
): load is PlanLoad & {
  readonly data: UiSetupPlan;
} => load.data !== null && !load.loading && load.error === null && load.key === requestKey;

// ── where the server says this machine stands ───────────────────────────

/**
 * Where a state read (on focus, a job's end, the "session" event) moves a
 * wizard that is not following a run: into the fleet when this machine is a
 * member with nothing left to do, to the run when one is going, stopped, or
 * has a hub left; otherwise nowhere. A tab left open on an earlier step so
 * cannot start a second setup, and a stopped run reaches resume or abandon.
 */
export const followStage = (
  state: Pick<UiSetupState, "stage" | "hub">,
  step: StepId,
): "member" | "apply" | null => {
  if (step === "apply" || step === "done") return null;
  if (state.stage === "member" && state.hub === null) return "member";
  if (state.stage !== "fresh" || state.hub !== null) return "apply";
  return null;
};

// ── a run's progress ────────────────────────────────────────────────────

export type StepState = "done" | "running" | "failed" | "waiting";

const norm = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/…$|\.+$/, "");

/** The index of the plan step a job's step text names, or -1. */
export const stepIndex = (steps: ReadonlyArray<string>, text: string | null): number => {
  if (text === null) return -1;
  const t = norm(text);
  const exact = steps.findIndex((s) => norm(s) === t);
  if (exact >= 0) return exact;
  return steps.findIndex((s) => t.startsWith(norm(s)) || norm(s).startsWith(t));
};

/**
 * Each planned step's state, from the job's state and the furthest step it
 * has reported (`reached`, -1 for none yet). A job that finished did every
 * step; one that failed stopped at the step it had reached.
 */
export const stepStates = (
  count: number,
  job: { readonly state: "waiting" | "running" | "done" | "failed" } | null,
  reached: number,
): ReadonlyArray<StepState> =>
  Array.from({ length: count }, (_, i): StepState => {
    if (job === null || job.state === "waiting") return "waiting";
    if (job.state === "done") return "done";
    const at = Math.max(reached, 0);
    if (i < at) return "done";
    if (i === at) return job.state === "failed" ? "failed" : "running";
    return "waiting";
  });
