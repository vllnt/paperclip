import { expect, test, type APIResponse } from "@playwright/test";

async function json<T>(response: APIResponse, label: string): Promise<T> {
  expect(response.ok(), `${label} failed ${response.status()}: ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

test("an operator creates a task on a company run tier", async ({ page, request }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `Run tier browser E2E ${Date.now()}` } }),
    "create company",
  );
  const tiers = {
    tiers: {
      fast: { adapterType: "codex_local", model: "grok-4.7", effort: "low" },
      standard: { adapterType: "claude_local", model: "claude-sonnet-5-5" },
    },
    agentAllowlist: ["fast"],
  };
  await json(await request.put(`/api/companies/${company.id}/run-tiers`, { data: tiers }), "set tiers");
  const agent = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Implementer",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: { model: "claude-opus-5-5" },
        runtimeConfig: { heartbeat: { enabled: false } },
        fallbacks: [{ adapterType: "codex_local", model: "gpt-5.5", env: { CODEX_HOME: "/srv/codex-home" } }],
      },
    }),
    "create agent",
  );

  await page.goto(`/${company.issuePrefix}/dashboard`);
  await page.getByRole("button", { name: "New Task" }).first().click();
  await page.getByPlaceholder("Task title").fill("Sweep the stale branches");
  await page.getByRole("button", { name: "Assignee", exact: true }).click();
  await page.getByRole("button", { name: "Implementer" }).first().click();
  const noProject = page.getByRole("button", { name: "No project", exact: true });
  if (await noProject.isVisible().catch(() => false)) await noProject.click();

  await page.getByRole("button", { name: "Claude options", exact: true }).click();
  const picker = page.getByTestId("run-tier-picker");
  await expect(picker).toBeVisible();
  await picker.getByRole("combobox", { name: "Run with" }).click();
  await expect(page.getByRole("option", { name: /Agent default · claude_local\/claude-opus-5-5/ })).toBeVisible();
  await page.getByRole("option", { name: /^fast · codex_local\/grok-4\.7 \(low\)/ }).click();
  await expect(picker.getByRole("combobox", { name: "Run with" })).toContainText("fast");

  const screenshotDir = process.env.PAPERCLIP_E2E_SCREENSHOT_DIR;
  if (screenshotDir) {
    for (const [name, width, height] of [["desktop", 1920, 1080], ["tablet", 768, 1024], ["mobile", 375, 667]] as const) {
      await page.setViewportSize({ width, height });
      await expect(picker).toBeVisible();
      await page.screenshot({ path: `${screenshotDir}/run-tier-picker-${name}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  }

  await page.getByRole("button", { name: "Create Task", exact: true }).click();
  await expect.poll(async () => {
    const issues = await json<Array<{ title: string; assigneeAgentId: string | null; assigneeAdapterOverrides: unknown }>>(
      await request.get(`/api/companies/${company.id}/issues`),
      "list issues",
    );
    return issues.find((issue) => issue.title === "Sweep the stale branches") ?? null;
  }).toMatchObject({ assigneeAgentId: agent.id, assigneeAdapterOverrides: { runProfile: { tier: "fast" } } });

  expect(consoleErrors).toEqual([]);
});
