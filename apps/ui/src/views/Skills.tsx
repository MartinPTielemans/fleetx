/**
 * The config repo's skills, and how each machine has them linked. Adding,
 * updating and removing change the repo the way `t3-fleet skills` does: an
 * authority commits, any other machine's next sync proposes. Linking them on
 * a machine, and adopting skills installed outside T3 Fleet, are fixes, applied
 * through the same dialog as on the Findings view.
 */
import type { UiSkill, UiSkillsNode } from "@t3-fleet/core/Api";
import {
  CheckCircle2Icon,
  DownloadIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ErrorState, LoadingRows, Page, SeverityIcon } from "../components/common";
import { ActionDialog, ConfirmDialog, Failure } from "../components/dialogs";
import { Diff } from "../components/Diff";
import { ApplyDialog, fixable } from "../components/fixes";
import {
  AlertDialogBody,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty } from "../components/ui/empty";
import { Group, GroupLabel } from "../components/ui/group";
import { Spinner } from "../components/ui/spinner";
import { api, type UiJobT, type UiSkillsLandedT } from "../lib/api";
import { useAction, useEvent, useResource, useStore } from "../lib/store";
import { plural } from "../lib/utils";

const tilde = (dir: string) =>
  dir.replace(/^\/(Users|home)\/[^/]+\//, "~/").replace(/^\/root\//, "~/");

/** owner/repo for a GitHub URL, else the URL. */
const sourceLabel = (url: string) =>
  /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? url;

type Dialog =
  | { readonly kind: "add" }
  | { readonly kind: "update"; readonly skills: ReadonlyArray<string> }
  | { readonly kind: "remove"; readonly skill: string }
  | { readonly kind: "fix"; readonly ids: ReadonlyArray<string> };

export function SkillsView() {
  const { session, status, recheck, checking } = useStore();
  const skills = useResource(api.skills);
  // Links come with each check; the repo changes when a sync pulls.
  useEvent("check", () => void skills.reload());
  useEvent("pull", () => void skills.reload());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const attention = useMemo(
    () => (status?.findings ?? []).filter((f) => f.area === "skills" && f.accepted === undefined),
    [status],
  );
  const fixes = attention.filter(fixable);
  const sourced = (skills.data?.skills ?? []).filter((s) => s.source !== null);
  const changed = () => {
    void skills.reload();
  };

  return (
    <Page
      wide
      title="Skills"
      description="Skills in the config repo, and how each machine has them linked"
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={checking || skills.loading}
            onClick={() => void recheck()}
          >
            {checking ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
            Check machines
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={sourced.length === 0}
            onClick={() => setDialog({ kind: "update", skills: [] })}
          >
            <DownloadIcon />
            Check for updates
          </Button>
          <Button size="sm" onClick={() => setDialog({ kind: "add" })}>
            <PlusIcon />
            Add skills
          </Button>
        </>
      }
    >
      {attention.length === 0 ? null : (
        <section>
          <GroupLabel className="flex items-center gap-2">
            <span>Needs attention</span>
            {fixes.length > 1 ? (
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                onClick={() => setDialog({ kind: "fix", ids: fixes.map((f) => f.id) })}
              >
                <WrenchIcon />
                Fix all {fixes.length}
              </Button>
            ) : null}
          </GroupLabel>
          <Group>
            {attention.map((f) => (
              <div key={f.id} className="flex items-start gap-3 px-4 py-2.5">
                <SeverityIcon severity={f.severity} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm">
                    <span className="font-medium">{f.node}</span> <span>{f.title}</span>
                  </div>
                  {f.detail === undefined ? null : (
                    <div className="text-muted-foreground text-xs">{f.detail}</div>
                  )}
                </div>
                {fixable(f) ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setDialog({ kind: "fix", ids: [f.id] })}
                  >
                    <WrenchIcon />
                    {f.fix.command.startsWith("t3-fleet skills adopt") ? "Adopt" : "Fix"}
                  </Button>
                ) : null}
              </div>
            ))}
          </Group>
        </section>
      )}

      {skills.data === null ? (
        <Group>
          {skills.error === null ? (
            <LoadingRows rows={5} />
          ) : (
            <ErrorState error={skills.error} what="skills" onRetry={() => void skills.reload()} />
          )}
        </Group>
      ) : skills.data.skills.length === 0 ? (
        <Group>
          <Empty icon={<SparklesIcon />} title="No skills in the config repo yet">
            Add skills from a git repository, or adopt ones a machine installed outside T3 Fleet;
            every machine links them on its next sync.
          </Empty>
        </Group>
      ) : (
        <SkillsTable
          skills={skills.data.skills}
          nodes={skills.data.nodes}
          self={session?.self ?? null}
          onUpdate={(name) => setDialog({ kind: "update", skills: [name] })}
          onRemove={(name) => setDialog({ kind: "remove", skill: name })}
        />
      )}

      {session === null ? null : (
        <p className="px-1 text-muted-foreground text-xs">
          {session.authority
            ? "Adding, updating or removing a skill here commits and pushes it; every machine links the change on its next sync."
            : `${session.self} is not an authority: adding, updating or removing a skill here is proposed by its next sync, for an authority to approve.`}
        </p>
      )}

      <AddDialog
        open={dialog?.kind === "add"}
        onClose={() => setDialog(null)}
        onChanged={changed}
      />
      <UpdateDialog
        skills={dialog?.kind === "update" ? dialog.skills : null}
        onClose={() => setDialog(null)}
        onChanged={changed}
      />
      <RemoveDialog
        skill={dialog?.kind === "remove" ? dialog.skill : null}
        onClose={() => setDialog(null)}
        onChanged={changed}
      />
      <ApplyDialog
        ids={dialog?.kind === "fix" ? dialog.ids : null}
        onClose={() => setDialog(null)}
        onApplied={changed}
      />
    </Page>
  );
}

