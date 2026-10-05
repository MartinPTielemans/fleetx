/** Where the fleet's setup lives: a new private GitHub repo, one that exists, or this computer only; and the extras. */
import type { UiSetupState } from "@t3-fleet/core/SetupApi";
import { ArrowRightIcon, GithubIcon, HardDriveIcon, LinkIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Group } from "../../components/ui/group";
import { ChoiceCard, CopyCommand, Field, Question, StepFrame, Toggle } from "./parts";
import { looksLikeRemote, type Answers, type Extra } from "./wizard";

const EXTRAS: ReadonlyArray<{ name: Extra; title: string; description: string }> = [
  {
    name: "model proxy",
    title: "Model proxy",
    description: "Retries, stats, and a login that doesn't expire, for the providers T3 runs here.",
  },
  {
    name: "T3 access",
    title: "T3 access",
    description: "Lets T3 Fleet read provider logins and health the way T3 itself sees them.",
  },
];

export function RepoStep({
  state,
  answers,
  set,
  hint,
  onBack,
  onNext,
}: {
  state: UiSetupState;
  answers: Answers;
  set: (patch: Partial<Answers>) => void;
  hint: string | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const others = answers.others > 0 || answers.alwaysOn === true;
  return (
    <StepFrame
      title="Where your setup lives"
      lead="Your skills, MCP servers, instructions and settings go in a git repository. Every machine syncs from it; credentials in it are encrypted to your machines' keys."
      back={onBack}
      hint={hint}
      actions={
        <Button disabled={hint !== null} onClick={onNext}>
          Continue
          <ArrowRightIcon />
        </Button>
      }
    >
      <form
        className="flex flex-col gap-10"
        onSubmit={(e) => {
          e.preventDefault();
          if (hint === null) onNext();
        }}
      >
        <div role="radiogroup" aria-label="Repository" className="flex flex-col gap-2.5">
          <ChoiceCard
            name="repo"
            value="github"
            checked={answers.repo === "github"}
            onChange={() => set({ repo: "github" })}
            disabled={state.github === null}
            icon={<GithubIcon />}
            title="Create a private repository on GitHub"
            description={
              state.github === null
                ? "Sign in with the GitHub CLI first, then check again on the first step."
                : `As ${state.github}, with the GitHub CLI. Only you can see it.`
            }
          >
            <Field
              label="Repository name"
              prefix={`github.com/${state.github ?? ""}/`}
              value={answers.githubName}
              onChange={(e) => set({ githubName: e.currentTarget.value })}
              problem={answers.githubName.trim() === "" ? "Give it a name" : null}
              maxLength={100}
            />
          </ChoiceCard>
          {state.github === null ? (
            <div className="-mt-1 pl-1">
              <CopyCommand command="gh auth login" className="max-w-xs" />
            </div>
          ) : null}
          <ChoiceCard
            name="repo"
            value="url"
            checked={answers.repo === "url"}
            onChange={() => set({ repo: "url" })}
            icon={<LinkIcon />}
            title="Use a repository you already have"
            description="To join a fleet another machine set up, or a repo you made yourself."
          >
            <Field
              label="Repository URL"
              placeholder="git@github.com:you/fleet.git"
              type="url"
              inputMode="url"
              value={answers.url}
              onChange={(e) => set({ url: e.currentTarget.value })}
              problem={looksLikeRemote(answers.url) ? null : "An https or ssh URL to clone"}
              hint="If it's already a fleet, this computer joins it: what it brings is proposed, and the fleet's authority approves it."
            />
          </ChoiceCard>
          <ChoiceCard
            name="repo"
            value="local"
            checked={answers.repo === "local"}
            onChange={() => set({ repo: "local" })}
            icon={<HardDriveIcon />}
            title="Only on this computer for now"
            description={
              others
                ? "A local repository. Your other machines need a remote to sync from, so you'd add one before they join."
                : "A local repository, backed up nowhere yet. Add a remote whenever you like."
            }
          />
        </div>

        <Question
          title="Extras for this computer"
          help="Optional, and each can be added later with t3-fleet setup."
        >
          <Group>
            {EXTRAS.map((x) => (
              <Toggle
                key={x.name}
                title={x.title}
                description={x.description}
                checked={answers.extras.includes(x.name)}
                onChange={(on) =>
                  set({
                    extras: on
                      ? [...answers.extras, x.name]
                      : answers.extras.filter((e) => e !== x.name),
                  })
                }
              />
            ))}
          </Group>
        </Question>
        <button type="submit" hidden />
      </form>
    </StepFrame>
  );
}
