/**
 * The setup wizard: what `t3-fleet ui` shows on a machine that is not in a
 * fleet yet, or whose setup stopped part-way. It asks what setup needs
 * (SetupApi.ts), shows the plan, runs it as jobs, and hands over to the
 * fleet app once this machine is a member.
 */
import type { UiProbe, UiSetupState } from "@t3-fleet/core/SetupApi";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, isUnauthorized } from "../../lib/api";
import { finished } from "../../lib/jobs";
import { useEvent, useStore } from "../../lib/store";
import { ApplyStep } from "./Apply";
import { DoneStep } from "./Done";
import { HubStep, type ProbeState } from "./Hub";
import { MachinesStep } from "./Machines";
import { AbandonedNote, StepBar, StepRail, type RailStep } from "./parts";
import { PlanStep } from "./Plan";
import { RepoStep } from "./Repo";
import { loadRun, runJobs, saveRun, type JobListing, type SetupRun } from "./run";
import {
  blocker,
  chosen,
  followStage,
  initialAnswers,
  keepChoices,
  keepCredentials,
  NO_PLAN,
  persistable,
  planAnswered,
  planAsked,
  planReady,
  planRequest,
  repoOf,
  stepsFor,
  suggestHubName,
  typedValues,
  type Answers,
  type PlanLoad,
  type StepId,
} from "./wizard";

const ANSWERS_KEY = "t3-fleet:setup-answers";

/** Answers and step from before a reload, for a setup not started yet. */
const restored = (state: UiSetupState): { answers: Answers; step: StepId } | null => {
  if (state.stage !== "fresh") return null;
  try {
    const text = window.sessionStorage.getItem(ANSWERS_KEY);
    if (text === null) return null;
    const saved = JSON.parse(text) as { answers: Answers; step: StepId };
    return { answers: { ...initialAnswers(state), ...saved.answers }, step: saved.step };
  } catch {
    return null;
  }
};

const firstStep = (state: UiSetupState, run: SetupRun | null): StepId =>
  run?.finished === true
    ? "done"
    : state.stage === "unfinished" || state.hub !== null || run?.job != null
      ? "apply"
      : "machines";