function SkillsTable({
  skills,
  nodes,
  self,
  onUpdate,
  onRemove,
}: {
  skills: ReadonlyArray<UiSkill>;
  nodes: ReadonlyArray<UiSkillsNode>;
  self: string | null;
  onUpdate: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  return (
    <Group>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground text-xs">
              <th className="px-4 py-2 font-medium">Skill</th>
              {nodes.map((n) => (
                <th
                  key={n.node}
                  className="px-3 py-2 text-center font-medium"
                  title={n.store === null ? undefined : `store ${tilde(n.store)}`}
                >
                  {n.node}
                  {n.node === self ? (
                    <span className="block font-normal text-2xs">this machine</span>
                  ) : null}
                </th>
              ))}
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => (
              <tr key={s.name} className="border-t border-border/50 align-top">
                <td className="max-w-md px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    {s.source === null ? (
                      <Badge variant="secondary">local</Badge>
                    ) : (
                      <Badge variant="outline" title={s.source.url}>
                        {sourceLabel(s.source.url)}
                      </Badge>
                    )}
                  </div>
                  {s.description === null ? null : (
                    <div className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
                      {s.description}
                    </div>
                  )}
                </td>
                {nodes.map((n) => (
                  <td key={n.node} className="px-3 py-2.5 text-center">
                    <LinkCell skill={s.name} node={n} />
                  </td>
                ))}
                <td className="px-4 py-2">
                  <div className="flex justify-end gap-1">
                    {s.source === null ? null : (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        title={`Check ${s.name} for updates`}
                        aria-label={`Check ${s.name} for updates`}
                        onClick={() => onUpdate(s.name)}
                      >
                        <DownloadIcon />
                      </Button>
                    )}
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      title={`Remove ${s.name}`}
                      aria-label={`Remove ${s.name}`}
                      onClick={() => onRemove(s.name)}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Group>
  );
}

const STATE_TEXT = {
  ok: "linked",
  missing: "not linked",
  wrong: "links elsewhere",
  "real-dir": "a copy is in the way",
} as const;

/** One skill on one machine: linked everywhere, something to fix, ignored, or not known. */
function LinkCell({ skill, node: n }: { skill: string; node: UiSkillsNode }) {
  const quiet = (text: string, title: string) => (
    <span className="text-muted-foreground/70 text-xs" title={title}>
      {text}
    </span>
  );
  if (n.at === null) return quiet("—", "not reached in the last check");
  if (n.ignored.includes(skill))
    return quiet("ignored", "listed in this machine's [skills] ignore");
  if (n.store === null) return quiet("—", "this machine reports no skills");
  const links = n.links.filter((l) => l.skill === skill);
  if (links.length === 0)
    return quiet("not yet", "not in this machine's checkout yet; it arrives with the next sync");
  const broken = links.filter((l) => l.state !== "ok");
  const each = links.map((l) => `${tilde(l.dir)}: ${STATE_TEXT[l.state]}`);
  return (
    <span className="inline-flex items-center gap-1" title={each.join("\n")}>
      <SeverityIcon severity={broken.length === 0 ? "ok" : "warn"} className="size-3.5" />
      {broken.length === 0 ? null : (
        <span aria-hidden className="text-2xs text-warning-foreground">
          {links.length - broken.length}/{links.length}
        </span>
      )}
      <span className="sr-only">{each.join("; ")}</span>
    </span>
  );
}

