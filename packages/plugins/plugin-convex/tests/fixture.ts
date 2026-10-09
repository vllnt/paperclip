import { vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { register } from "../src/worker.js";
import { FakeConvex, FakeGitHub, NOW } from "./fakes.js";

export const COMPANY_A = "company-a";
export const COMPANY_B = "company-b";
export const TEAM_TOKEN = "cvx_team_TOPSECRET_0123456789";
export const PROJECT_TOKEN = "cvx_project_TOPSECRET_9876543210";
export const GITHUB_TOKEN = "gh-token";

export const ref = (secretId: string) => ({ type: "secret_ref", secretId, version: "latest" });
export const secretValues: Record<string, string> = { "s-team": TEAM_TOKEN, "s-project": PROJECT_TOKEN, "s-gh": GITHUB_TOKEN };

export function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    teamId: "1",
    teamToken: ref("s-team"),
    projects: [{ convexProjectId: "100", name: "app", repository: "org/app", environments: { production: ["prod-app"], staging: ["staging-app"] } }],
    github: { token: ref("s-gh") },
    grants: [
      { agentId: "janitor", preset: "janitor", environments: ["preview"] },
      { agentId: "observer", preset: "observer", environments: ["production", "staging", "preview", "dev", "custom"] },
      { agentId: "preview-reader", preset: "observer", environments: ["preview"] },
    ],
    ...overrides,
  };
}

export const admin = (companyId: string) => ({ companyId, actor: { type: "user" as const, userId: "u1", companyId, agentId: null, runId: null, isInstanceAdmin: true } });
export const member = (companyId: string) => ({ companyId, actor: { type: "user" as const, userId: "u2", companyId, agentId: null, runId: null } });
export const run = (agentId: string, companyId = COMPANY_A, runId = "run-1") => ({ agentId, runId, companyId, projectId: "p1" });

export async function setup(options: { configs?: Record<string, Record<string, unknown>>; connect?: string[] } = {}) {
  const configs: Record<string, Record<string, unknown>> = options.configs ?? { [COMPANY_A]: baseConfig() };
  const h = createTestHarness({ manifest, config: configs[COMPANY_A] ?? {} });
  vi.spyOn(h.ctx.config, "get").mockImplementation(async companyId => configs[companyId ?? ""] ?? {});
  vi.spyOn(h.ctx.secrets, "resolve").mockImplementation(async binding => {
    const secretId = typeof binding === "string" ? binding : binding.secretId;
    const value = secretValues[secretId];
    if (!value) throw new Error("Secret not found.");
    return value;
  });
  const issue = vi.spyOn(h.ctx.issues, "create").mockResolvedValue({ id: "issue-1" } as never);
  const agent = (id: string, companyId: string, role = "engineer") => ({ id, companyId, name: id, role, status: "idle" });
  h.seed({ agents: [agent("janitor", COMPANY_A, "devops"), agent("observer", COMPANY_A), agent("nogrant", COMPANY_A), agent("preview-reader", COMPANY_A), agent("b-agent", COMPANY_B)] as never });
  const convex = new FakeConvex();
  convex.validTokens.add(TEAM_TOKEN).add(PROJECT_TOKEN);
  const github = new FakeGitHub();
  const clock = { now: NOW };
  const runtime = register(h.ctx, { fetch: convex.fetch, githubFetch: github.fetch, now: () => clock.now });
  for (const companyId of options.connect ?? Object.keys(configs)) {
    await h.performAction("connection.connect", {}, admin(companyId));
  }
  convex.calls.length = 0;
  return { h, configs, convex, github, issue, runtime, clock };
}

export type Fixture = Awaited<ReturnType<typeof setup>>;
