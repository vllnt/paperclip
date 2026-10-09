import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  companies,
  executionWorkspaces,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import type {
  IssueGitAutomationState,
  IssueGitLinkedBy,
  IssueGitPullRequest,
  IssueGitPullRequestState,
  IssueGitView,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { buildIssueBranchName } from "./issue-git-branch.js";
import { extractIssueGitReferences } from "./issue-git-references.js";
import { instanceSettingsService } from "./instance-settings.js";
import { executeIssuePostCommitActions, issueService, type IssuePostCommitAction } from "./issues.js";
import {
  createPullRequestMergeDetailsResolver,
  extractGitHubPullRequestReferences,
  type PullRequestMergeDetailsResolver,
} from "./github-pull-request-merge.js";

const MAX_TARGETS = 10;
const AUTOMATION_ACTOR_ID = "system:git-link";
/** Only these origins belong to people and agents; every other origin has its own owner. */
const AUTOMATABLE_ORIGINS = new Set(["manual", "chat_channel"]);
const FALLBACK_DEFAULT_BRANCHES = new Set(["main", "master"]);

/** The facts every ingress reduces a pull request to before linking. */
export interface PullRequestSignal {
  provider: "github";
  /** `owner/name`. */
  repository: string;
  number: number;
  url: string;
  /** Absent on lean sources such as relay events; absent fields never erase stored ones. */
  title?: string | null;
  body?: string | null;
  headRef?: string | null;
  baseRef?: string | null;
  /** `owner/name` the head branch lives in. Differs from `repository` for forks. */
  headRepository?: string | null;
  defaultBranch?: string | null;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  updatedAt?: string | null;
  source: "manual" | "agent" | "cloud_event" | "plugin_poll";
}

export interface PullRequestEnrichment {
  headRepository?: string | null;
  defaultBranch?: string | null;
  title?: string | null;
  draft?: boolean | null;
}

export type PullRequestEnricher = (companyId: string, signal: PullRequestSignal) => Promise<PullRequestEnrichment | null>;

export interface IssueGitLinkServiceOptions {
  statusAutomationEnabled?: () => Promise<boolean>;
  enrich?: PullRequestEnricher;
  resolvePullRequestDetails?: PullRequestMergeDetailsResolver;
}

export interface RecordSignalOptions {
  /** Link to exactly this task (a person or agent chose it). Must belong to the company. */
  manualIssueId?: string;
  /** For a manual link: whether a merge completes the task. Defaults to true. */
  closes?: boolean;
}

export interface RecordedLink {
  issueId: string;
  identifier: string | null;
  workProductId: string;
  created: boolean;
  changed: boolean;
  skipped?: "suppressed" | "stale";
}

export interface RecordedAutomation {
  issueId: string;
  applied: { from: string; to: string } | null;
  deferred: string | null;
}

export interface RecordSignalResult {
  links: RecordedLink[];
  automation: RecordedAutomation[];
}

type WorkProductRow = typeof issueWorkProducts.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type Evidence = { linkedBy: IssueGitLinkedBy; closes: boolean };

interface GitMeta {
  linkedBy: IssueGitLinkedBy;
  closes: boolean;
  verified: boolean;
  suppressed?: boolean;
  remoteUpdatedAt?: string;
  source?: string;
  baseIsDefault?: boolean;
  automation?: Partial<IssueGitAutomationState>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

const LINKED_BY: readonly string[] = ["manual", "workspace_branch", "head_ref", "keyword", "bracket", "refs", "mention"];

function isLinkedBy(value: unknown): value is IssueGitLinkedBy {
  return typeof value === "string" && LINKED_BY.includes(value);
}

/** The git block this feature wrote into a work product, or null for a hand-attached one. */
function parseGitMeta(row: WorkProductRow | null): GitMeta | null {
  const raw = asRecord(asRecord(row?.metadata).git);
  const linkedBy = raw.linkedBy;
  if (!isLinkedBy(linkedBy)) return null;
  const automation = asRecord(raw.automation);
  return {
    linkedBy,
    closes: raw.closes === true,
    verified: raw.verified === true,
    ...(raw.suppressed === true ? { suppressed: true } : {}),
    ...(stringField(raw, "remoteUpdatedAt") ? { remoteUpdatedAt: stringField(raw, "remoteUpdatedAt")! } : {}),
    ...(stringField(raw, "source") ? { source: stringField(raw, "source")! } : {}),
    ...(typeof raw.baseIsDefault === "boolean" ? { baseIsDefault: raw.baseIsDefault } : {}),
    ...(Object.keys(automation).length > 0 ? { automation } : {}),
  };
}

/** Like `parseGitMeta`, but a hand-attached pull request counts as a trusted reference. */
function readGitMeta(row: WorkProductRow): GitMeta {
  return parseGitMeta(row) ?? { linkedBy: "manual", closes: false, verified: true };
}

function stateOfSignal(signal: PullRequestSignal): IssueGitPullRequestState {
  if (signal.merged) return "merged";
  if (signal.state === "closed") return "closed";
  return signal.draft ? "draft" : "open";
}

const WORK_PRODUCT_STATUS: Record<IssueGitPullRequestState, string> = {
  open: "active",
  draft: "draft",
  merged: "merged",
  closed: "closed",
};

function stateOfRow(row: WorkProductRow): IssueGitPullRequestState {
  const state = asRecord(row.metadata).state;
  if (state === "open" || state === "draft" || state === "merged" || state === "closed") return state;
  if (row.status === "merged" || row.status === "closed" || row.status === "draft") return row.status;
  return "open";
}

function repositoryOf(row: WorkProductRow): { repository: string; number: number } | null {
  const metadata = asRecord(row.metadata);
  const reference = extractGitHubPullRequestReferences([
    row.url,
    typeof metadata.repo === "string" && typeof metadata.number === "number" ? `${metadata.repo}#${metadata.number}` : null,
  ])[0];
  return reference ? { repository: `${reference.owner}/${reference.repo}`.toLowerCase(), number: reference.number } : null;
}

/** The advisory-lock key that serializes every writer of one pull request's links. */
export function gitLinkLockKey(companyId: string, externalId: string): string {
  return `git-link:${companyId}:${externalId}`;
}

function sameRepository(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && a!.toLowerCase() === b!.toLowerCase();
}

function repositoryFromUrl(value: string | null | undefined): string | null {
  const match = typeof value === "string" ? /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*?)(?:\.git)?(?:\/|$)/.exec(value) : null;
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

function matchesPullRequest(row: WorkProductRow, signal: PullRequestSignal, externalId: string): boolean {
  if (row.externalId && row.externalId.toLowerCase() === externalId) return true;
  const parsed = repositoryOf(row);
  return Boolean(parsed && parsed.repository === signal.repository.toLowerCase() && parsed.number === signal.number);
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export function issueGitLinkService(db: Db, options: IssueGitLinkServiceOptions = {}) {
  const issuesSvc = issueService(db);
  const instanceSettings = instanceSettingsService(db);
  const resolvePullRequestDetails = options.resolvePullRequestDetails ?? createPullRequestMergeDetailsResolver(db);
  const statusAutomationEnabled =
    options.statusAutomationEnabled ?? (async () => (await instanceSettings.getGeneral()).gitStatusAutomation === true);

  async function resolveTargets(companyId: string, signal: PullRequestSignal, externalId: string, opts: RecordSignalOptions) {
    const targets = new Map<string, Evidence | null>();
    const addEvidence = (issueId: string, evidence: Evidence) => {
      const current = targets.get(issueId);
      targets.set(issueId, current ? { linkedBy: current.linkedBy, closes: current.closes || evidence.closes } : evidence);
    };

    if (opts.manualIssueId) {
      const [issue] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, opts.manualIssueId), eq(issues.companyId, companyId)));
      if (!issue) throw notFound("Issue not found");
      addEvidence(issue.id, { linkedBy: "manual", closes: opts.closes ?? true });
    }

    if (signal.headRef) {
      const workspaces = await db
        .select({ sourceIssueId: executionWorkspaces.sourceIssueId, repoUrl: executionWorkspaces.repoUrl })
        .from(executionWorkspaces)
        .where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.branchName, signal.headRef)))
        .limit(5);
      for (const workspace of workspaces) {
        const workspaceRepository = repositoryFromUrl(workspace.repoUrl);
        if (!workspace.sourceIssueId) continue;
        if (workspaceRepository && !sameRepository(workspaceRepository, signal.repository)) continue;
        addEvidence(workspace.sourceIssueId, { linkedBy: "workspace_branch", closes: true });
      }
    }

    const [company] = await db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId));
    if (company) {
      const references = extractIssueGitReferences({
        prefix: company.prefix,
        headRef: signal.headRef,
        title: signal.title,
        body: signal.body,
      });
      if (references.length > 0) {
        const rows = await db
          .select({ id: issues.id, identifier: issues.identifier })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.identifier, references.map((r) => r.identifier))));
        const idByIdentifier = new Map(rows.map((row) => [row.identifier, row.id]));
        for (const reference of references) {
          const issueId = idByIdentifier.get(reference.identifier);
          if (issueId) addEvidence(issueId, { linkedBy: reference.via, closes: reference.closes });
        }
      }
    }

    const existing = await db
      .select()
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.type, "pull_request"),
        eq(issueWorkProducts.provider, "github"),
        or(
          eq(issueWorkProducts.externalId, externalId),
          sql`lower(${issueWorkProducts.url}) = ${signal.url.toLowerCase()}`,
          sql`(lower(${issueWorkProducts.metadata}->>'repo') = ${signal.repository} and ${issueWorkProducts.metadata}->>'number' = ${String(signal.number)})`,
        ),
      ));
    for (const row of existing) {
      if (matchesPullRequest(row, signal, externalId) && !targets.has(row.issueId)) targets.set(row.issueId, null);
    }
    return targets;
  }

  async function upsertLink(
    companyId: string,
    issue: Pick<IssueRow, "id" | "identifier" | "projectId">,
    signal: PullRequestSignal,
    externalId: string,
    evidence: Evidence | null,
    explicit: boolean,
  ): Promise<RecordedLink> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${gitLinkLockKey(companyId, externalId)}, 0))`);
      const rows = await tx
        .select()
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.issueId, issue.id),
          eq(issueWorkProducts.type, "pull_request"),
          eq(issueWorkProducts.provider, "github"),
        ));
      const existing = rows.find((row) => matchesPullRequest(row, signal, externalId)) ?? null;
      // Null for a new row and for a pull request an agent attached by hand.
      const previous = parseGitMeta(existing);
      const adoptedByHand = existing !== null && previous === null;

      if (!explicit && previous?.suppressed) {
        return { issueId: issue.id, identifier: issue.identifier, workProductId: existing!.id, created: false, changed: false, skipped: "suppressed" as const };
      }
      const incomingTime = parseTime(signal.updatedAt);
      const storedTime = parseTime(previous?.remoteUpdatedAt);
      if (!explicit && incomingTime !== null && storedTime !== null && incomingTime < storedTime) {
        return { issueId: issue.id, identifier: issue.identifier, workProductId: existing!.id, created: false, changed: false, skipped: "stale" as const };
      }

      const state = stateOfSignal(signal);
      const keepsManual = previous?.linkedBy === "manual" && !previous.suppressed && !explicit;
      const linkedBy: IssueGitLinkedBy = keepsManual ? "manual" : evidence ? evidence.linkedBy : previous?.linkedBy ?? "manual";
      const closes = keepsManual ? previous!.closes : evidence ? evidence.closes : previous?.closes ?? false;
      const verified =
        linkedBy === "manual" || linkedBy === "workspace_branch" || adoptedByHand
          ? true
          : signal.headRepository
            ? sameRepository(signal.headRepository, signal.repository)
            : previous?.verified ?? false;
      const baseRef = signal.baseRef ?? stringField(asRecord(existing?.metadata), "baseRef");
      const baseIsDefault = signal.baseRef
        ? signal.defaultBranch
          ? sameRepository(signal.baseRef, signal.defaultBranch)
          : FALLBACK_DEFAULT_BRANCHES.has(signal.baseRef.toLowerCase())
        : previous?.baseIsDefault ?? false;
      const remoteUpdatedAt = signal.updatedAt ?? previous?.remoteUpdatedAt;

      const git: GitMeta = {
        linkedBy,
        closes,
        verified,
        ...(remoteUpdatedAt ? { remoteUpdatedAt } : {}),
        source: signal.source,
        baseIsDefault,
        ...(previous?.automation ? { automation: previous.automation } : {}),
      };
      const metadata: Record<string, unknown> = {
        ...asRecord(existing?.metadata),
        repo: signal.repository.toLowerCase(),
        number: signal.number,
        ...(signal.headRef ? { headRef: signal.headRef } : {}),
        ...(baseRef ? { baseRef } : {}),
        state,
        draft: state === "draft",
        merged: state === "merged",
        git,
      };
      const title = signal.title?.trim() || existing?.title || `${signal.repository.toLowerCase()}#${signal.number}`;
      const status = WORK_PRODUCT_STATUS[state];

      if (existing) {
        const unchanged =
          existing.title === title &&
          existing.url === signal.url &&
          existing.status === status &&
          isDeepStrictEqual(existing.metadata, metadata);
        if (unchanged) {
          return { issueId: issue.id, identifier: issue.identifier, workProductId: existing.id, created: false, changed: false };
        }
        await tx
          .update(issueWorkProducts)
          .set({ title, url: signal.url, status, externalId: existing.externalId ?? externalId, metadata, updatedAt: new Date() })
          .where(and(eq(issueWorkProducts.id, existing.id), eq(issueWorkProducts.companyId, companyId)));
        return { issueId: issue.id, identifier: issue.identifier, workProductId: existing.id, created: false, changed: true };
      }

      const [created] = await tx
        .insert(issueWorkProducts)
        .values({
          companyId,
          projectId: issue.projectId,
          issueId: issue.id,
          type: "pull_request",
          provider: "github",
          externalId,
          title,
          url: signal.url,
          status,
          reviewState: "none",
          isPrimary: false,
          healthStatus: "unknown",
          metadata,
        })
        .returning({ id: issueWorkProducts.id });
      return { issueId: issue.id, identifier: issue.identifier, workProductId: created!.id, created: true, changed: true };
    });
  }

  async function writeAutomationState(
    tx: Db,
    companyId: string,
    rows: WorkProductRow[],
    patch: Partial<IssueGitAutomationState>,
  ) {
    for (const row of rows) {
      const git = readGitMeta(row);
      const next = { ...git, automation: { ...git.automation, ...patch } };
      if (isDeepStrictEqual(git.automation ?? {}, next.automation)) continue;
      await tx
        .update(issueWorkProducts)
        .set({ metadata: { ...asRecord(row.metadata), git: next } })
        .where(and(eq(issueWorkProducts.id, row.id), eq(issueWorkProducts.companyId, companyId)));
    }
  }

  async function evaluateAutomation(companyId: string, issueId: string, enabled: boolean): Promise<RecordedAutomation> {
    const publications: ActivityPublication[] = [];
    const actions: IssuePostCommitAction[] = [];
    const result = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [issue] = await tx
        .select()
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .for("update");
      const report = (applied: RecordedAutomation["applied"], deferred: string | null): RecordedAutomation => ({ issueId, applied, deferred });
      if (!issue) return report(null, null);

      const products = (
        await tx
          .select()
          .from(issueWorkProducts)
          .where(and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.issueId, issueId),
            eq(issueWorkProducts.type, "pull_request"),
            eq(issueWorkProducts.provider, "github"),
          ))
      ).filter((row) => readGitMeta(row).suppressed !== true);
      if (products.length === 0) return report(null, null);

      const defer = async (code: string, persist = true) => {
        if (persist) await writeAutomationState(tx, companyId, products, { deferred: code });
        return report(null, code);
      };
      if (!enabled) return defer("disabled");
      const verified = products.filter((row) => readGitMeta(row).verified);
      if (verified.length === 0) return defer("unverified");
      const closing = verified.filter((row) => readGitMeta(row).closes);
      if (closing.length === 0) return defer("refs_only");

      const status = issue.status;
      const ineligible =
        issue.hiddenAt !== null ||
        issue.conversationAgentId !== null ||
        status === "done" ||
        status === "cancelled" ||
        status === "blocked" ||
        !AUTOMATABLE_ORIGINS.has(issue.originKind) ||
        (!issue.assigneeAgentId && !issue.assigneeUserId);
      if (ineligible) return defer("ineligible");
      if (issue.executionPolicy !== null || issue.executionState !== null || (issue.reviewPolicy && issue.reviewPolicy !== "anyone")) {
        return defer("gated");
      }
      if (issue.executionRunId || issue.checkoutRunId) return defer("active_run");
      const [confirmation] = await tx
        .select({ id: issueThreadInteractions.id })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .limit(1);
      if (confirmation) return defer("pending_confirmation");

      const appliedRecords = products
        .map((row) => readGitMeta(row).automation)
        .filter((record): record is Partial<IssueGitAutomationState> => Boolean(record?.applied || record?.suspended));
      if (appliedRecords.some((record) => record.suspended)) return defer("manual_change", false);
      const lastApplied = appliedRecords
        .map((record) => record.applied)
        .filter((entry): entry is NonNullable<IssueGitAutomationState["applied"]> => Boolean(entry))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
      if (lastApplied && lastApplied.to !== status) {
        await writeAutomationState(tx, companyId, products, { deferred: "manual_change", suspended: "manual_change" });
        return report(null, "manual_change");
      }

      const states = closing.map((row) => ({ state: stateOfRow(row), baseIsDefault: readGitMeta(row).baseIsDefault === true }));
      const anyOpen = states.some((entry) => entry.state === "open");
      const anyDraft = states.some((entry) => entry.state === "draft");
      const mergedToDefault = states.some((entry) => entry.state === "merged" && entry.baseIsDefault);
      const anyMerged = states.some((entry) => entry.state === "merged");
      const allClosedUnmerged = states.every((entry) => entry.state === "closed");

      let target: string | null = null;
      if (anyOpen) target = status === "backlog" || status === "todo" || status === "in_progress" ? "in_review" : null;
      else if (anyDraft) target = status === "backlog" || status === "todo" ? "in_progress" : null;
      else if (mergedToDefault) target = "done";
      else if (allClosedUnmerged && lastApplied && lastApplied.to === status && !anyMerged) target = lastApplied.from;
      if (!target || target === status) {
        await writeAutomationState(tx, companyId, products, { deferred: null });
        return report(null, null);
      }

      const updated = await issuesSvc.update(issueId, { status: target, companyGuard: companyId }, tx, publications, actions);
      if (!updated) return report(null, null);
      const appliedAt = new Date().toISOString();
      await writeAutomationState(tx, companyId, products, { applied: { from: status, to: target, at: appliedAt }, deferred: null, suspended: null });
      await logActivity(
        tx,
        {
          companyId,
          actorType: "system",
          actorId: AUTOMATION_ACTOR_ID,
          action: "issue.git_status_automated",
          entityType: "issue",
          entityId: issueId,
          issueId,
          details: {
            identifier: issue.identifier,
            status: target,
            _previous: { status },
            pullRequests: closing.map((row) => ({ url: row.url, state: stateOfRow(row) })),
          },
        },
        publications,
      );
      return report({ from: status, to: target }, null);
    });
    for (const publication of publications) publishActivity(publication);
    await executeIssuePostCommitActions(db, actions);
    return result;
  }

  async function recordPullRequestSignal(
    companyId: string,
    rawSignal: PullRequestSignal,
    opts: RecordSignalOptions = {},
  ): Promise<RecordSignalResult> {
    const signal: PullRequestSignal = { ...rawSignal, repository: rawSignal.repository.toLowerCase() };
    const externalId = `${signal.repository}#pull/${signal.number}`;
    const targets = await resolveTargets(companyId, signal, externalId, opts);
    if (targets.size === 0) return { links: [], automation: [] };

    let effective = signal;
    const enrich = options.enrich;
    const untrustedTarget = [...targets.values()].some((e) => !e || (e.linkedBy !== "manual" && e.linkedBy !== "workspace_branch"));
    if (enrich && !signal.headRepository && untrustedTarget) {
      try {
        const extra = await enrich(companyId, signal);
        if (extra) {
          effective = {
            ...signal,
            headRepository: signal.headRepository ?? extra.headRepository ?? null,
            defaultBranch: signal.defaultBranch ?? extra.defaultBranch ?? null,
            title: signal.title ?? extra.title ?? null,
            draft: signal.draft ?? extra.draft ?? false,
          };
        }
      } catch {
        effective = signal;
      }
    }

    const targetIds = [...targets.keys()].slice(0, MAX_TARGETS);
    const rows = await db
      .select({ id: issues.id, identifier: issues.identifier, projectId: issues.projectId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, targetIds)));

    const links: RecordedLink[] = [];
    for (const issue of rows) {
      links.push(await upsertLink(companyId, issue, effective, externalId, targets.get(issue.id) ?? null, opts.manualIssueId !== undefined));
    }

    const enabled = await statusAutomationEnabled();
    const automation: RecordedAutomation[] = [];
    for (const link of links) {
      if (link.skipped) continue;
      automation.push(await evaluateAutomation(companyId, link.issueId, enabled));
    }
    return { links, automation };
  }

  async function getView(issueId: string, companyId: string): Promise<IssueGitView> {
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    if (!issue) throw notFound("Issue not found");
    const [project] = issue.projectId
      ? await db.select({ policy: projects.executionWorkspacePolicy }).from(projects).where(and(eq(projects.id, issue.projectId), eq(projects.companyId, companyId)))
      : [];
    const branch = buildIssueBranchName({
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title, executionWorkspaceSettings: issue.executionWorkspaceSettings },
      projectPolicy: project?.policy ?? null,
      projectId: issue.projectId,
    });
    const products = await db
      .select()
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.issueId, issueId),
        eq(issueWorkProducts.type, "pull_request"),
        eq(issueWorkProducts.provider, "github"),
      ));
    const pullRequests: IssueGitPullRequest[] = [];
    for (const row of products) {
      const git = readGitMeta(row);
      const parsed = repositoryOf(row);
      if (git.suppressed || !parsed) continue;
      const metadata = asRecord(row.metadata);
      pullRequests.push({
        workProductId: row.id,
        provider: "github",
        repository: parsed.repository,
        number: parsed.number,
        url: row.url,
        title: row.title,
        state: stateOfRow(row),
        headRef: typeof metadata.headRef === "string" ? metadata.headRef : null,
        baseRef: typeof metadata.baseRef === "string" ? metadata.baseRef : null,
        closes: git.closes,
        verified: git.verified,
        linkedBy: git.linkedBy,
        automation: {
          applied: git.automation?.applied ?? null,
          deferred: git.automation?.deferred ?? null,
          suspended: git.automation?.suspended ?? null,
        },
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    return {
      issueId: issue.id,
      identifier: issue.identifier,
      branch: {
        name: branch.name,
        command: branch.source === "existing_branch" ? `git switch ${branch.name}` : `git switch -c ${branch.name}`,
        template: branch.template,
        source: branch.source,
      },
      pullRequests,
      statusAutomation: { enabled: await statusAutomationEnabled() },
    };
  }

  async function unlinkPullRequest(issueId: string, companyId: string, workProductId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.id, workProductId),
          eq(issueWorkProducts.issueId, issueId),
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.type, "pull_request"),
        ))
        .for("update");
      if (!row) return false;
      const git = readGitMeta(row);
      await tx
        .update(issueWorkProducts)
        .set({ status: "archived", metadata: { ...asRecord(row.metadata), git: { ...git, suppressed: true } }, updatedAt: new Date() })
        .where(and(eq(issueWorkProducts.id, row.id), eq(issueWorkProducts.companyId, companyId)));
      return true;
    });
  }

  async function linkPullRequest(
    issueId: string,
    companyId: string,
    input: { repository: string; number: number; closes?: boolean },
    source: "manual" | "agent",
  ): Promise<RecordSignalResult> {
    const repository = input.repository.toLowerCase();
    const [owner, repo] = repository.split("/");
    const details = await resolvePullRequestDetails(companyId, { host: "github.com", owner: owner!, repo: repo!, number: input.number });
    const state = details.workProductState;
    const signal: PullRequestSignal = {
      provider: "github",
      repository,
      number: input.number,
      url: `https://github.com/${repository}/pull/${input.number}`,
      headRef: details.headRef,
      baseRef: details.baseRef ?? null,
      state: state === "merged" || state === "closed" ? "closed" : "open",
      merged: state === "merged",
      draft: state === "draft" || details.draft === true,
      updatedAt: new Date().toISOString(),
      source,
    };
    return recordPullRequestSignal(companyId, signal, { manualIssueId: issueId, closes: input.closes });
  }

  return { recordPullRequestSignal, getView, unlinkPullRequest, linkPullRequest };
}