/** "https://github.com/o/fleet.git" → "o/fleet". */
const shortRepo = (url: string) =>
  url
    .replace(/^(?:https?|ssh):\/\/(?:[^@/]+@)?[^/]+\//, "")
    .replace(/^[\w.-]+@[\w.-]+:/, "")
    .replace(/\.git$/, "");

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function SetupWizard({
  initial,
  onMember,
  railFooter,
  banner,
}: {
  initial: UiSetupState;
  /** This machine is in the fleet now: show the fleet app. */
  onMember: () => void;
  railFooter?: ReactNode;
  banner?: ReactNode;
}) {
  const { jobs, now } = useStore();
  const [state, setState] = useState(initial);
  // A run kept from before a reload; on a fresh machine any kept run is over (abandoned elsewhere).
  const [run, setRunState] = useState<SetupRun | null>(() =>
    initial.stage === "fresh" ? null : loadRun(),
  );
  const back = useMemo(() => restored(initial), [initial]);
  const [answers, setAnswers] = useState<Answers>(() => back?.answers ?? initialAnswers(initial));
  const [step, setStep] = useState<StepId>(() =>
    back !== null && run === null ? back.step : firstStep(initial, run),
  );
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState<unknown>(null);
  const [probe, setProbe] = useState<ProbeState>({ data: null, running: false, error: null });
  const [plan, setPlan] = useState<PlanLoad>(NO_PLAN);
  const planGen = useRef(0);
  /** What the last abandon said the run had done, until dismissed. */
  const [abandoned, setAbandoned] = useState<ReadonlyArray<string> | null>(null);
  /** The server's job list, read after a reload or on coming back to the tab: a job it dropped is gone. */
  const [listing, setListing] = useState<JobListing | null>(null);
  const [choices, setChoices] = useState<Readonly<Record<string, string>>>({});
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<unknown>(null);
  const [entering, setEntering] = useState(false);
  const [enterError, setEnterError] = useState<unknown>(null);

  const setRun = useCallback((next: SetupRun | null) => {
    saveRun(next);
    setRunState(next);
  }, []);
  const set = useCallback((patch: Partial<Answers>) => setAnswers((a) => ({ ...a, ...patch })), []);

  // Remember answers across a reload until setup starts; never the ntfy topic, a secret.
  useEffect(() => {
    if (step === "apply" || step === "done") window.sessionStorage.removeItem(ANSWERS_KEY);
    else
      window.sessionStorage.setItem(
        ANSWERS_KEY,
        JSON.stringify({ answers: persistable(answers), step }),
      );
  }, [answers, step]);

  // A setup running that this page did not start (another tab, or before a reload): follow it.
  const { setup: runningSetup, gone } = runJobs(run, jobs, listing);
  useEffect(() => {
    if (runningSetup === null || finished(runningSetup) || step === "apply" || step === "done")
      return;
    const kept = loadRun();
    if (run?.job !== runningSetup.id)
      setRun(
        kept?.job === runningSetup.id
          ? kept
          : {
              job: runningSetup.id,
              startedAt: runningSetup.startedAt,
              node: answers.node,
              steps: [],
              hub: null,
              others: answers.others,
              reached: {},
              finished: false,
            },
      );
    setStep("apply");
  }, [runningSetup, step, run, setRun, answers.node, answers.others]);

  const steps = stepsFor({ alwaysOn: run?.hub != null ? true : answers.alwaysOn });
  const go = (to: StepId) => {
    setStep(to);
  };
  const next = () => {
    const i = steps.indexOf(step);
    const to = steps[i + 1];
    if (to !== undefined) go(to);
  };
  const prev = () => {
    const i = steps.indexOf(step);
    const to = steps[i - 1];
    if (to !== undefined) go(to);
  };

  const recheck = async () => {
    setRechecking(true);
    setRecheckError(null);
    try {
      adopt(await api.setupState());
    } catch (error) {
      setRecheckError(error);
    } finally {
      setRechecking(false);
    }
  };

  const runProbe = async () => {
    const ssh = answers.hubSsh.trim();
    setProbe((p) => ({ ...p, running: true, error: null }));
    try {
      const repo = repoOf(answers);
      const data = await api.setupProbe(ssh, repo.kind === "url" ? repo.url : undefined);
      setProbe({ data, running: false, error: null });
      // Without a tailnet address there is nowhere for the machines to reach hosted servers.
      if (data.relayUrl === null) set({ hubMcp: false });
      // Name the hub after the machine, unless the user already named it.
      if (data.reachable)
        setAnswers((a) =>
          a.hubNode === "" ||
          a.hubNode === suggestHubName(probe.data?.hostname ?? null, probe.data?.ssh ?? "")
            ? { ...a, hubNode: suggestHubName(data.hostname, data.ssh) }
            : a,
        );
    } catch (error) {
      setProbe({ data: null, running: false, error });
    }
  };

  // The plan: made on arriving at the review, and again when the answers it was made from change.
  const request = planRequest(answers);
  const requestKey = JSON.stringify(request);
  const makePlan = useCallback(async (body: typeof request, key: string) => {
    const gen = ++planGen.current;
    setPlan((p) => planAsked(p, key, gen));
    setApplyError(null);
    try {
      const data = await api.setupPlan(body);
      if (gen !== planGen.current) return;
      setPlan((p) => planAnswered(p, gen, { data }));
      // What was decided carries over where the new plan still asks it.
      setChoices((c) => keepChoices(c, data));
      const kept = keepCredentials(valuesRef.current, laterRef.current, data);
      setValues(kept.values);
      setLater(kept.later);
    } catch (error) {
      setPlan((p) => planAnswered(p, gen, { error }));
    }
  }, []);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const laterRef = useRef(later);
  laterRef.current = later;
  const ready = planReady(plan, requestKey);
  useEffect(() => {
    if (step !== "plan" || plan.key === requestKey) return;
    void makePlan(request, requestKey);
    // request is requestKey's value
  }, [step, requestKey, plan.key, makePlan]);

  const apply = async () => {
    if (!planReady(plan, requestKey)) return;
    const p = plan.data;
    setApplying(true);
    setApplyError(null);
    try {
      const started = await api.setupApply({
        kind: "plan",
        planId: p.planId,
        choices: chosen(p, choices),
        values: typedValues(values, later, p),
      });
      setRun({
        job: started.jobId,
        startedAt: Date.now(),
        node: p.node,
        steps: p.steps,
        hub:
          p.hub === null
            ? null
            : {
                node: p.hub.node,
                ssh: p.hub.ssh,
                relayUrl: p.hub.relayUrl,
                mcp: p.hub.mcp,
                steps: p.hub.steps,
              },
        remote: p.repo.remote,
        commits: p.commits,
        settings: p.settings,
        others: answers.others,
        reached: {},
        finished: false,
      });
      go("apply");
    } catch (error) {
      setApplyError(error);
    } finally {
      setApplying(false);
    }
  };

  const resume = async () => {
    const started = await api.setupApply({ kind: "resume" });
    setRun({
      job: started.jobId,
      startedAt: Date.now(),
      node: run?.node ?? state.suggestedName,
      steps: run?.steps ?? [],
      hub: run?.hub ?? null,
      ...(run?.remote === undefined ? {} : { remote: run.remote }),
      ...(run?.commits === undefined ? {} : { commits: run.commits }),
      others: run?.others ?? answers.others,
      reached: {},
      finished: false,
    });
  };

  const abandon = async () => {
    const answer = await api.setupApply({ kind: "abandon" });
    setAbandoned(answer.report ?? null);
    // Abandoned already: a state that cannot be read now is taken as abandon leaves it, and read again later.
    const fresh = await api.setupState().catch((): UiSetupState => ({
      ...state,
      stage: state.stage === "member" ? "member" : "fresh",
      unfinished: null,
      hub: null,
    }));
    setState(fresh);
    // In the fleet already: only the hub's part was left, and it is forgotten.
    if (fresh.stage === "member") {
      if (run !== null) setRun({ ...run, hub: null, finished: true });
      setStep("done");
      return;
    }
    setRun(null);
    setAnswers(initialAnswers(fresh));
    setStep("machines");
  };

  /**
   * Where things stand, read again: kept, and acted on when it moves a wizard
   * that is not following a run (followStage). Without this a tab left on an
   * earlier step would offer a second setup, or miss one that stopped.
   */
  const stepRef = useRef(step);
  stepRef.current = step;
  const onMemberRef = useRef(onMember);
  onMemberRef.current = onMember;
  const adopt = useCallback(
    (fresh: UiSetupState) => {
      setState(fresh);
      const to = followStage(fresh, stepRef.current);
      if (to === "member") {
        // Nothing of the run to show here (another tab ran it): straight into the fleet.
        setRun(null);
        window.sessionStorage.removeItem(ANSWERS_KEY);
        onMemberRef.current();
      } else if (to === "apply") setStep("apply");
    },
    [setRun],
  );
  const reread = useCallback(() => {
    void api.setupState().then(adopt, () => undefined);
  }, [adopt]);
  const relist = useCallback(() => {
    const at = Date.now();
    void api.jobs().then(
      (all) => setListing({ at, ids: new Set(all.map((j) => j.id)) }),
      () => undefined,
    );
  }, []);

  // The server became the fleet's ("session"), or a setup job ended: read where things stand.
  useEvent("session", reread);
  const ended = jobs
    .filter((j) => (j.kind === "setup" || j.kind === "setup-hub") && finished(j))
    .map((j) => j.id)
    .join();
  useEffect(() => {
    if (ended !== "") reread();
  }, [ended, reread]);
  // Back to this tab: whatever happened meanwhile (in another tab, or the terminal).
  useEffect(() => {
    relist();
    const back = () => {
      if (document.visibilityState !== "visible") return;
      reread();
      relist();
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [reread, relist]);
  // The run's job is gone from the server and this machine is not part-way through setup: it was abandoned.
  useEffect(() => {
    if (!gone || state.stage !== "fresh" || state.hub !== null || step !== "apply") return;
    setRun(null);
    setAnswers(initialAnswers(state));
    setStep("machines");
  }, [gone, state, step, setRun]);

  const reached = useCallback(
    (job: string, index: number) =>
      setRunState((r) => {
        if (r === null || (r.reached[job] ?? -1) >= index) return r;
        const next = { ...r, reached: { ...r.reached, [job]: index } };
        saveRun(next);
        return next;
      }),
    [],
  );

  const finish = () => {
    if (run !== null) setRun({ ...run, finished: true });
    go("done");
  };

  /** Into the fleet: once the server says this machine is a member, whether it switched in place or restarts. */
  const enter = async () => {
    setEntering(true);
    setEnterError(null);
    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        const now = await api.setupState();
        if (now.stage === "member") {
          setRun(null);
          window.sessionStorage.removeItem(ANSWERS_KEY);
          onMember();
          return;
        }
      } catch (error) {
        if (isUnauthorized(error)) {
          setEnterError(
            new Error(
              "t3-fleet ui restarted to serve your fleet, so this page's link no longer works. Open the newest link it printed in your terminal.",
            ),
          );
          setEntering(false);
          return;
        }
      }
      await sleep(500);
    }
    window.location.reload();
  };

  const context = { state, probe: probe.data };
  const hint = blocker(step, answers, context);

  const at = steps.indexOf(step);
  const locked = step === "apply" || step === "done";
  // A run this tab did not plan (resumed from the CLI, say): its answers are not these.
  const answered = !locked || (run !== null && run.steps.length > 0);
  const rail: ReadonlyArray<RailStep> = steps.map((id, i) => ({
    id,
    reachable: !locked && i < at,
    summary: !answered
      ? null
      : id === "machines"
        ? answers.alwaysOn === null && run !== null
          ? run.node
          : [
              answers.node,
              answers.alwaysOn === true ? "a hub" : null,
              answers.others > 0 ? `${answers.others} more` : null,
            ]
              .filter(Boolean)
              .join(", ")
        : id === "repo"
          ? answers.repo === "github"
            ? `${state.github ?? ""}/${answers.githubName}`
            : answers.repo === "url"
              ? shortRepo(answers.url)
              : answers.repo === "local"
                ? "This computer only"
                : null
          : id === "hub"
            ? answers.hubSkipped
              ? "Skipped for now"
              : (run?.hub?.node ?? (answers.hubNode || null))
            : id === "plan"
              ? plan.data === null
                ? null
                : `${plan.data.add.length} to add`
              : id === "apply"
                ? run?.finished === true
                  ? "Done"
                  : null
                : null,
  }));

  let content: ReactNode;
  switch (step) {
    case "machines":
      content = (
        <MachinesStep
          state={state}
          answers={answers}
          set={set}
          hint={hint}
          onNext={next}
          onRecheck={() => void recheck()}
          rechecking={rechecking}
          recheckError={recheckError}
        />
      );
      break;
    case "repo":
      content = (
        <RepoStep
          state={state}
          answers={answers}
          set={set}
          hint={hint}
          onBack={prev}
          onNext={next}
        />
      );
      break;
    case "hub":
      content = (
        <HubStep
          answers={answers}
          set={set}
          probe={probe}
          onProbe={() => void runProbe()}
          hint={hint}
          onBack={prev}
          onNext={() => {
            set({ hubSkipped: false });
            next();
          }}
          onSkip={() => {
            set({ hubSkipped: true });
            next();
          }}
        />
      );
      break;
    case "plan":
      content = (
        <PlanStep
          plan={{
            data: plan.data,
            loading: plan.loading,
            error: plan.error,
            ready,
            reload: () => void makePlan(request, requestKey),
          }}
          choices={choices}
          onChoose={(id, value) => setChoices((c) => ({ ...c, [id]: value }))}
          values={values}
          onValue={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
          later={later}
          onLater={(name, on) =>
            setLater((l) => {
              const n = new Set(l);
              if (on) n.add(name);
              else n.delete(name);
              return n;
            })
          }
          applying={applying}
          applyError={applyError}
          onBack={prev}
          onApply={() => void apply()}
        />
      );
      break;
    case "apply":
      content = (
        <ApplyStep
          state={state}
          run={run}
          listing={listing}
          jobs={jobs}
          now={now}
          onReached={reached}
          onResume={resume}
          onAbandon={abandon}
          onNext={finish}
        />
      );
      break;
    case "done":
      content = (
        <DoneStep
          run={run}
          fleetUrl={state.fleetUrl ?? null}
          onLeave={() => {
            // Off to the hub's copy of the app: nothing of this run is needed here again.
            setRun(null);
            window.sessionStorage.removeItem(ANSWERS_KEY);
          }}
          entering={entering}
          enterError={enterError}
          onEnter={() => void enter()}
        />
      );
      break;
  }

  return (
    <div className="flex h-full min-h-0">
      <StepRail steps={rail} current={step} onGo={go} footer={railFooter} />
      <div className="flex min-w-0 flex-1 flex-col">
        <StepBar steps={rail} current={step} />
        {banner}
        {abandoned === null ? null : (
          <AbandonedNote lines={abandoned} onDismiss={() => setAbandoned(null)} />
        )}
        {/* Keyed by step: each opens fresh, its heading focused. */}
        <div key={step} className="flex min-h-0 flex-1 flex-col">
          {content}
        </div>
      </div>
    </div>
  );
}

export type { UiProbe };
