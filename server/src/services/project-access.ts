import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, authUsers, companyMemberships, projectPrincipalAccess, projects } from "@paperclipai/db";
import type {
  PrincipalType,
  ProjectAccessEnforcementLevel,
  ProjectAccessMode,
  ProjectAccessPrincipal,
  ProjectAccessSource,
  ProjectAccessSummary,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

const COMPANY_ADMIN_ROLES = new Set(["owner", "admin"]);

/**
 * Server enforcement level for project access, from `PAPERCLIP_PROJECT_ACCESS_MODE`.
 * Only `shadow` is recognised today; every other value (including unset) is `off`.
 * Enforcement ships later together with list filtering and runtime dispatch, so
 * a half-enforced boundary never reaches an instance.
 */
export function projectAccessEnforcementLevel(): ProjectAccessEnforcementLevel {
  const mode = process.env.PAPERCLIP_PROJECT_ACCESS_MODE?.trim().toLowerCase();
  return mode === "shadow" ? "shadow" : "off";
}

export type ProjectAccessActor = {
  type: "board" | "agent" | "none";
  userId?: string | null;
  agentId?: string | null;
  source?: string;
  isInstanceAdmin?: boolean;
  ignoreInstanceAdmin?: boolean;
  memberships?: Array<{ companyId: string; membershipRole?: string | null; status?: string }>;
};

/**
 * Access a principal has to a restricted project without being on its list:
 * the local operator, instance admins, company owners/admins, the lead agent,
 * and the current assignee of the issue being acted on.
 */
export function hasImplicitRestrictedProjectAccess(input: {
  actor: ProjectAccessActor;
  project: { companyId: string; leadAgentId: string | null };
  issue?: { assigneeAgentId: string | null; assigneeUserId: string | null } | null;
}): boolean {
  const { actor, project, issue } = input;
  if (actor.type === "board") {
    if (actor.source === "local_implicit") return true;
    if (actor.isInstanceAdmin && !actor.ignoreInstanceAdmin && actor.source !== "cloud_tenant") return true;
    const membership = actor.memberships?.find(
      (item) => item.companyId === project.companyId && item.status === "active",
    );
    if (membership && COMPANY_ADMIN_ROLES.has(String(membership.membershipRole))) return true;
    return Boolean(actor.userId && issue?.assigneeUserId === actor.userId);
  }
  if (actor.type === "agent" && actor.agentId) {
    if (project.leadAgentId === actor.agentId) return true;
    return issue?.assigneeAgentId === actor.agentId;
  }
  return false;
}

function actorPrincipal(actor: ProjectAccessActor): { principalType: PrincipalType; principalId: string } | null {
  if (actor.type === "board" && actor.userId) return { principalType: "user", principalId: actor.userId };
  if (actor.type === "agent" && actor.agentId) return { principalType: "agent", principalId: actor.agentId };
  return null;
}

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

type ProjectRef = { id: string; companyId: string; leadAgentId: string | null; accessMode: string };

export function projectAccessService(db: DbOrTransaction) {
  async function hasExplicitAccess(projectId: string, principalType: PrincipalType, principalId: string) {
    const row = await db
      .select({ id: projectPrincipalAccess.id })
      .from(projectPrincipalAccess)
      .where(
        and(
          eq(projectPrincipalAccess.projectId, projectId),
          eq(projectPrincipalAccess.principalType, principalType),
          eq(projectPrincipalAccess.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return row !== null;
  }

  /** Whether an actor can reach a restricted project (implicit access or the access list). */
  async function actorCanReachRestrictedProject(input: {
    actor: ProjectAccessActor;
    project: ProjectRef;
    issue?: { assigneeAgentId: string | null; assigneeUserId: string | null } | null;
  }): Promise<boolean> {
    if (hasImplicitRestrictedProjectAccess(input)) return true;
    const principal = actorPrincipal(input.actor);
    if (!principal) return false;
    return hasExplicitAccess(input.project.id, principal.principalType, principal.principalId);
  }

  async function assertPrincipalInCompany(companyId: string, principalType: PrincipalType, principalId: string) {
    if (principalType === "user") {
      const membership = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, principalId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!membership) throw unprocessable("User is not an active member of this company");
      return;
    }
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, principalId), eq(agents.companyId, companyId), ne(agents.status, "terminated")))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw unprocessable("Agent does not belong to this company or is terminated");
  }

  async function grant(
    project: ProjectRef,
    input: { principalType: PrincipalType; principalId: string },
    grantedByUserId: string | null,
  ) {
    await assertPrincipalInCompany(project.companyId, input.principalType, input.principalId);
    const inserted = await db
      .insert(projectPrincipalAccess)
      .values({
        companyId: project.companyId,
        projectId: project.id,
        principalType: input.principalType,
        principalId: input.principalId,
        grantedByUserId,
      })
      .onConflictDoNothing({
        target: [projectPrincipalAccess.projectId, projectPrincipalAccess.principalType, projectPrincipalAccess.principalId],
      })
      .returning({ id: projectPrincipalAccess.id });
    return { created: inserted.length > 0 };
  }

  async function revoke(project: ProjectRef, principalType: PrincipalType, principalId: string) {
    const deleted = await db
      .delete(projectPrincipalAccess)
      .where(
        and(
          eq(projectPrincipalAccess.projectId, project.id),
          eq(projectPrincipalAccess.principalType, principalType),
          eq(projectPrincipalAccess.principalId, principalId),
        ),
      )
      .returning({ id: projectPrincipalAccess.id });
    return { removed: deleted.length > 0 };
  }

  async function setMode(project: ProjectRef, accessMode: ProjectAccessMode) {
    await db
      .update(projects)
      .set({ accessMode, updatedAt: new Date() })
      .where(eq(projects.id, project.id));
    return { changed: project.accessMode !== accessMode };
  }

  /**
   * Every user and agent that can reach the project, with each reason.
   * Only active members and non-terminated agents are listed; stale access-list
   * rows for removed principals grant nothing and are omitted.
   */
  async function summary(project: ProjectRef): Promise<ProjectAccessSummary> {
    const accessMode: ProjectAccessMode = project.accessMode === "restricted" ? "restricted" : "company";
    const [members, companyAgents, explicitRows] = await Promise.all([
      db
        .select({
          userId: companyMemberships.principalId,
          role: companyMemberships.membershipRole,
          name: authUsers.name,
        })
        .from(companyMemberships)
        .leftJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
        .where(
          and(
            eq(companyMemberships.companyId, project.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
          ),
        ),
      db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, project.companyId), ne(agents.status, "terminated")))
        .orderBy(asc(agents.name)),
      db
        .select()
        .from(projectPrincipalAccess)
        .where(eq(projectPrincipalAccess.projectId, project.id)),
    ]);

    const explicit = new Map(explicitRows.map((row) => [`${row.principalType}:${row.principalId}`, row.createdAt]));
    const principals: ProjectAccessPrincipal[] = [];

    function add(principalType: PrincipalType, principalId: string, name: string, implicit: ProjectAccessSource[]) {
      const grantedAt = explicit.get(`${principalType}:${principalId}`) ?? null;
      const sources: ProjectAccessSource[] = [...implicit];
      if (grantedAt) sources.push("explicit");
      if (accessMode === "company") sources.unshift("company_mode");
      if (sources.length === 0) return;
      principals.push({ principalType, principalId, name, sources, grantedAt });
    }

    for (const member of members) {
      add("user", member.userId, member.name ?? member.userId, COMPANY_ADMIN_ROLES.has(String(member.role)) ? ["company_admin"] : []);
    }
    for (const agent of companyAgents) {
      add("agent", agent.id, agent.name, agent.id === project.leadAgentId ? ["lead_agent"] : []);
    }

    return { projectId: project.id, accessMode, enforcement: projectAccessEnforcementLevel(), principals };
  }

  return {
    actorCanReachRestrictedProject,
    hasExplicitAccess,
    grant,
    revoke,
    setMode,
    summary,
  };
}
