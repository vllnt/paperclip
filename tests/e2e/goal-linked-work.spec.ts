import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * A goal page shows the work linked to the goal: its projects, its open tasks, its routines and
 * the agents of that work. Sub-goals keep their own work on their own page.
 */

const SCREENSHOT_DIR = process.env.PAPERCLIP_E2E_SCREENSHOT_DIR;

async function post<T>(request: APIRequestContext, url: string, data: Record<string, unknown>): Promise<T> {
  const res = await request.post(url, { data });
  expect(res.ok(), `POST ${url} failed ${res.status()}: ${await res.text()}`).toBe(true);
  return res.json();
}

async function seed(request: APIRequestContext) {
  const company = await post<{ id: string; issuePrefix: string }>(request, "/api/companies", { name: `Goal Links ${Date.now()}` });
  const agent = (name: string) =>
    post<{ id: string }>(request, `/api/companies/${company.id}/agents`, {
      name,
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "true" },
    });
  const owner = await agent("Goal owner");
  const builder = await agent("Builder");
  const scheduler = await agent("Scheduler");
  const goal = await post<{ id: string }>(request, `/api/companies/${company.id}/goals`, {
    title: "Ship the beta",
    level: "company",
    status: "active",
    ownerAgentId: owner.id,
  });
  const subGoal = await post<{ id: string }>(request, `/api/companies/${company.id}/goals`, {
    title: "Beta docs",
    level: "team",
    status: "active",
    parentId: goal.id,
  });
  await post(request, `/api/companies/${company.id}/projects`, { name: "Beta launch", goalIds: [goal.id] });
  await post(request, `/api/companies/${company.id}/projects`, { name: "Unrelated project" });
  // Backlog tasks do not wake their agent, so the fixture stays still.
  await post(request, `/api/companies/${company.id}/issues`, {
    title: "Write the release notes",
    status: "backlog",
    goalId: goal.id,
    assigneeAgentId: builder.id,
  });
  await post(request, `/api/companies/${company.id}/issues`, { title: "Finished beta task", status: "done", goalId: goal.id });
  await post(request, `/api/companies/${company.id}/issues`, { title: "Sub-goal task", status: "backlog", goalId: subGoal.id });
  await post(request, `/api/companies/${company.id}/routines`, {
    title: "Nightly beta build",
    goalId: goal.id,
    assigneeAgentId: scheduler.id,
  });
  await post(request, `/api/companies/${company.id}/routines`, { title: "Routine of another goal", goalId: subGoal.id });
  return { company, goal };
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`CONSOLE: ${msg.text().slice(0, 300)}`);
  });
  return errors;
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`a goal page lists the goal's projects, open tasks, routines and agents (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const errors = collectConsoleErrors(page);
    const { company, goal } = await seed(page.request);

    await page.goto(`/${company.issuePrefix}/goals/${goal.id}`);
    await expect(page.getByRole("heading", { name: "Ship the beta" })).toBeVisible();

    await page.getByRole("tab", { name: "Projects (1)" }).click();
    await expect(page.getByRole("tabpanel").getByText("Beta launch")).toBeVisible();
    await expect(page.getByRole("tabpanel").getByText("Unrelated project")).toHaveCount(0);

    await page.getByRole("tab", { name: "Open tasks (1)" }).click();
    const tasks = page.getByRole("tabpanel");
    await expect(tasks.getByText("Write the release notes")).toBeVisible();
    await expect(tasks.getByText("Finished beta task")).toHaveCount(0);
    await expect(tasks.getByText("Sub-goal task")).toHaveCount(0);

    await page.getByRole("tab", { name: "Routines (1)" }).click();
    const routines = page.getByRole("tabpanel");
    await expect(routines.getByText("Nightly beta build")).toBeVisible();
    await expect(routines.getByText("Routine of another goal")).toHaveCount(0);

    await page.getByRole("tab", { name: "Agents (3)" }).click();
    const agents = page.getByRole("tabpanel");
    await expect(agents.getByText("Goal owner")).toBeVisible();
    await expect(agents.getByText("Builder")).toBeVisible();
    await expect(agents.getByText("Scheduler")).toBeVisible();
    await expect(agents.getByText("Open tasks", { exact: true })).toBeVisible();
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth, "no horizontal page scroll").toBeLessThanOrEqual(viewport.width);
    if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/goal-linked-work-${viewport.name}.png`, fullPage: true });

    await agents.getByText("Builder").click();
    await expect(page).toHaveURL(/\/agents\//);

    expect(errors).toEqual([]);
  });
}
