/** Staged changes from non-authority machines, with their diffs; an authority approves or rejects them. */
import { CheckIcon, FileIcon, GitPullRequestArrowIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { ErrorState, LoadingRows, Page } from "../components/common";
import { ConfirmDialog } from "../components/dialogs";
import { Diff } from "../components/Diff";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty } from "../components/ui/empty";
import { Group } from "../components/ui/group";
import { Spinner } from "../components/ui/spinner";
import { api, type UiProposalT } from "../lib/api";
import { useEvent, useResource, useStore } from "../lib/store";
import { plural } from "../lib/utils";

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
        <code className="text-muted-foreground/70 text-2xs" title={p.commit}>
          {p.commit.slice(0, 8)}
        </code>
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
  const { runJob } = useStore();
  return (
    <ConfirmDialog
      open={verb !== null}
      title={`${verb === "approve" ? "Approve" : "Reject"} ${proposal.node}'s proposal?`}
      description={
        verb === "approve"
          ? `${plural(proposal.files.length, "file")} land on the branch in one commit, pushed now; every machine picks them up on its next sync. Only the diff shown here lands: if ${proposal.node} has pushed since, nothing happens and you review it again.`
          : `The proposal moves aside. On its next sync, ${proposal.node} stashes its copies of these files (recoverable with git stash) and takes the branch's.`
      }
      confirm={verb === "approve" ? "Approve" : "Reject"}
      icon={verb === "approve" ? <CheckIcon /> : <XIcon />}
      variant={verb === "reject" ? "destructive" : "default"}
      onConfirm={() => runJob(() => (verb === "approve" ? api.approve(proposal.node, proposal.commit) : api.reject(proposal.node, proposal.commit)))}
      onClose={onClose}
      onDone={onDecided}
    />
  );
}
