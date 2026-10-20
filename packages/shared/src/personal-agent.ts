import { z } from "zod";

/**
 * The personal agent: one user-scoped agent per signed-in user, configured
 * like a company agent (instructions, skills, tool policy) and acting as that
 * user across every company the user can access.
 */

/** Risk label of a personal-agent tool. `critical` calls wait for a tap in a UI session. */
export const PERSONAL_AGENT_TOOL_RISKS = ["read", "write", "critical"] as const;
export type PersonalAgentToolRisk = (typeof PERSONAL_AGENT_TOOL_RISKS)[number];

/** Whether a tool targets one company or the user's whole account. */
export const PERSONAL_AGENT_TOOL_SCOPES = ["account", "company"] as const;
export type PersonalAgentToolScope = (typeof PERSONAL_AGENT_TOOL_SCOPES)[number];

/** Catalog entry for a tool the personal agent can be allowed to call. */
export const personalAgentToolDefinitionSchema = z.object({
  name: z.string(),
  risk: z.enum(PERSONAL_AGENT_TOOL_RISKS),
  scope: z.enum(PERSONAL_AGENT_TOOL_SCOPES),
  description: z.string(),
});
export type PersonalAgentToolDefinition = z.infer<typeof personalAgentToolDefinitionSchema>;

/** Every tool a personal-agent tool policy may name. */
export const PERSONAL_AGENT_TOOLS = [
  { name: "list_companies", risk: "read", scope: "account", description: "List the companies you can access." },
  { name: "company_dashboard", risk: "read", scope: "company", description: "Read a company's dashboard summary." },
  { name: "list_issues", risk: "read", scope: "company", description: "List or search a company's tasks." },
  { name: "get_issue", risk: "read", scope: "company", description: "Read one task." },
  { name: "list_issue_comments", risk: "read", scope: "company", description: "Read a task's comments." },
  { name: "list_agents", risk: "read", scope: "company", description: "List a company's agents." },
  { name: "list_runs", risk: "read", scope: "company", description: "List a company's recent agent runs." },
  { name: "cost_summary", risk: "read", scope: "company", description: "Read a company's cost summary." },
  { name: "list_routines", risk: "read", scope: "company", description: "List a company's routines." },
  { name: "list_approvals", risk: "read", scope: "company", description: "List a company's approvals." },
] as const satisfies readonly PersonalAgentToolDefinition[];

export type PersonalAgentToolName = (typeof PERSONAL_AGENT_TOOLS)[number]["name"];

const TOOLS_BY_NAME: ReadonlyMap<string, PersonalAgentToolDefinition> = new Map(
  PERSONAL_AGENT_TOOLS.map((tool) => [tool.name, tool]),
);

/**
 * Look up a tool definition by name.
 *
 * @param name - Tool name.
 * @returns The definition, or null when the name is not in the catalog.
 */
export function getPersonalAgentTool(name: string): PersonalAgentToolDefinition | null {
  return TOOLS_BY_NAME.get(name) ?? null;
}

export const PERSONAL_AGENT_NAME_MAX_CHARS = 80;
export const PERSONAL_AGENT_INSTRUCTIONS_MAX_CHARS = 32_000;
export const PERSONAL_AGENT_CHANGE_SUMMARY_MAX_CHARS = 200;
export const PERSONAL_AGENT_MAX_SKILLS = 50;
export const PERSONAL_AGENT_SKILL_MARKDOWN_MAX_CHARS = 64_000;
export const PERSONAL_AGENT_SKILL_DESCRIPTION_MAX_CHARS = 500;
export const PERSONAL_AGENT_MAX_COMPANY_POLICIES = 500;
export const PERSONAL_AGENT_DEFAULT_NAME = "Personal agent";

export const personalAgentToolNameSchema = z
  .string()
  .refine((name) => TOOLS_BY_NAME.has(name), { message: "Unknown personal agent tool" });

export const personalAgentCompanyToolPolicySchema = z
  .object({
    companyId: z.string().uuid(),
    enabled: z.boolean(),
    tools: z.array(personalAgentToolNameSchema).max(PERSONAL_AGENT_TOOLS.length).nullable(),
  })
  .strict();
export type PersonalAgentCompanyToolPolicy = z.infer<typeof personalAgentCompanyToolPolicySchema>;

/**
 * Which tools the personal agent may call, and in which companies.
 *
 * A tool runs in a company only when it is in `enabledTools`, the company is
 * enabled (its entry, else `companyDefault`), and the company entry's `tools`
 * list is null or names the tool. The user's own access is checked separately
 * on every call.
 */
export const personalAgentToolPolicySchema = z
  .object({
    enabledTools: z.array(personalAgentToolNameSchema).max(PERSONAL_AGENT_TOOLS.length),
    companyDefault: z.enum(["allow", "deny"]),
    companies: z.array(personalAgentCompanyToolPolicySchema).max(PERSONAL_AGENT_MAX_COMPANY_POLICIES),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const seen = new Set<string>();
    policy.companies.forEach((entry, index) => {
      if (seen.has(entry.companyId)) {
        ctx.addIssue({ code: "custom", path: ["companies", index, "companyId"], message: "Duplicate company" });
      }
      seen.add(entry.companyId);
    });
  });
export type PersonalAgentToolPolicy = z.infer<typeof personalAgentToolPolicySchema>;

/**
 * The policy a new personal agent starts with: every read tool, in every company.
 *
 * @returns A fresh default policy.
 */
