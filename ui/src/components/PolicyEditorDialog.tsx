import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  COMPANY_POLICY_CHANGE_SUMMARY_MAX_LENGTH,
  COMPANY_POLICY_KEY_MAX_LENGTH,
  COMPANY_POLICY_STATUSES,
  COMPANY_POLICY_SUMMARY_MAX_LENGTH,
  COMPANY_POLICY_TITLE_MAX_LENGTH,
  type CompanyPolicy,
  type CompanyPolicyRevision,
  type CompanyPolicyStatus,
  type UpdateCompanyPolicy,
} from "@paperclipai/shared";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { policiesApi } from "../api/policies";
import { projectsApi } from "../api/projects";
import { buildCompanyUserInlineOptions } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor } from "./MarkdownEditor";

const COMPANY_SCOPE = "company";
const NO_OWNER = "none";

/** Lowercase slug for a new policy's key, derived from its title until the user edits the key. */
export function policyKeyFromTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, COMPANY_POLICY_KEY_MAX_LENGTH)
    .replace(/-+$/g, "");
}

function ownerValue(policy: Pick<CompanyPolicy, "ownerAgentId" | "ownerUserId"> | null): string {
  if (policy?.ownerAgentId) return `agent:${policy.ownerAgentId}`;
  if (policy?.ownerUserId) return `user:${policy.ownerUserId}`;
  return NO_OWNER;
}

