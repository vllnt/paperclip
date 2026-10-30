import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface SeededCompany {
  companyId: string;
  prefix: string;
}

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, tabsAsSelect: false },
  { name: "mobile", width: 390, height: 844, tabsAsSelect: true },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readId(value: unknown): string {
  if (isRecord(value) && typeof value.id === "string") return value.id;
  if (isRecord(value) && isRecord(value.agent) && typeof value.agent.id === "string") return value.agent.id;
  throw new Error(`Response has no id: ${JSON.stringify(value)}`);
}

function readIssuePrefix(value: unknown): string {
  if (isRecord(value) && typeof value.issuePrefix === "string") return value.issuePrefix;
  throw new Error(`Company has no issue prefix: ${JSON.stringify(value)}`);
}

async function postJson(request: APIRequestContext, path: string, data?: object): Promise<unknown> {
  const response = await request.post(path, data ? { data } : undefined);
  expect(response.ok(), `POST ${path} failed ${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function createAgent(request: APIRequestContext, companyId: string, name: string): Promise<string> {
  const created = await postJson(request, `/api/companies/${companyId}/agents`, {
    name,
    role: "engineer",
    adapterType: "process",
    adapterConfig: { command: "true" },
  });
  return readId(created);
}

/**
 * Creates a company with four routines: one on a cron schedule, one with no trigger that has run
 * once, one whose steps start on every task a person creates, and one with a chain of steps. The
 * agents run the `true` command, so a woken agent does nothing and calls no model.
 */
async function seedCompany(request: APIRequestContext, label: string): Promise<SeededCompany> {
  const company = await postJson(request, "/api/companies", { name: `routines timeline ${label} ${Date.now()}` });
  const companyId = readId(company);
  const lead = await createAgent(request, companyId, "Lead");
  const builder = await createAgent(request, companyId, "Builder");
  const project = await postJson(request, `/api/companies/${companyId}/projects`, { name: "Work" });
  const projectId = readId(project);

  const nightly = await postJson(request, `/api/companies/${companyId}/routines`, {
    projectId,
    title: "Nightly report",
    description: "Summarise the day",
    assigneeAgentId: lead,
  });
  await postJson(request, `/api/routines/${readId(nightly)}/triggers`, {
    kind: "schedule",
    cronExpression: "0 */6 * * *",
    timezone: "UTC",
  });

  const manual = await postJson(request, `/api/companies/${companyId}/routines`, {
    projectId,
    title: "Manual check",
    description: "Run by hand",
    assigneeAgentId: lead,
  });
  await postJson(request, `/api/routines/${readId(manual)}/run`, {});

  const triage = await postJson(request, `/api/companies/${companyId}/routines`, {
    projectId,
    title: "Triage new tasks",
    description: "Look at a new task",
    assigneeAgentId: lead,
    steps: [
      { key: "triage", title: "Triage {{issue.title}}", assigneeAgentId: builder },
      { key: "fix", title: "Fix {{issue.title}}", after: ["triage"], assigneeAgentId: builder },
    ],
  });
  const builtIn = await postJson(request, `/api/companies/${companyId}/event-sources/paperclip`);
  await postJson(request, `/api/routines/${readId(triage)}/triggers`, {
    kind: "event",
    eventSourceId: readId(builtIn),
    eventMatch: { types: ["issue.created"], labels: { created_by: "user" } },
    eventGrouping: { issueMode: "event_issue" },
    fallback: false,
  });

  await postJson(request, `/api/companies/${companyId}/routines`, {
    projectId,
    title: "Release check",
    description: "Check a release",
    assigneeAgentId: lead,
    status: "paused",
    steps: [
      { key: "implement", title: "Implement", assigneeAgentId: builder },
      { key: "review", title: "Review", after: ["implement"], assigneeAgentId: lead },
      { key: "ship", title: "Ship", after: ["review"], assigneeAgentId: builder },
    ],
  });

  return { companyId, prefix: readIssuePrefix(company) };
}

interface PageProblems {
  consoleErrors: string[];
  failedRequests: string[];
}

/**
 * Collects what a user would not want to hit: console errors, uncaught page errors, and requests
 * answered with an error status. The browser words a failed request as "Failed to load resource"
 * without its address, so those are reported through `failedRequests`, which keeps the path.
 */
function watchPageProblems(page: Page): PageProblems {
  const problems: PageProblems = { consoleErrors: [], failedRequests: [] };
  page.on("console", (message) => {
    if (message.type() !== "error" || message.text().startsWith("Failed to load resource")) return;
    problems.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => problems.consoleErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      problems.failedRequests.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  return problems;
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits, "the page scrolls sideways").toBe(true);
}

for (const viewport of VIEWPORTS) {
  test.describe(`routines timeline at ${viewport.name} width`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a user sees the runs and next fires, then how the routines link", async ({ page, request }, testInfo) => {
      const seed = await seedCompany(request, viewport.name);
      const problems = watchPageProblems(page);

      await page.goto(`/${seed.prefix}/routines/timeline`);
      await expect(page.getByRole("heading", { level: 1, name: "Routines timeline" })).toBeVisible({ timeout: 30_000 });

      // Four routines, one of them with an enabled cron trigger.
      const summary = page.locator("dl");
      await expect(summary.getByText("Routines", { exact: true })).toBeVisible();
      await expect(summary.locator("dt", { hasText: /^Routines$/ }).locator("xpath=following-sibling::dd")).toHaveText("4");
      await expect(summary.locator("dt", { hasText: /^Scheduled$/ }).locator("xpath=following-sibling::dd")).toHaveText("1");
      await expect(summary.locator("dt", { hasText: /^Runs in window$/ }).locator("xpath=following-sibling::dd")).toHaveText("1");

      // A cron every six hours has next fires inside the default window, listed in the chart header.
      const timeline = page.getByTestId("routine-timeline");
      await expect(timeline).toBeVisible();
      await expect(timeline).toContainText(/[1-9]\d* next fires?/);
      await expect(timeline).toContainText("1 run");
      await expect(page.getByRole("list", { name: "Bar colours" })).toBeVisible();
      await expect(page.getByRole("group", { name: "Timeline zoom controls" })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: testInfo.outputPath(`routines-timeline-${viewport.name}-timeline.png`), fullPage: true });

      // Zoom and span change the chart without an error.
      await page.getByRole("button", { name: "Zoom in" }).click();
      await page.getByRole("button", { name: "Zoom out" }).click();
      await page.getByRole("button", { name: "Reset zoom" }).click();
      await page.getByRole("group", { name: "Span" }).getByRole("button", { name: "Week" }).click();
      await expect(page.getByRole("group", { name: "Span" }).getByRole("button", { name: "Week" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(timeline).toContainText(/[1-9]\d* next fires?/);

      // The Links view: the event source, both step chains and the routines are nodes.
      // A narrow screen swaps the tab bar for a "Page section" select, as every page with tabs does.
      if (viewport.tabsAsSelect) await page.getByLabel("Page section").selectOption("links");
      else await page.getByRole("tab", { name: "Links" }).click();
      await expect(page).toHaveURL(/view=links/);
      const links = page.getByTestId("routine-links");
      await expect(links).toBeVisible();
      await expect(page.getByTestId("routine-link-node-routine")).toHaveCount(4);
      await expect(page.getByTestId("routine-link-node-event_source")).toHaveCount(1);
      await expect(page.getByTestId("routine-link-edge-event_trigger")).toHaveCount(1);
      await expect(page.getByTestId("routine-link-edge-step_after").first()).toBeAttached();
      await expect(page.getByRole("link", { name: "Routine Triage new tasks" })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: testInfo.outputPath(`routines-timeline-${viewport.name}-links.png`), fullPage: true });

      // The view survives a reload.
      await page.reload();
      await expect(page.getByTestId("routine-links")).toBeVisible({ timeout: 30_000 });
      expect(problems).toEqual({ consoleErrors: [], failedRequests: [] });
    });
  });
}
