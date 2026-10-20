import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  personalAgentInstructionRevisions,
  personalAgents,
  personalAgentSkills,
  userAuditLog,
} from "@paperclipai/db";
import {
  PERSONAL_AGENT_DEFAULT_NAME,
  PERSONAL_AGENT_MAX_SKILLS,
  PERSONAL_AGENT_SKILL_MARKDOWN_MAX_CHARS,
  defaultPersonalAgentToolPolicy,
  getPersonalAgentTool,
  personalAgentToolPolicySchema,
  type CreatePersonalAgentSkill,
  type PersonalAgent,
  type PersonalAgentAuditAction,
  type PersonalAgentInstructionRevision,
  type PersonalAgentInstructionRevisionSummary,
  type PersonalAgentSkill,
  type PersonalAgentSkillSource,
  type PersonalAgentToolPolicy,
  type PutPersonalAgentInstructions,
  type UpdatePersonalAgent,
  type UpdatePersonalAgentSkill,
  type UserAuditEntry,
} from "@paperclipai/shared";
import { isUniqueViolation } from "../db-errors.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { getCatalogSkillOrThrow, readCatalogSkillFile } from "./skills-catalog.js";

/** Who made a change, recorded on every audit row. */
export interface PersonalAgentActor {
  source: string;
  keyId: string | null;
}

type AgentRow = typeof personalAgents.$inferSelect;
type SkillRow = typeof personalAgentSkills.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const SKILL_KEY_MAX_CHARS = 64;