function ownerFields(value: string): { ownerAgentId: string | null; ownerUserId: string | null } {
  if (value.startsWith("agent:")) return { ownerAgentId: value.slice("agent:".length), ownerUserId: null };
  if (value.startsWith("user:")) return { ownerAgentId: null, ownerUserId: value.slice("user:".length) };
  return { ownerAgentId: null, ownerUserId: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Paperclip could not save the policy.";
}

/** The editable fields of a policy, as the dialog holds them. */
export interface PolicyEditorForm {
  title: string;
  body: string;
  summary: string;
  status: CompanyPolicyStatus;
  projectId: string | null;
  /** `none`, `agent:<id>` or `user:<id>`. */
  owner: string;
  changeSummary: string;
}

/**
 * The PATCH body for an edited policy: only the changed fields. A title or body change also sends the
 * revision the edit started from, so the server refuses it when someone saved a newer revision first.
 */
export function buildPolicyPatch(policy: CompanyPolicy, form: PolicyEditorForm): UpdateCompanyPolicy {
  const patch: UpdateCompanyPolicy = {};
  const title = form.title.trim();
  const summary = form.summary.trim() || null;
  const owners = ownerFields(form.owner);
  if (title !== policy.title) patch.title = title;
  if (form.body !== policy.body) patch.body = form.body;
  if (patch.title !== undefined || patch.body !== undefined) {
    patch.baseRevisionId = policy.latestRevisionId;
    if (form.changeSummary.trim()) patch.changeSummary = form.changeSummary.trim();
  }
  if (summary !== policy.summary) patch.summary = summary;
  if (form.status !== policy.status) patch.status = form.status;
  if (form.projectId !== policy.projectId) patch.projectId = form.projectId;
  if (owners.ownerAgentId !== policy.ownerAgentId || owners.ownerUserId !== policy.ownerUserId) {
    if (owners.ownerAgentId) patch.ownerAgentId = owners.ownerAgentId;
    else if (owners.ownerUserId) patch.ownerUserId = owners.ownerUserId;
    else Object.assign(patch, { ownerAgentId: null, ownerUserId: null });
  }
  return patch;
}

export interface PolicyEditorDialogProps {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The policy to edit; null opens the dialog for a new policy. */
  policy: CompanyPolicy | null;
  /** The scope a new policy starts with: a project ID, or null for a company policy. */
  defaultProjectId?: string | null;
}

/**
 * Creates or edits a company or project policy: title, key, summary, markdown body, status, scope and owner.
 * An existing policy also shows its revision history, where an older revision can be restored.
 */
export function PolicyEditorDialog({ companyId, open, onOpenChange, policy, defaultProjectId = null }: PolicyEditorDialogProps) {
  const queryClient = useQueryClient();
  const isNew = policy === null;
  const [title, setTitle] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<CompanyPolicyStatus>("draft");
  const [scope, setScope] = useState(COMPANY_SCOPE);
  const [owner, setOwner] = useState(NO_OWNER);
  const [changeSummary, setChangeSummary] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [viewedRevisionId, setViewedRevisionId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.policies.all(companyId) });

  const save = useMutation({
    mutationFn: async () => {
      const projectId = scope === COMPANY_SCOPE ? null : scope;
      if (!policy) {
        const owners = ownerFields(owner);
        return policiesApi.create(companyId, {
          key: key.trim(),
          title: title.trim(),
          summary: summary.trim() || null,
          body,
          status,
          projectId,
          ...(owners.ownerAgentId ? { ownerAgentId: owners.ownerAgentId } : {}),
          ...(owners.ownerUserId ? { ownerUserId: owners.ownerUserId } : {}),
        });
      }
      return policiesApi.update(
        companyId,
        policy.key,
        buildPolicyPatch(policy, { title, body, summary, status, projectId, owner, changeSummary }),
      );
    },
    onSuccess: async () => {
      await invalidate();
      onOpenChange(false);
    },
    // A newer revision (409) or a changed policy: refresh the cached policies, so reopening loads the newest one.
    onError: () => void invalidate(),
  });

  const restore = useMutation({
    mutationFn: (revision: CompanyPolicyRevision) =>
      policiesApi.update(companyId, policy!.key, {
        title: revision.title ?? policy!.title,
        body: revision.body,
        changeSummary: `Restore revision ${revision.revisionNumber}`,
        baseRevisionId: policy!.latestRevisionId,
      }),
    onSuccess: async () => {
      await invalidate();
      onOpenChange(false);
    },
    onError: () => void invalidate(),
  });

  const remove = useMutation({
    mutationFn: () => policiesApi.remove(companyId, policy!.key),
    onSuccess: async () => {
      await invalidate();
      onOpenChange(false);
    },
  });

  const resetSave = save.reset;
  const resetRestore = restore.reset;
  const resetRemove = remove.reset;

  useEffect(() => {
    if (!open) return;
    resetSave();
    resetRestore();
    resetRemove();
    setTitle(policy?.title ?? "");
    setKey(policy?.key ?? "");
    setKeyEdited(false);
    setSummary(policy?.summary ?? "");
    setBody(policy?.body ?? "");
    setStatus(policy?.status ?? "draft");
    setScope(policy ? (policy.projectId ?? COMPANY_SCOPE) : (defaultProjectId ?? COMPANY_SCOPE));
    setOwner(ownerValue(policy));
    setChangeSummary("");
    setShowHistory(false);
    setViewedRevisionId(null);
    setConfirmDelete(false);
  }, [open, policy, defaultProjectId, resetSave, resetRestore, resetRemove]);

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: open,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open,
  });
  const { data: userDirectory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: open,
  });
  const revisionsQuery = useQuery({
    queryKey: queryKeys.policies.revisions(companyId, policy?.key ?? ""),
    queryFn: () => policiesApi.revisions(companyId, policy!.key),
    enabled: open && showHistory && policy !== null,
  });

  const projectOptions = useMemo(() => {
    const list = (projects ?? []).map((project) => ({ id: project.id, name: project.name }));
    const currentProjectId = policy?.projectId ?? defaultProjectId;
    if (currentProjectId && !list.some((project) => project.id === currentProjectId)) {
      list.push({ id: currentProjectId, name: "Archived project" });
    }
    return list;
  }, [projects, policy?.projectId, defaultProjectId]);

  const userOptions = useMemo(() => {
    const list = buildCompanyUserInlineOptions(userDirectory?.users);
    const currentOwner = policy?.ownerUserId ? `user:${policy.ownerUserId}` : null;
    if (currentOwner && !list.some((option) => option.id === currentOwner)) {
      list.push({ id: currentOwner, label: "Former member" });
    }
    return list;
  }, [userDirectory?.users, policy?.ownerUserId]);
  const agentOptions = (agents ?? []).filter((agent) => agent.status !== "terminated" || agent.id === policy?.ownerAgentId);

  const keyValid = /^[a-z0-9][a-z0-9-]*$/.test(key.trim());
  const canSave = title.trim().length > 0 && (!isNew || keyValid) && !save.isPending;
  const mutationError = save.error ?? restore.error ?? remove.error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-2xl">
        <div className="flex flex-col gap-1 border-b border-border px-4 py-3">
          <DialogTitle className="text-base">{isNew ? "New policy" : "Edit policy"}</DialogTitle>
          <DialogDescription className="text-xs">
            Written guidance for agents. Active policies apply to every task in their scope.
          </DialogDescription>
        </div>

        <div className="flex max-h-(--sz-50vh) flex-col gap-3 overflow-y-auto px-4 py-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-title">Title</Label>
            <Input
              id="policy-title"
              value={title}
              maxLength={COMPANY_POLICY_TITLE_MAX_LENGTH}
              placeholder="Code review"
              onChange={(event) => {
                setTitle(event.target.value);
                if (isNew && !keyEdited) setKey(policyKeyFromTitle(event.target.value));
              }}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            {isNew ? (
              <>
                <Label htmlFor="policy-key">Key</Label>
                <Input
                  id="policy-key"
                  className="font-mono"
                  value={key}
                  maxLength={COMPANY_POLICY_KEY_MAX_LENGTH}
                  placeholder="code-review"
                  aria-invalid={key.length > 0 && !keyValid}
                  onChange={(event) => {
                    setKey(event.target.value);
                    setKeyEdited(true);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Lowercase letters, numbers and dashes. Referenced as <code>policy://{key || "key"}</code>. It cannot change later.
                </p>
              </>
            ) : (
              <>
                <span className="text-sm font-medium">Key</span>
                <p className="font-mono text-sm text-muted-foreground">policy://{policy.key}</p>
              </>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-summary">Summary</Label>
            <Input
              id="policy-summary"
              value={summary}
              maxLength={COMPANY_POLICY_SUMMARY_MAX_LENGTH}
              placeholder="One line agents see before they open the full policy"
              onChange={(event) => setSummary(event.target.value.replace(/[\r\n]+/g, " "))}
            />
          </div>

          <div className="flex flex-col gap-1.5" role="group" aria-labelledby="policy-body-label">
            <Label id="policy-body-label">Policy</Label>
            <MarkdownEditor
              value={body}
              onChange={setBody}
              placeholder="Write the rule, why it exists, and how to follow it…"
              contentClassName="min-h-(--sz-120px) text-sm"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="policy-status">Status</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as CompanyPolicyStatus)}>
                <SelectTrigger id="policy-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPANY_POLICY_STATUSES.map((value) => (
                    <SelectItem key={value} value={value} className="capitalize">
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="policy-scope">Applies to</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger id="policy-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={COMPANY_SCOPE}>Whole company</SelectItem>
                  {projectOptions.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      Project: {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="policy-owner">Owner</Label>
              <Select value={owner} onValueChange={setOwner}>
                <SelectTrigger id="policy-owner" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_OWNER}>No owner</SelectItem>
                  {userOptions.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>People</SelectLabel>
                      {userOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                  {agentOptions.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>Agents</SelectLabel>
                      {agentOptions.map((agent) => (
                        <SelectItem key={agent.id} value={`agent:${agent.id}`}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                </SelectContent>
              </Select>
            </div>
          </div>

          {!isNew ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="policy-change-summary">Change note</Label>
              <Input
                id="policy-change-summary"
                value={changeSummary}
                maxLength={COMPANY_POLICY_CHANGE_SUMMARY_MAX_LENGTH}
                placeholder="Saved with the new revision when the title or policy text changes"
                onChange={(event) => setChangeSummary(event.target.value)}
              />
            </div>
          ) : null}

          {!isNew ? (
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                aria-expanded={showHistory}
                onClick={() => setShowHistory((current) => !current)}
              >
                <History className="h-3.5 w-3.5" />
                {showHistory ? "Hide history" : `History (${policy.latestRevisionNumber} revisions)`}
              </Button>
              {showHistory ? (
                revisionsQuery.isLoading ? (
                  <p className="text-sm text-muted-foreground">Loading history…</p>
                ) : revisionsQuery.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    Failed to load history: {revisionsQuery.error.message}
                  </p>
                ) : (
                  <>
                    {(revisionsQuery.data?.length ?? 0) < policy.latestRevisionNumber ? (
                      <p className="text-xs text-muted-foreground">
                        Showing the newest {revisionsQuery.data?.length ?? 0} of {policy.latestRevisionNumber} revisions.
                      </p>
                    ) : null}
                    <ol className="flex flex-col rounded-lg border border-border" aria-label="Policy revisions">
                      {(revisionsQuery.data ?? []).map((revision) => {
                        const isLatest = revision.id === policy.latestRevisionId;
                        const isViewed = viewedRevisionId === revision.id;
                        return (
                          <li key={revision.id} className="flex flex-col gap-2 border-b border-border px-3 py-2 last:border-b-0">
                            <div className="flex flex-wrap items-center gap-2 text-sm">
                              <span className="font-mono text-xs text-muted-foreground">#{revision.revisionNumber}</span>
                              <span className="min-w-0 flex-1 truncate">{revision.changeSummary ?? revision.title ?? "Revision"}</span>
                              <span className="text-xs text-muted-foreground">{timeAgo(revision.createdAt)}</span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => setViewedRevisionId(isViewed ? null : revision.id)}
                              >
                                {isViewed ? "Hide" : "View"}
                              </Button>
                              {!isLatest ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={restore.isPending}
                                  onClick={() => restore.mutate(revision)}
                                >
                                  Restore
                                </Button>
                              ) : (
                                <span className="text-xs text-muted-foreground">Current</span>
                              )}
                            </div>
                            {isViewed ? (
                              <div className="rounded-md bg-muted px-3 py-2 text-sm">
                                <MarkdownBody>{revision.body || "_Empty_"}</MarkdownBody>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>
                  </>
                )
              ) : null}
            </div>
          ) : null}

          {mutationError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutationError)}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {policy?.status === "archived" ? (
              confirmDelete ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {remove.isPending ? "Deleting…" : "Confirm delete"}
                </Button>
              ) : (
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              )
            ) : null}
          </div>
          <Button type="button" size="sm" disabled={!canSave} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : isNew ? "Create policy" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
