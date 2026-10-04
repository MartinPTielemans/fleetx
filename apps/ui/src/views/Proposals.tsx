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

type Decision = { readonly verb: "approve" | "reject"; readonly proposal: UiProposalT };

export function ProposalsView() {
  const { session } = useStore();
  const proposals = useResource(api.proposals);
  // Which proposal is being decided, as it was when its dialog opened.
  const [deciding, setDeciding] = useState<Decision | null>(null);
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
          <Proposal key={p.node} proposal={p} canDecide={session?.authority === true} onDecide={(verb) => setDeciding({ verb, proposal: p })} />
        ))
      )}
      <DecideDialog
        decision={deciding}
        current={proposals.data === null || deciding === null ? undefined : (list.find((p) => p.node === deciding.proposal.node) ?? null)}
        onClose={() => setDeciding(null)}
        onDecided={(node) => proposals.setData(list.filter((x) => x.node !== node))}
      />
    </Page>
  );
}

function Proposal({ proposal: p, canDecide, onDecide }: { proposal: UiProposalT; canDecide: boolean; onDecide: (verb: "approve" | "reject") => void }) {
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
          <Button size="sm" variant="destructive-outline" disabled={!canDecide} onClick={() => onDecide("reject")}>
            <XIcon />
            Reject
          </Button>
          <Button size="sm" disabled={!canDecide} onClick={() => onDecide("approve")}>
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
    </Group>
  );
}

/**
 * Decides the proposal as it was when the dialog opened, with that diff in
 * view. If a sync changes it meanwhile (or it is settled elsewhere), the
 * dialog says so instead of deciding the new one unseen.
 */
function DecideDialog({
  decision,
  current,
  onClose,
  onDecided,
}: {
  decision: Decision | null;
  /** The proposal from the same machine as it is now: null when gone, undefined while unknown. */
  current: UiProposalT | null | undefined;
  onClose: () => void;
  onDecided: (node: string) => void;
}) {
  const { runJob } = useStore();
  // Kept while the dialog closes, so it does not go blank.
  const [shown, setShown] = useState(decision);
  if (decision !== null && decision !== shown) setShown(decision);
  if (shown === null) return null;
  const { verb, proposal } = shown;
  const gone = decision !== null && current === null;
  const changed = decision !== null && current != null && current.change !== proposal.change;
  return (
    <ConfirmDialog
      open={decision !== null}
      className="max-w-3xl"
      title={`${verb === "approve" ? "Approve" : "Reject"} ${proposal.node}'s proposal?`}
      description={
        verb === "approve"
          ? `${plural(proposal.files.length, "file")} ${proposal.files.length === 1 ? "lands" : "land"} on the branch in one commit, pushed now; every machine picks ${proposal.files.length === 1 ? "it" : "them"} up on its next sync. Only the change below lands: if it is different by then, nothing happens and you review it again.`
          : `The proposal moves aside. On its next sync, ${proposal.node} stashes its copies of these files (recoverable with git stash) and takes the branch's.`
      }
      confirm={verb === "approve" ? "Approve" : "Reject"}
      icon={verb === "approve" ? <CheckIcon /> : <XIcon />}
      variant={verb === "reject" ? "destructive" : "default"}
      disabled={gone || changed}
      onConfirm={() => runJob(() => (verb === "approve" ? api.approve(proposal.node, proposal.change) : api.reject(proposal.node, proposal.change)))}
      onClose={onClose}
      onDone={() => onDecided(proposal.node)}
    >
      {gone || changed ? (
        <div role="alert" className="rounded-lg border border-warning/32 bg-warning-surface px-3 py-2 text-warning-foreground text-xs">
          {gone
            ? `${proposal.node}'s proposal is no longer there: it was approved, rejected or withdrawn meanwhile.`
            : `${proposal.node} proposed something different while this was open. Close this and review the new one.`}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-lg border">
        <Diff text={proposal.diff} />
      </div>
    </ConfirmDialog>
  );
}
