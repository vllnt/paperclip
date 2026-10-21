import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

interface SeededRoutine {
  companyId: string;
  prefix: string;
  routineId: string;
}

const VIEWPORTS = [
  { name: "desktop", width: 1920, height: 1080 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 667 },
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

async function postJson(request: APIRequestContext, path: string, data: object): Promise<unknown> {
  const response = await request.post(path, { data });
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
 * Creates a company with a routine of three steps (implement, review after implement, ship after
 * review). The agents run the `true` command, so a woken agent does nothing and calls no model.
 */
async function seedRoutine(request: APIRequestContext, label: string): Promise<SeededRoutine> {
  const company = await postJson(request, "/api/companies", { name: `routine steps ${label} ${Date.now()}` });
  const companyId = readId(company);
  const lead = await createAgent(request, companyId, "Lead");
  const builder = await createAgent(request, companyId, "Builder");
  const reviewer = await createAgent(request, companyId, "Reviewer");
  const project = await postJson(request, `/api/companies/${companyId}/projects`, { name: "Work" });
  const routine = await postJson(request, `/api/companies/${companyId}/routines`, {
    projectId: readId(project),
    title: "Release check for {{target}}",
    description: "Lead brief",
    assigneeAgentId: lead,
    status: "paused",
    steps: [
      { key: "implement", title: "Implement {{target}}", assigneeAgentId: builder, priority: "high" },
      { key: "review", title: "Review {{target}}", after: ["implement"], assigneeAgentId: reviewer },
      { key: "ship", title: "Ship {{target}}", after: ["review"] },
    ],
  });
  return { companyId, prefix: readIssuePrefix(company), routineId: readId(routine) };
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

/** A task without a plan has no plan document: its page asks for one and is told 404, as for any task. */
const MISSING_PLAN_DOCUMENT = /^404 \/api\/issues\/[^/]+\/documents\/plan$/;

/**
 * Opens the Steps section the way a user does: from the routine's navigation, which a narrow
 * screen keeps in the sidebar drawer until it is opened.
 */
async function openSteps(page: Page, seed: SeededRoutine): Promise<void> {
  await page.goto(`/${seed.prefix}/routines/${seed.routineId}`);
  await expect(page.getByRole("heading", { level: 1, name: /^Release check for/ })).toBeVisible({ timeout: 30_000 });
  const openSidebar = page.getByRole("button", { name: "Open sidebar" });
  if (await openSidebar.isVisible()) await openSidebar.click();
  await page.getByRole("navigation", { name: "Routine navigation" }).getByRole("link", { name: "Steps" }).click();
  await expect(page.getByLabel(/^Key of step \d+$/).first()).toBeVisible({ timeout: 30_000 });
}

function stepCard(page: Page, position: number): Locator {
  return page.getByRole("listitem").filter({ has: page.getByLabel(`Key of step ${position}`) });
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits, "the page scrolls sideways").toBe(true);
}

for (const viewport of VIEWPORTS) {
  test.describe(`routine steps at ${viewport.name} width`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a user adds a step that waits for another, saves, and finds it after a reload", async ({ page, request }, testInfo) => {
      const seed = await seedRoutine(request, viewport.name);
      const problems = watchPageProblems(page);

      await openSteps(page, seed);
      await expect(page.getByLabel(/^Key of step \d+$/)).toHaveCount(3);
      await expectNoHorizontalScroll(page);

      await page.getByRole("button", { name: "Add step" }).click();
      await expect(page.getByLabel(/^Key of step \d+$/)).toHaveCount(4);
      await page.getByLabel("Key of step 4").fill("docs");
      await page.locator("#routine-step-3-title").fill("Write docs for {{target}}");
      await stepCard(page, 4).getByRole("button", { name: "ship", exact: true }).click();
      await expect(stepCard(page, 4).getByRole("button", { name: "ship", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: testInfo.outputPath(`routine-steps-${viewport.name}-edited.png`) });

      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText(/unsaved change/)).toBeHidden();

      await page.reload();
      await expect(page.getByLabel(/^Key of step \d+$/)).toHaveCount(4);
      await expect(page.getByLabel("Key of step 4")).toHaveValue("docs");
      await expect(page.locator("#routine-step-3-title")).toHaveValue("Write docs for {{target}}");
      await expect(stepCard(page, 4).getByRole("button", { name: "ship", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(problems).toEqual({ consoleErrors: [], failedRequests: [] });
    });

    test("a user makes a step run only when another step is cancelled, saves, and finds the condition after a reload", async ({
      page,
      request,
    }, testInfo) => {
      const seed = await seedRoutine(request, `${viewport.name} condition`);
      const problems = watchPageProblems(page);

      await openSteps(page, seed);
      const condition = page.getByRole("combobox", { name: "Condition on review for step 3" });
      await expect(condition).toContainText("Wait until done");

      await condition.click();
      await page.getByRole("option", { name: "Only if cancelled" }).click();
      await expect(condition).toContainText("Only if cancelled");
      await expect(page.getByText(/Skipped: condition not met/)).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: testInfo.outputPath(`routine-steps-${viewport.name}-condition.png`) });

      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText(/unsaved change/)).toBeHidden();

      await page.reload();
      await expect(page.getByLabel(/^Key of step \d+$/)).toHaveCount(3);
      await expect(page.getByRole("combobox", { name: "Condition on review for step 3" })).toContainText(
        "Only if cancelled",
      );
      await expect(page.getByRole("combobox", { name: "Condition on implement for step 2" })).toContainText(
        "Wait until done",
      );
      expect(problems).toEqual({ consoleErrors: [], failedRequests: [] });
    });
  });
}

