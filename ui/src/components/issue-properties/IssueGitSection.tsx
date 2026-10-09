import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, RotateCw, Terminal, X } from "lucide-react";
import type { IssueGitPullRequest, IssueGitPullRequestState, IssueGitView, LinkIssuePullRequest } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyText } from "@/components/CopyText";
import { ExternalObjectStatusIcon } from "@/components/ExternalObjectStatusIcon";
import { PropertyRow, PropertySection } from "./primitives";

const PULL_REQUEST_URL = /^https:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*(?:[/?#].*)?$/;
const PULL_REQUEST_SHORT = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;

const STATE_LABEL: Record<IssueGitPullRequestState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
const STATE_ICON: Record<IssueGitPullRequestState, { category: "open" | "waiting" | "succeeded" | "closed"; key: string }> = {
  open: { category: "open", key: "git-pull-request" },
  draft: { category: "waiting", key: "clock" },
  merged: { category: "succeeded", key: "git-merge" },
  closed: { category: "closed", key: "x-circle" },
};
const LINKED_BY_LABEL: Record<IssueGitPullRequest["linkedBy"], string> = {
  manual: "linked by hand",
  workspace_branch: "agent workspace branch",
  head_ref: "branch name",
  keyword: "closing word",
  bracket: "[ID] in title",
  refs: "reference",
  mention: "mention",
};
const HELD_REASON: Record<string, string> = {
  unverified: "Not confirmed to come from this repository, so status is left alone",
  refs_only: "A reference only, so status is left alone",
  ineligible: "Status is left alone for this task",
  gated: "A review policy decides this task's status",
  active_run: "Waiting: an agent run is active",
  pending_confirmation: "Waiting: a confirmation is pending",
  manual_change: "Status was changed by hand, so automation stopped",
};

/** Turns what a person typed into the body the link endpoint takes, or null if it is neither form. */
function parseReference(value: string): LinkIssuePullRequest | null {
  const text = value.trim();
  if (PULL_REQUEST_URL.test(text)) return { url: text };
  const short = PULL_REQUEST_SHORT.exec(text);
  return short ? { repository: short[1]!, number: Number(short[2]) } : null;
}

function statusWords(status: string): string {
  return status.replace(/_/g, " ");
}

function PullRequestItem({ pr, onUnlink, unlinking }: { pr: IssueGitPullRequest; onUnlink: () => void; unlinking: boolean }) {
  const icon = STATE_ICON[pr.state];
  const held = pr.automation.deferred ? HELD_REASON[pr.automation.deferred] : undefined;
  const name = `${pr.repository}#${pr.number}`;
  return (
    <li className="flex min-w-0 flex-col gap-1 py-1" data-testid="issue-git-pr">
      <div className="flex min-w-0 items-center gap-1.5">
        <ExternalObjectStatusIcon category={icon.category} liveness="fresh" statusIconKey={icon.key} label={STATE_LABEL[pr.state]} />
        {pr.url ? (
          <a href={pr.url} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate text-xs hover:underline" title={pr.title}>
            {name}
          </a>
        ) : (
          <span className="min-w-0 truncate text-xs" title={pr.title}>{name}</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto text-muted-foreground"
          aria-label={`Unlink ${name}`}
          title="Unlink. It will not be linked again automatically."
          disabled={unlinking}
          onClick={onUnlink}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1 pl-5">
        <Badge variant="outline">{STATE_LABEL[pr.state]}</Badge>
        <Badge variant="secondary">{pr.closes ? "Closes" : "Refs only"}</Badge>
        {!pr.verified ? (
          <Badge variant="outline" title="Not confirmed to come from this repository. Status automation ignores it.">Unverified</Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">{LINKED_BY_LABEL[pr.linkedBy]}</span>
      </div>
      {pr.automation.applied ? (
        <p className="pl-5 text-xs text-muted-foreground">
          Moved {statusWords(pr.automation.applied.from)} → {statusWords(pr.automation.applied.to)}
        </p>
      ) : held ? (
        <p className="pl-5 text-xs text-muted-foreground">{held}</p>
      ) : null}
    </li>
  );
}

/**
 * The task's git panel: the branch to copy and the pull requests linked to it.
 * Pull requests link themselves; this is also where a person links or unlinks one by hand.
 */
export function IssueGitSection({ issueId, streamlined }: { issueId: string; streamlined?: boolean }) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.issues.git(issueId);
  const { data, isLoading, isError, refetch } = useQuery({ queryKey, queryFn: () => issuesApi.getGit(issueId), staleTime: 30_000 });
  const [linking, setLinking] = useState(false);
  const [reference, setReference] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (linking) inputRef.current?.focus();
  }, [linking]);

  const link = useMutation({
    mutationFn: (body: LinkIssuePullRequest) => issuesApi.linkPullRequest(issueId, body),
    onSuccess: (view: IssueGitView) => {
      queryClient.setQueryData(queryKey, view);
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.workProducts(issueId) });
      setReference("");
      setFormError(null);
      setLinking(false);
    },
    onError: (error: unknown) => setFormError(error instanceof Error ? error.message : "Could not link the pull request"),
  });
  const unlink = useMutation({
    mutationFn: (workProductId: string) => issuesApi.unlinkPullRequest(issueId, workProductId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.workProducts(issueId) });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const body = parseReference(reference);
    if (!body) {
      setFormError("Paste a github.com pull request URL, or owner/repo#number.");
      return;
    }
    setFormError(null);
    link.mutate(body);
  }

  return (
    <PropertySection title="Git" streamlined={streamlined}>
      {isLoading ? (
        <PropertyRow label="Branch"><span className="text-xs text-muted-foreground">Loading…</span></PropertyRow>
      ) : isError || !data ? (
        <PropertyRow label="Branch">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Could not load git details
            <Button type="button" variant="ghost" size="xs" aria-label="Retry loading git details" onClick={() => void refetch()}>
              <RotateCw aria-hidden="true" />
            </Button>
          </span>
        </PropertyRow>
      ) : (
        <>
          <PropertyRow label="Branch">
            <span className="flex min-w-0 items-center gap-1.5">
              <code className="min-w-0 truncate font-mono text-xs" title={data.branch.name}>{data.branch.name}</code>
              <CopyText text={data.branch.name} ariaLabel="Copy branch name" title="Copy branch name" copiedLabel="Branch copied">
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              </CopyText>
              <CopyText text={data.branch.command} ariaLabel="Copy git command" title={`Copy: ${data.branch.command}`} copiedLabel="Command copied">
                <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
              </CopyText>
            </span>
          </PropertyRow>
          {data.pullRequests.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">
              No pull requests linked. Name the branch or write &ldquo;Fixes {data.identifier ?? "this task"}&rdquo; in the pull request and it links itself.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {data.pullRequests.map((pr) => (
                <PullRequestItem key={pr.workProductId} pr={pr} unlinking={unlink.isPending} onUnlink={() => unlink.mutate(pr.workProductId)} />
              ))}
            </ul>
          )}
          {data.pullRequests.length > 0 && !data.statusAutomation.enabled ? (
            <p className="py-1 text-xs text-muted-foreground">Status automation is off. Links still update.</p>
          ) : null}
          {linking ? (
            <form className="flex min-w-0 flex-col gap-1 py-1" onSubmit={submit}>
              <div className="flex min-w-0 items-center gap-1.5">
                <input
                  ref={inputRef}
                  className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder="Pull request URL or owner/repo#number"
                  aria-label="Pull request URL or owner/repo#number"
                />
                <Button type="submit" size="xs" disabled={link.isPending || reference.trim() === ""}>Link</Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => { setLinking(false); setFormError(null); setReference(""); }}>Cancel</Button>
              </div>
              {formError ? <p role="alert" className="text-xs text-destructive">{formError}</p> : null}
            </form>
          ) : (
            <Button type="button" variant="ghost" size="xs" className="justify-start text-muted-foreground" aria-label="Link a pull request" onClick={() => setLinking(true)}>
              <Link2 aria-hidden="true" />
              Link a pull request
            </Button>
          )}
        </>
      )}
    </PropertySection>
  );
}