const DENY_ALL_POLICY: PersonalAgentToolPolicy = { enabledTools: [], companyDefault: "deny", companies: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function knownToolNames(names: unknown): unknown {
  return Array.isArray(names) ? names.filter((name) => typeof name === "string" && getPersonalAgentTool(name)) : names;
}

/**
 * Read a stored tool policy. Tool names the catalog no longer knows are
 * dropped, which only removes permissions. Anything still invalid fails
 * closed to a policy that allows nothing.
 */
function readToolPolicy(value: unknown): PersonalAgentToolPolicy {
  const direct = personalAgentToolPolicySchema.safeParse(value);
  if (direct.success) return direct.data;
  if (!isRecord(value)) return DENY_ALL_POLICY;
  const companies = Array.isArray(value.companies)
    ? value.companies.map((entry) =>
        isRecord(entry) && entry.tools !== null ? { ...entry, tools: knownToolNames(entry.tools) } : entry,
      )
    : value.companies;
  const filtered = personalAgentToolPolicySchema.safeParse({
    ...value,
    enabledTools: knownToolNames(value.enabledTools),
    companies,
  });
  return filtered.success ? filtered.data : DENY_ALL_POLICY;
}

function definedFields(input: object): string[] {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

function toAgent(row: AgentRow): PersonalAgent {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    instructionsRevision: row.instructionsRevision,
    toolPolicy: readToolPolicy(row.toolPolicy),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSkill(row: SkillRow): PersonalAgentSkill {
  const source: PersonalAgentSkillSource = row.source === "catalog" ? "catalog" : "custom";
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    markdown: row.markdown,
    source,
    catalogKey: row.catalogKey,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Turn a skill name into the key the agent uses to load it.
 *
 * @param name - Display name or catalog slug.
 * @returns A lowercase slug, or a random key when the name has no ASCII letters or digits.
 */
export function personalAgentSkillKey(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_KEY_MAX_CHARS)
    .replace(/-+$/g, "");
  return slug || `skill-${randomBytes(3).toString("hex")}`;
}

async function writeAudit(
  tx: Tx | Db,
  userId: string,
  action: PersonalAgentAuditAction,
  actor: PersonalAgentActor,
  details: Record<string, unknown>,
): Promise<void> {
  await tx.insert(userAuditLog).values({
    userId,
    action,
    actorSource: actor.source,
    actorKeyId: actor.keyId,
    details,
  });
}

/**
 * Service for the user-scoped personal agent and its configuration.
 * Every method takes the acting user's id; rows of other users are never
 * read or written, and a foreign id answers 404 like a missing one.
 */
export function personalAgentService(db: Db) {
  async function ensure(userId: string, actor: PersonalAgentActor): Promise<AgentRow> {
    return db.transaction(async (tx) => {
      const [created] = await tx
        .insert(personalAgents)
        .values({ userId, name: PERSONAL_AGENT_DEFAULT_NAME, toolPolicy: defaultPersonalAgentToolPolicy() })
        .onConflictDoNothing({ target: personalAgents.userId })
        .returning();
      if (created) {
        await writeAudit(tx, userId, "personal_agent.created", actor, { personalAgentId: created.id });
        return created;
      }
      const [existing] = await tx.select().from(personalAgents).where(eq(personalAgents.userId, userId));
      if (!existing) throw conflict("Personal agent could not be created; retry");
      return existing;
    });
  }

  async function lockAgent(tx: Tx, userId: string): Promise<AgentRow> {
    const [row] = await tx.select().from(personalAgents).where(eq(personalAgents.userId, userId)).for("update");
    if (!row) throw notFound("Personal agent not found");
    return row;
  }

  async function findSkill(tx: Tx | Db, agentId: string, skillId: string): Promise<SkillRow> {
    const [row] = await tx
      .select()
      .from(personalAgentSkills)
      .where(and(eq(personalAgentSkills.id, skillId), eq(personalAgentSkills.personalAgentId, agentId)));
    if (!row) throw notFound("Skill not found");
    return row;
  }

  async function catalogSkillInput(catalogRef: string) {
    const skill = getCatalogSkillOrThrow(catalogRef);
    if (skill.trustLevel !== "markdown_only" || skill.compatibility === "invalid") {
      throw unprocessable("Only markdown-only catalog skills can be added to the personal agent");
    }
    const file = await readCatalogSkillFile(skill.key, "SKILL.md");
    if (file.content.length > PERSONAL_AGENT_SKILL_MARKDOWN_MAX_CHARS) {
      throw unprocessable("This catalog skill is too large for the personal agent");
    }
    return {
      key: personalAgentSkillKey(skill.slug),
      name: skill.name,
      description: skill.description,
      markdown: file.content,
      catalogKey: skill.key,
    };
  }

  return {
    /** Get the user's personal agent, creating it with defaults on first use. */
    async get(userId: string, actor: PersonalAgentActor): Promise<PersonalAgent> {
      return toAgent(await ensure(userId, actor));
    },

    /** Update the name and/or the tool policy. */
    async update(userId: string, input: UpdatePersonalAgent, actor: PersonalAgentActor): Promise<PersonalAgent> {
      await ensure(userId, actor);
      return db.transaction(async (tx) => {
        await lockAgent(tx, userId);
        const [row] = await tx
          .update(personalAgents)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.toolPolicy !== undefined ? { toolPolicy: input.toolPolicy } : {}),
            updatedAt: new Date(),
          })
          .where(eq(personalAgents.userId, userId))
          .returning();
        if (!row) throw notFound("Personal agent not found");
        await writeAudit(tx, userId, "personal_agent.updated", actor, {
          fields: definedFields(input),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.toolPolicy !== undefined ? { toolPolicy: input.toolPolicy } : {}),
        });
        return toAgent(row);
      });
    },

    /** Save new instructions as the next revision. A stale `baseRevision` answers 409. */
    async putInstructions(
      userId: string,
      input: PutPersonalAgentInstructions,
      actor: PersonalAgentActor,
    ): Promise<PersonalAgent> {
      await ensure(userId, actor);
      return db.transaction(async (tx) => {
        const current = await lockAgent(tx, userId);
        if (input.baseRevision !== undefined && input.baseRevision !== current.instructionsRevision) {
          throw conflict("Instructions changed since you loaded them; reload and retry", {
            currentRevision: current.instructionsRevision,
          });
        }
        const revision = current.instructionsRevision + 1;
        const changeSummary = input.changeSummary ? input.changeSummary : null;
        await tx.insert(personalAgentInstructionRevisions).values({
          personalAgentId: current.id,
          userId,
          revision,
          body: input.body,
          changeSummary,
        });
        const [row] = await tx
          .update(personalAgents)
          .set({ instructions: input.body, instructionsRevision: revision, updatedAt: new Date() })
          .where(eq(personalAgents.id, current.id))
          .returning();
        if (!row) throw notFound("Personal agent not found");
        await writeAudit(tx, userId, "personal_agent.instructions_updated", actor, {
          revision,
          bodyLength: input.body.length,
          changeSummary,
        });
        return toAgent(row);
      });
    },

    /** List saved instruction revisions, newest first, without their bodies. */
    async listInstructionRevisions(
      userId: string,
      actor: PersonalAgentActor,
    ): Promise<PersonalAgentInstructionRevisionSummary[]> {
      const agent = await ensure(userId, actor);
      const rows = await db
        .select({
          id: personalAgentInstructionRevisions.id,
          revision: personalAgentInstructionRevisions.revision,
          changeSummary: personalAgentInstructionRevisions.changeSummary,
          bodyLength: sql<number>`char_length(${personalAgentInstructionRevisions.body})`,
          createdAt: personalAgentInstructionRevisions.createdAt,
        })
        .from(personalAgentInstructionRevisions)
        .where(eq(personalAgentInstructionRevisions.personalAgentId, agent.id))
        .orderBy(desc(personalAgentInstructionRevisions.revision));
      return rows.map((row) => ({ ...row, bodyLength: Number(row.bodyLength), createdAt: row.createdAt.toISOString() }));
    },

    /** Get one saved instruction revision by its number. */
    async getInstructionRevision(
      userId: string,
      revision: number,
      actor: PersonalAgentActor,
    ): Promise<PersonalAgentInstructionRevision> {
      const agent = await ensure(userId, actor);
      const [row] = await db
        .select()
        .from(personalAgentInstructionRevisions)
        .where(
          and(
            eq(personalAgentInstructionRevisions.personalAgentId, agent.id),
            eq(personalAgentInstructionRevisions.revision, revision),
          ),
        );
      if (!row) throw notFound("Revision not found");
      return {
        id: row.id,
        revision: row.revision,
        changeSummary: row.changeSummary,
        bodyLength: row.body.length,
        body: row.body,
        createdAt: row.createdAt.toISOString(),
      };
    },

    /** List the personal agent's skills by name. */
    async listSkills(userId: string, actor: PersonalAgentActor): Promise<PersonalAgentSkill[]> {
      const agent = await ensure(userId, actor);
      const rows = await db
        .select()
        .from(personalAgentSkills)
        .where(eq(personalAgentSkills.personalAgentId, agent.id))
        .orderBy(asc(personalAgentSkills.name), asc(personalAgentSkills.key));
      return rows.map(toSkill);
    },

    /** Get one of the personal agent's skills. */
    async getSkill(userId: string, skillId: string, actor: PersonalAgentActor): Promise<PersonalAgentSkill> {
      const agent = await ensure(userId, actor);
      return toSkill(await findSkill(db, agent.id, skillId));
    },

    /** Add a custom skill, or copy a markdown-only skill from the app catalog. */
    async createSkill(
      userId: string,
      input: CreatePersonalAgentSkill,
      actor: PersonalAgentActor,
    ): Promise<PersonalAgentSkill> {
      await ensure(userId, actor);
      const values =
        input.source === "catalog"
          ? await catalogSkillInput(input.catalogRef)
          : {
              key: personalAgentSkillKey(input.name),
              name: input.name,
              description: input.description,
              markdown: input.markdown,
              catalogKey: null,
            };
      try {
        return await db.transaction(async (tx) => {
          const agent = await lockAgent(tx, userId);
          const [count] = await tx
            .select({ value: sql<number>`count(*)` })
            .from(personalAgentSkills)
            .where(eq(personalAgentSkills.personalAgentId, agent.id));
          if (Number(count?.value ?? 0) >= PERSONAL_AGENT_MAX_SKILLS) {
            throw unprocessable(`A personal agent can have at most ${PERSONAL_AGENT_MAX_SKILLS} skills`);
          }
          const [row] = await tx
            .insert(personalAgentSkills)
            .values({ ...values, personalAgentId: agent.id, userId, source: input.source, enabled: input.enabled })
            .returning();
          if (!row) throw conflict("Skill could not be created; retry");
          await writeAudit(tx, userId, "personal_agent.skill_created", actor, {
            skillId: row.id,
            key: row.key,
            source: row.source,
            catalogKey: row.catalogKey,
            enabled: row.enabled,
          });
          return toSkill(row);
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("A skill with this key already exists; rename it", { key: values.key });
        throw error;
      }
    },

    /** Edit a skill. The key stays stable so the agent keeps finding it. */
    async updateSkill(
      userId: string,
      skillId: string,
      input: UpdatePersonalAgentSkill,
      actor: PersonalAgentActor,
    ): Promise<PersonalAgentSkill> {
      await ensure(userId, actor);
      return db.transaction(async (tx) => {
        const agent = await lockAgent(tx, userId);
        await findSkill(tx, agent.id, skillId);
        const [row] = await tx
          .update(personalAgentSkills)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.markdown !== undefined ? { markdown: input.markdown } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(personalAgentSkills.id, skillId), eq(personalAgentSkills.personalAgentId, agent.id)))
          .returning();
        if (!row) throw notFound("Skill not found");
        await writeAudit(tx, userId, "personal_agent.skill_updated", actor, {
          skillId: row.id,
          key: row.key,
          fields: definedFields(input),
          enabled: row.enabled,
        });
        return toSkill(row);
      });
    },

    /** Remove a skill from the personal agent. */
    async deleteSkill(userId: string, skillId: string, actor: PersonalAgentActor): Promise<void> {
      await ensure(userId, actor);
      await db.transaction(async (tx) => {
        const agent = await lockAgent(tx, userId);
        const skill = await findSkill(tx, agent.id, skillId);
        await tx
          .delete(personalAgentSkills)
          .where(and(eq(personalAgentSkills.id, skillId), eq(personalAgentSkills.personalAgentId, agent.id)));
        await writeAudit(tx, userId, "personal_agent.skill_deleted", actor, {
          skillId: skill.id,
          key: skill.key,
          source: skill.source,
          catalogKey: skill.catalogKey,
        });
      });
    },

    /** Read the user's own audit log, newest first. */
    async listAudit(userId: string, limit: number): Promise<UserAuditEntry[]> {
      const rows = await db
        .select()
        .from(userAuditLog)
        .where(eq(userAuditLog.userId, userId))
        .orderBy(desc(userAuditLog.createdAt), desc(userAuditLog.id))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        action: row.action,
        actorSource: row.actorSource,
        companyId: row.companyId,
        details: row.details ?? null,
        createdAt: row.createdAt.toISOString(),
      }));
    },
  };
}