test.describe("routine steps errors and runs", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("a user sees what is wrong with a step and cannot make two steps wait for each other", async ({
    page,
    request,
  }) => {
    const seed = await seedRoutine(request, "errors");
    const problems = watchPageProblems(page);
    await openSteps(page, seed);

    await expect(stepCard(page, 1).getByRole("button", { name: "ship", exact: true })).toBeDisabled();
    await expect(stepCard(page, 3).getByRole("button", { name: "implement", exact: true })).toBeEnabled();

    await page.getByLabel("Key of step 1").fill("Bad Key");
    await expect(page.getByRole("list", { name: "Step problems" })).toBeVisible();

    await page.getByLabel("Key of step 1").fill("build");
    await expect(page.getByRole("list", { name: "Step problems" })).toBeHidden();
    await expect(stepCard(page, 2).getByRole("button", { name: "build", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(problems).toEqual({ consoleErrors: [], failedRequests: [] });
  });

  test("a run's step tasks are hidden with the routine runs and say they are routine steps", async ({
    page,
    request,
  }) => {
    const seed = await seedRoutine(request, "runs");
    const problems = watchPageProblems(page);
    await postJson(request, `/api/routines/${seed.routineId}/run`, { variables: { target: "web" } });

    await page.goto(`/${seed.prefix}/issues`);
    await expect(page.getByText("Implement web", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Release check for web", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: /filter/i }).first().click();
    await page.getByText("Hide routine runs", { exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Implement web", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Release check for web", { exact: true })).toHaveCount(0);

    const stepIssues = await request.get(`/api/companies/${seed.companyId}/issues?originKind=routine_step`);
    expect(stepIssues.ok()).toBe(true);
    const listed: unknown = await stepIssues.json();
    const implement = Array.isArray(listed)
      ? listed.find((issue) => isRecord(issue) && issue.title === "Implement web")
      : undefined;
    expect(isRecord(implement) && typeof implement.identifier === "string").toBe(true);
    const identifier = isRecord(implement) && typeof implement.identifier === "string" ? implement.identifier : "";
    await page.goto(`/${seed.prefix}/issues/${identifier}`);
    await expect(page.getByTitle(`Routine step from routine ${seed.routineId}`).first()).toBeVisible({
      timeout: 30_000,
    });
    expect(problems.consoleErrors).toEqual([]);
    expect(problems.failedRequests.filter((request) => !MISSING_PLAN_DOCUMENT.test(request))).toEqual([]);
  });
});
