import { describe, expect, it } from "vitest";
import {
  PERSONAL_AGENT_TOOLS,
  createPersonalAgentSkillSchema,
  defaultPersonalAgentToolPolicy,
  isPersonalAgentToolAllowed,
  personalAgentToolPolicySchema,
  updatePersonalAgentSchema,
  type PersonalAgentToolPolicy,
} from "./personal-agent.js";

const companyA = "11111111-1111-4111-8111-111111111111";
const companyB = "22222222-2222-4222-8222-222222222222";

describe("personal agent tool policy", () => {
  it("defaults to every read tool in every company", () => {
    const policy = defaultPersonalAgentToolPolicy();
    expect(policy.companyDefault).toBe("allow");
    expect(policy.enabledTools).toEqual(PERSONAL_AGENT_TOOLS.filter((tool) => tool.risk === "read").map((tool) => tool.name));
    expect(isPersonalAgentToolAllowed(policy, "list_issues", companyA)).toBe(true);
    expect(isPersonalAgentToolAllowed(policy, "list_companies", null)).toBe(true);
  });

  it("denies unknown tools, disabled tools and company tools without a company", () => {
    const policy: PersonalAgentToolPolicy = { enabledTools: ["list_issues"], companyDefault: "allow", companies: [] };
    expect(isPersonalAgentToolAllowed(policy, "delete_everything", companyA)).toBe(false);
    expect(isPersonalAgentToolAllowed(policy, "list_agents", companyA)).toBe(false);
    expect(isPersonalAgentToolAllowed(policy, "list_issues", null)).toBe(false);
  });

  it("applies the company default, a company switch and a company tool list", () => {
    const policy: PersonalAgentToolPolicy = {
      enabledTools: ["list_issues", "list_agents"],
      companyDefault: "deny",
      companies: [
        { companyId: companyA, enabled: true, tools: ["list_issues"] },
        { companyId: companyB, enabled: false, tools: null },
      ],
    };
    expect(isPersonalAgentToolAllowed(policy, "list_issues", companyA)).toBe(true);
    expect(isPersonalAgentToolAllowed(policy, "list_agents", companyA)).toBe(false);
    expect(isPersonalAgentToolAllowed(policy, "list_issues", companyB)).toBe(false);
    expect(isPersonalAgentToolAllowed(policy, "list_issues", "33333333-3333-4333-8333-333333333333")).toBe(false);
  });

  it("rejects unknown tool names, duplicate companies and extra fields", () => {
    expect(personalAgentToolPolicySchema.safeParse({ enabledTools: ["nope"], companyDefault: "allow", companies: [] }).success).toBe(false);
    expect(
      personalAgentToolPolicySchema.safeParse({
        enabledTools: [],
        companyDefault: "allow",
        companies: [
          { companyId: companyA, enabled: true, tools: null },
          { companyId: companyA, enabled: false, tools: null },
        ],
      }).success,
    ).toBe(false);
    expect(personalAgentToolPolicySchema.safeParse({ ...defaultPersonalAgentToolPolicy(), extra: true }).success).toBe(false);
  });
});

describe("personal agent input schemas", () => {
  it("requires at least one field on update", () => {
    expect(updatePersonalAgentSchema.safeParse({}).success).toBe(false);
    expect(updatePersonalAgentSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(updatePersonalAgentSchema.safeParse({ name: "Mine" }).success).toBe(true);
  });

  it("accepts custom and catalog skills, nothing else", () => {
    expect(createPersonalAgentSkillSchema.safeParse({ source: "custom", name: "Triage", markdown: "# Triage" }).success).toBe(true);
    expect(createPersonalAgentSkillSchema.safeParse({ source: "catalog", catalogRef: "a/b" }).success).toBe(true);
    expect(createPersonalAgentSkillSchema.safeParse({ source: "custom", name: "Triage", markdown: "" }).success).toBe(false);
    expect(createPersonalAgentSkillSchema.safeParse({ source: "company", skillId: companyA }).success).toBe(false);
  });
});
