/** Staged changes from non-authority machines, with their diffs; an authority approves or rejects them. */
import { CheckIcon, FileIcon, GitPullRequestArrowIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { ErrorState, LoadingRows, Page } from "../components/common";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty } from "../components/ui/empty";
import { Group } from "../components/ui/group";
import { Spinner } from "../components/ui/spinner";
import { api, type UiProposalT } from "../lib/api";
import { useEvent, useResource, useStore } from "../lib/store";
import { cn, plural } from "../lib/utils";

export function ProposalsView() {
  const { session } = useStore();
  const proposals = useResource(api.proposals);
  // A sync elsewhere may have staged or settled a proposal.
  useEvent("pull", () => void proposals.reload());
  useEvent("state", () => void proposals.reload());
  const list = proposals.data ?? [];
  return (
    <Page
      title="Proposals"
      description={
        session === null
          ? undefined
          : session.authority
            ? "Changes other machines made under the auto-commit paths, waiting for you"
            : `${session.self} is not an authority: proposals can be reviewed here and approved on an authority`
      }
      actions={
        <Button size="sm" variant="outline" disabled={proposals.loading} onClick={() => void proposals.reload()}>
          {proposals.loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
          Refresh
        </Button>
      }
    >
      {proposals.data === null ? (
        <Group>
          {proposals.error === null ? <LoadingRows rows={2} /> : <ErrorState error={proposals.error} what="proposals" onRetry={() => void proposals.reload()} />}
        </Group>
      ) : list.length === 0 ? (
        <Group>
          <Empty icon={<GitPullRequestArrowIcon />} title="No proposals waiting">
            When a machine changes something under the auto-commit paths, its next sync proposes it here.
          </Empty>
        </Group>
      ) : (
        list.map((p) => (
          <Proposal
            key={p.node}
            proposal={p}
            canDecide={session?.authority === true}
            onDecided={() => proposals.setData(list.filter((x) => x.node !== p.node))}
          />
        ))
      )}
    </Page>
  );
}

function Proposal({ proposal: p, canDecide, onDecided }: { proposal: UiProposalT; canDecide: boolean; onDecided: () => void }) {
  const [deciding, setDeciding] = useState<"approve" | "reject" | null>(null);
  return (
    <Group>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <span className="font-semibold text-sm">{p.node}</span>
        <code className="text-muted-foreground text-xs">{p.branch}</code>
        {p.autoApprovable ? <Badge variant="info">auto-approvable</Badge> : null}
        <span className="text-muted-foreground text-xs">{p.summary}</span>
        <span className="ml-auto flex gap-2">
          <Button size="sm" variant="destructive-outline" disabled={!canDecide} onClick={() => setDeciding("reject")}>
            <XIcon />
            Reject
          </Button>
          <Button size="sm" disabled={!canDecide} onClick={() => setDeciding("approve")}>
            <CheckIcon />
            Approve
          </Button>
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-xs">
        {p.files.map((f) => (
          <span key={f} className="flex items-center gap-1 font-mono text-muted-foreground">
            <FileIcon className="size-3" />
            {f}
          </span>
        ))}
      </div>
      <Diff text={p.diff} />
      <DecideDialog proposal={p} verb={deciding} onClose={() => setDeciding(null)} onDecided={onDecided} />
    </Group>
  );
}

/** A unified diff, coloured the way T3's diff panel colours additions and deletions. */
export function Diff({ text }: { text: string }) {
  if (text.trim() === "") return <div className="px-4 py-3 text-muted-foreground text-xs">No textual changes (binary files or modes only).</div>;
  return (
    <div className="max-h-[32rem] overflow-auto bg-code">
      <pre className="min-w-fit py-2 font-mono text-[0.6875rem] leading-[1.125rem]">
        {text.split("\n").map((line, i) => {
          const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")
            ? "meta"
            : line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+")
                ? "add"
                : line.startsWith("-")
                  ? "del"
                  : "ctx";
          return (
            <div
              key={i}
              className={cn(
                "px-4 whitespace-pre",
                kind === "add" && "bg-diff-addition/10 text-success-foreground",
                kind === "del" && "bg-diff-deletion/10 text-destructive-foreground",
                kind === "hunk" && "text-info-foreground",
                kind === "meta" && "font-semibold text-muted-foreground",
              )}
            >
              {line === "" ? " " : line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function DecideDialog({
  proposal,
  verb,
  onClose,
  onDecided,
}: {
  proposal: UiProposalT;
  verb: "approve" | "reject" | null;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const decide = async () => {
    if (verb === null) return;
    setRunning(true);
    setError(null);
    try {
      await (verb === "approve" ? api.approve(proposal.node) : api.reject(proposal.node));
      onClose();
      onDecided();
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
    }
  };
  return (
    <AlertDialog
      open={verb !== null}
      onOpenChange={(open) => {
        if (!open && !running) {
          setError(null);
          onClose();
        }
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {verb === "approve" ? "Approve" : "Reject"} {proposal.node}'s proposal?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {verb === "approve"
              ? `${plural(proposal.files.length, "file")} land on the branch in one commit, pushed now; every machine picks them up on its next sync.`
              : `The proposal moves aside. On its next sync, ${proposal.node} stashes its copies of these files (recoverable with git stash) and takes the branch's.`}
          </AlertDialogDescription>
          {error === null ? null : (
            <div className="mt-2 rounded-lg border border-destructive/30 bg-error-surface px-3 py-2 text-destructive-foreground text-xs">
              {error instanceof Error ? error.message : String(error)}
            </div>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" disabled={running} />}>Cancel</AlertDialogClose>
          <Button variant={verb === "reject" ? "destructive" : "default"} disabled={running} onClick={() => void decide()}>
            {running ? <Spinner className="size-3.5" /> : verb === "approve" ? <CheckIcon /> : <XIcon />}
            {verb === "approve" ? "Approve" : "Reject"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