// ── dialogs ─────────────────────────────────────────────────────────────

function Landed({ landed, verb }: { landed: UiSkillsLandedT; verb: string }) {
  const names = landed.paths
    .filter((p) => p !== "skills/SOURCES.json")
    .map((p) => p.replace(/^skills\//, ""));
  return (
    <div className="flex items-start gap-2 text-sm">
      <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
      <div>
        <div>
          {verb} {names.join(", ")}: {landed.landed}.
        </div>
        <div className="text-muted-foreground text-xs">
          Every machine links the change on its next sync.
        </div>
      </div>
    </div>
  );
}

/** What a skills job changed; a job always carries it when it is done. */
const landedOf = (job: UiJobT): UiSkillsLandedT => job.landed ?? { paths: [], landed: "done" };

function AddDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { runJob } = useStore();
  const [source, setSource] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [as, setAs] = useState("");
  const lookup = useAction(async (from: string) => {
    const result = await api.skillsLookup(from);
    const fresh = result.skills.filter((s) => !s.exists);
    setChosen(
      new Set(
        result.skills.length === 1
          ? result.skills.map((s) => s.name)
          : fresh.length === 1
            ? fresh.map((s) => s.name)
            : [],
      ),
    );
    return result;
  });
  const add = useAction(
    async (from: string, names: ReadonlyArray<string>, rename: string | undefined) => {
      const job = await runJob(() => api.skillsAdd(from, names, rename));
      onChanged();
      return landedOf(job);
    },
  );
  const found = lookup.result;
  const landed = add.result;
  const busy = lookup.running || add.running;

  const close = () => {
    setSource("");
    setChosen(new Set());
    setAs("");
    lookup.reset();
    add.reset();
    onClose();
  };

  const toggle = (name: string) => {
    const next = new Set(chosen);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setChosen(next);
  };

  return (
    <ActionDialog open={open} busy={add.running} onClose={close} className="max-w-xl">
      <AlertDialogHeader>
        <AlertDialogTitle>Add skills from a git repository</AlertDialogTitle>
        <AlertDialogDescription>
          The skills are copied into the config repo with a note of where they came from, so they
          work offline and can be updated later.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogBody className="flex flex-col gap-3">
        {landed !== null ? (
          <Landed landed={landed} verb="Added" />
        ) : (
          <>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (source.trim() !== "" && !busy) void lookup.start(source.trim());
              }}
            >
              <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--control-radius)] border border-input bg-popover px-2.5 text-sm shadow-xs/5 focus-within:ring-2 focus-within:ring-ring">
                <SearchIcon className="size-3.5 text-muted-foreground" />
                <input
                  autoFocus
                  aria-label="Repository"
                  value={source}
                  onChange={(e) => {
                    setSource(e.target.value);
                    lookup.reset();
                  }}
                  placeholder="owner/repo or a git URL"
                  className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                />
              </label>
              <Button type="submit" variant="outline" disabled={source.trim() === "" || busy}>
                {lookup.running ? <Spinner className="size-3.5" /> : null}
                Look up
              </Button>
            </form>
            {found === null ? null : (
              <div className="flex flex-col gap-1">
                <div className="text-muted-foreground text-xs">
                  {plural(found.skills.length, "skill")} in {sourceLabel(found.url)}
                </div>
                <div className="max-h-64 overflow-y-auto rounded-lg border">
                  {found.skills.map((s) => (
                    <label
                      key={s.name}
                      className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/50"
                    >
                      <input
                        type="checkbox"
                        checked={chosen.has(s.name)}
                        onChange={() => toggle(s.name)}
                        className="size-3.5"
                      />
                      <span className="font-medium">{s.name}</span>
                      {s.exists ? (
                        <span className="ml-auto text-muted-foreground text-xs">
                          already in the repo
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
                {chosen.size === 1 ? (
                  <label className="mt-2 flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Name it</span>
                    <input
                      value={as}
                      onChange={(e) => setAs(e.target.value)}
                      placeholder={[...chosen][0]}
                      className="h-7 min-w-0 flex-1 rounded-[var(--control-radius)] border border-input bg-popover px-2 outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                ) : null}
              </div>
            )}
          </>
        )}
        <Failure error={lookup.error ?? add.error} />
      </AlertDialogBody>
      <AlertDialogFooter>
        {landed !== null ? (
          <AlertDialogClose render={<Button />}>Done</AlertDialogClose>
        ) : (
          <>
            <AlertDialogClose render={<Button variant="ghost" disabled={add.running} />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={found === null || chosen.size === 0 || busy}
              onClick={() =>
                void add.start(
                  source.trim(),
                  [...chosen],
                  chosen.size === 1 && as.trim() !== "" ? as.trim() : undefined,
                )
              }
            >
              {add.running ? <Spinner className="size-3.5" /> : <PlusIcon />}
              {chosen.size === 0 ? "Add" : `Add ${plural(chosen.size, "skill")}`}
            </Button>
          </>
        )}
      </AlertDialogFooter>
    </ActionDialog>
  );
}

/** Preview what upstream changed (the repo is left as it was), then keep it. */
function UpdateDialog({
  skills,
  onClose,
  onChanged,
}: {
  skills: ReadonlyArray<string> | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { runJob } = useStore();
  const preview = useAction((names: ReadonlyArray<string>) => api.skillsPreview(names));
  const keep = useAction(async (names: ReadonlyArray<string>, digest: string) => {
    const job = await runJob(() => api.skillsUpdate(names, digest));
    onChanged();
    return landedOf(job);
  });
  const open = skills !== null;
  const which =
    skills === null || skills.length === 0 ? "every skill with a source" : skills.join(", ");
  const startPreview = preview.start;
  const resetPreview = preview.reset;
  const resetKeep = keep.reset;

  useEffect(() => {
    resetPreview();
    resetKeep();
    if (skills !== null) void startPreview(skills);
  }, [skills, startPreview, resetPreview, resetKeep]);

  const shown = preview.result;
  const landed = keep.result;
  const current = shown !== null && shown.digest === "";
  return (
    <ActionDialog open={open} busy={keep.running} onClose={onClose} className="max-w-3xl">
      <AlertDialogHeader>
        <AlertDialogTitle>Update {which}</AlertDialogTitle>
        <AlertDialogDescription>
          T3 Fleet pulls from upstream and shows the change; nothing is kept until you say so.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogBody className="flex flex-col gap-3">
        {landed !== null ? (
          <Landed landed={landed} verb="Updated" />
        ) : preview.running ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner className="size-3.5" />
            Pulling from upstream…
          </div>
        ) : current ? (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2Icon className="size-4 text-success" />
            Already up to date.
          </div>
        ) : shown === null ? null : (
          <>
            <pre className="overflow-x-auto font-mono text-muted-foreground text-xs">
              {shown.stat}
            </pre>
            <div className="overflow-hidden rounded-lg border">
              <Diff text={shown.diff} />
            </div>
          </>
        )}
        <Failure error={preview.error ?? keep.error} />
      </AlertDialogBody>
      <AlertDialogFooter>
        {landed !== null || current ? (
          <AlertDialogClose render={<Button />}>Done</AlertDialogClose>
        ) : (
          <>
            <AlertDialogClose render={<Button variant="ghost" disabled={keep.running} />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={skills === null || shown === null || preview.running || keep.running}
              onClick={() =>
                skills !== null && shown !== null && void keep.start(skills, shown.digest)
              }
            >
              {keep.running ? <Spinner className="size-3.5" /> : <DownloadIcon />}
              Keep the update
            </Button>
          </>
        )}
      </AlertDialogFooter>
    </ActionDialog>
  );
}

function RemoveDialog({
  skill,
  onClose,
  onChanged,
}: {
  skill: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { runJob } = useStore();
  // Kept while the dialog closes, so its title does not go blank.
  const [shown, setShown] = useState(skill);
  if (skill !== null && skill !== shown) setShown(skill);
  return (
    <ConfirmDialog
      open={skill !== null}
      title={`Remove ${shown}?`}
      description="It leaves the config repo (git history keeps it). On their next sync, machines report its links as pointing at nothing, with a fix to clean them up."
      confirm="Remove"
      icon={<Trash2Icon />}
      variant="destructive"
      onConfirm={() => runJob(() => api.skillsRemove([shown ?? ""])).then(landedOf)}
      onClose={onClose}
      onDone={onChanged}
      done={(landed) => <Landed landed={landed} verb="Removed" />}
    />
  );
}