export function defaultPersonalAgentToolPolicy(): PersonalAgentToolPolicy {
  return {
    enabledTools: PERSONAL_AGENT_TOOLS.filter((tool) => tool.risk === "read").map((tool) => tool.name),
    companyDefault: "allow",
    companies: [],
  };
}

/**
 * Decide whether the policy allows a tool, in a company for company tools.
 *
 * @param policy - The personal agent's tool policy.
 * @param toolName - The tool being called.
 * @param companyId - The target company; null for account tools.
 * @returns True when the policy allows the call. Unknown tools are never allowed.
 */
export function isPersonalAgentToolAllowed(
  policy: PersonalAgentToolPolicy,
  toolName: string,
  companyId: string | null,
): boolean {
  const tool = getPersonalAgentTool(toolName);
  if (!tool || !policy.enabledTools.includes(toolName)) return false;
  if (tool.scope === "account") return true;
  if (!companyId) return false;
  const entry = policy.companies.find((item) => item.companyId === companyId);
  if (!entry) return policy.companyDefault === "allow";
  return entry.enabled && (entry.tools === null || entry.tools.includes(toolName));
}

const nameSchema = z.string().trim().min(1).max(PERSONAL_AGENT_NAME_MAX_CHARS);
const changeSummarySchema = z.string().trim().max(PERSONAL_AGENT_CHANGE_SUMMARY_MAX_CHARS);

export const updatePersonalAgentSchema = z
  .object({
    name: nameSchema.optional(),
    toolPolicy: personalAgentToolPolicySchema.optional(),
  })
  .strict()
  .refine((input) => input.name !== undefined || input.toolPolicy !== undefined, {
    message: "Provide name or toolPolicy",
  });
export type UpdatePersonalAgent = z.infer<typeof updatePersonalAgentSchema>;

export const putPersonalAgentInstructionsSchema = z
  .object({
    body: z.string().max(PERSONAL_AGENT_INSTRUCTIONS_MAX_CHARS),
    baseRevision: z.number().int().min(0).optional(),
    changeSummary: changeSummarySchema.optional(),
  })
  .strict();
export type PutPersonalAgentInstructions = z.infer<typeof putPersonalAgentInstructionsSchema>;

const skillNameSchema = z.string().trim().min(1).max(PERSONAL_AGENT_NAME_MAX_CHARS);
const skillDescriptionSchema = z.string().trim().max(PERSONAL_AGENT_SKILL_DESCRIPTION_MAX_CHARS);
const skillMarkdownSchema = z.string().min(1).max(PERSONAL_AGENT_SKILL_MARKDOWN_MAX_CHARS);

export const PERSONAL_AGENT_SKILL_SOURCES = ["custom", "catalog"] as const;
export type PersonalAgentSkillSource = (typeof PERSONAL_AGENT_SKILL_SOURCES)[number];

export const createPersonalAgentSkillSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("custom"),
      name: skillNameSchema,
      description: skillDescriptionSchema.default(""),
      markdown: skillMarkdownSchema,
      enabled: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      source: z.literal("catalog"),
      catalogRef: z.string().trim().min(1).max(200),
      enabled: z.boolean().default(true),
    })
    .strict(),
]);
export type CreatePersonalAgentSkill = z.infer<typeof createPersonalAgentSkillSchema>;

export const updatePersonalAgentSkillSchema = z
  .object({
    name: skillNameSchema.optional(),
    description: skillDescriptionSchema.optional(),
    markdown: skillMarkdownSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "Provide at least one field",
  });
export type UpdatePersonalAgentSkill = z.infer<typeof updatePersonalAgentSkillSchema>;

export const PERSONAL_AGENT_AUDIT_ACTIONS = [
  "personal_agent.created",
  "personal_agent.updated",
  "personal_agent.instructions_updated",
  "personal_agent.skill_created",
  "personal_agent.skill_updated",
  "personal_agent.skill_deleted",
] as const;
export type PersonalAgentAuditAction = (typeof PERSONAL_AGENT_AUDIT_ACTIONS)[number];

export const USER_AUDIT_LIMIT_MAX = 200;

export const userAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(USER_AUDIT_LIMIT_MAX).default(50),
});

const isoDateSchema = z.string();

/** A personal agent as returned by the API. */
export const personalAgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  instructions: z.string(),
  instructionsRevision: z.number().int(),
  toolPolicy: personalAgentToolPolicySchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type PersonalAgent = z.infer<typeof personalAgentSchema>;

/** One saved version of the personal agent's instructions, without its body. */
export const personalAgentInstructionRevisionSummarySchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int(),
  changeSummary: z.string().nullable(),
  bodyLength: z.number().int(),
  createdAt: isoDateSchema,
});
export type PersonalAgentInstructionRevisionSummary = z.infer<typeof personalAgentInstructionRevisionSummarySchema>;

/** One saved version of the personal agent's instructions. */
export const personalAgentInstructionRevisionSchema = personalAgentInstructionRevisionSummarySchema.extend({
  body: z.string(),
});
export type PersonalAgentInstructionRevision = z.infer<typeof personalAgentInstructionRevisionSchema>;

/** A skill of the personal agent. */
export const personalAgentSkillSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  markdown: z.string(),
  source: z.enum(PERSONAL_AGENT_SKILL_SOURCES),
  catalogKey: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type PersonalAgentSkill = z.infer<typeof personalAgentSkillSchema>;

/** One row of the user's append-only audit log. */
export const userAuditEntrySchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  actorSource: z.string(),
  companyId: z.string().uuid().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
  createdAt: isoDateSchema,
});
export type UserAuditEntry = z.infer<typeof userAuditEntrySchema>;
