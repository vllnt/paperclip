import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface Seed {
  companyId: string;
  prefix: string;
  routineId: string;
}

interface SeedOptions {
  /** Titles carry a `{{target}}` variable, so a run must be given a value for it. */
  withVariable: boolean;
  status: "active" | "paused";
}

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 375, height: 667 },
] as const;

const BUILT_IN_OPTION = "Paperclip (built-in): when a task is created";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, key: string): string {
  if (isRecord(value) && typeof value[key] === "string") return value[key];
  throw new Error(`Response has no ${key}: ${JSON.stringify(value)}`);
}

function readId(value: unknown): string {
  if (isRecord(value) && isRecord(value.agent)) return readString(value.agent, "id");
  return readString(value, "id");
}

async function postJson(request: APIRequestContext, path: string, data: object): Promise<unknown> {
  const response = await request.post(path, { data });
  expect(response.ok(), `POST ${path} failed ${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function createAgent(request: APIRequestContext, companyId: string, name: string): Promise<string> {
  return readId(
    await postJson(request, `/api/companies/${companyId}/agents`, {
      name,
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "true" },
    }),
  );
}

/**
 * A company with a routine of two steps (implement, then review after it). The agents run the
 * `true` command, so a woken agent does nothing and calls no model.
 */
async function seed(request: APIRequestContext, label: string, options: SeedOptions): Promise<Seed> {
  const company = await postJson(request, "/api/companies", { name: `steps on task ${label} ${Date.now()}` });
  const companyId = readId(company);
  const lead = await createAgent(request, companyId, "Lead");
  const builder = await createAgent(request, companyId, "Builder");
  const project = await postJson(request, `/api/companies/${companyId}/projects`, { name: "Work" });
  const suffix = options.withVariable ? " {{target}}" : "";
  const routine = await postJson(request, `/api/companies/${companyId}/routines`, {
    projectId: readId(project),
    title: `Release check${suffix}`,
    description: "Lead brief",
    assigneeAgentId: lead,
    status: options.status,
    steps: [
      { key: "implement", title: `Implement${suffix}`, assigneeAgentId: builder },
      { key: "review", title: `Review${suffix}`, after: ["implement"], assigneeAgentId: lead },
    ],
  });
  return { companyId, prefix: readString(company, "issuePrefix"), routineId: readId(routine) };
}

interface CreatedTask {
  id: string;
  identifier: string;
}

async function createTask(
  request: APIRequestContext,
  companyId: string,
  title: string,
  status: "todo" | "in_progress",
): Promise<CreatedTask> {
  const issue = await postJson(request, `/api/companies/${companyId}/issues`, { title, status });
  return { id: readId(issue), identifier: readString(issue, "identifier") };
}

/** The routine-step tasks of a company, read through the API the way an agent would. */
async function stepTasks(request: APIRequestContext, companyId: string): Promise<Record<string, unknown>[]> {
  const response = await request.get(`/api/companies/${companyId}/issues?originKind=routine_step`);
  expect(response.ok()).toBe(true);
  const listed: unknown = await response.json();
  return Array.isArray(listed) ? listed.filter(isRecord) : [];
}

interface PageProblems {
  consoleErrors: string[];
  failedRequests: string[];
}

/**
 * Collects what a user would not want to hit: console errors, uncaught page errors, and requests
 * answered with an error status. Requests the test provokes on purpose are allowed by pattern.
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

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits, "the page scrolls sideways").toBe(true);
}

async function openRunDialog(page: Page, seeded: Seed, task: CreatedTask): Promise<void> {
  await page.goto(`/${seeded.prefix}/issues/${task.identifier}`);
  await page.getByRole("button", { name: "More task actions" }).click({ timeout: 30_000 });
  await page.getByRole("button", { name: "Run routine on this task" }).click();
  await expect(page.getByRole("dialog", { name: "Run routine on this task" })).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test.describe(`routine steps on a task at ${viewport.name} width`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a user runs a routine on an existing task, fills the variable and sees the steps appear", async ({
      page,
      request,
    }, testInfo) => {
      const seeded = await seed(request, viewport.name, { withVariable: true, status: "paused" });
      const task = await createTask(request, seeded.companyId, "Fix the login bug", "todo");
      const problems = watchPageProblems(page);

      await openRunDialog(page, seeded, task);
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("radio", { name: /Release check/ })).toBeVisible();
      await expect(dialog.getByText("2 steps")).toBeVisible();
      const run = dialog.getByRole("button", { name: "Run routine" });
      await expect(run).toBeDisabled();

      await dialog.getByRole("radio", { name: /Release check/ }).click();
      const target = dialog.locator("#run-on-task-variable-target");
      await expect(target).toBeVisible();
      await expect(run).toBeDisabled();
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: testInfo.outputPath(`run-on-task-${viewport.name}.png`) });

      await target.fill("web");
      await expect(run).toBeEnabled();
      await run.click();

      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect(page.getByText("Routine started on this task")).toBeVisible();
      await expect
        .poll(
          async () =>
            (await stepTasks(request, seeded.companyId))
              .filter((issue) => issue.parentId === task.id)
              .map((issue) => issue.title)
              .sort(),
          { timeout: 30_000 },
        )
        .toEqual(["Implement web", "Review web"]);

      await page.reload();
      await expect(page.getByText("Implement web").first()).toBeVisible({ timeout: 30_000 });
      expect(problems.consoleErrors).toEqual([]);
      expect(problems.failedRequests.filter((failed) => !MISSING_PLAN_DOCUMENT.test(failed))).toEqual([]);
    });
  });
}

test.describe("routine steps on a task: errors", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a task that is already in progress gets the server's explanation and the dialog stays usable", async ({
    page,
    request,
  }) => {
    const seeded = await seed(request, "busy", { withVariable: false, status: "paused" });
    const task = await createTask(request, seeded.companyId, "Already underway", "in_progress");
    const problems = watchPageProblems(page);

    await openRunDialog(page, seeded, task);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: /Release check/ }).click();
    await dialog.getByRole("button", { name: "Run routine" }).click();

    await expect(dialog.getByRole("alert")).toContainText(/in progress|backlog/i, { timeout: 30_000 });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Run routine" })).toBeEnabled();
    expect(await stepTasks(request, seeded.companyId)).toEqual([]);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(problems.consoleErrors).toEqual([]);
    expect(problems.failedRequests.filter((failed) => !MISSING_PLAN_DOCUMENT.test(failed))).toEqual([
      expect.stringMatching(/^409 \/api\/routines\/[^/]+\/run$/),
    ]);
  });
});

for (const viewport of VIEWPORTS) {
  test.describe(`routine steps start when a task is created at ${viewport.name} width`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a user picks the built-in Paperclip source, saves the trigger, and a new task starts the steps", async ({
      page,
      request,
    }, testInfo) => {
      const seeded = await seed(request, `event ${viewport.name}`, { withVariable: false, status: "active" });
      const problems = watchPageProblems(page);

      await page.goto(`/${seeded.prefix}/routines/${seeded.routineId}/triggers`);
      await page.getByRole("button", { name: "Add trigger" }).click({ timeout: 30_000 });
      await page.getByText("When a monitoring alert arrives").click();
      await page.getByRole("button", { name: "Continue" }).click();

      const source = page.getByLabel("Event source");
      await source.selectOption({ label: BUILT_IN_OPTION });
      await expect(page.getByText("so there is no URL or secret", { exact: false })).toBeVisible();
      await expect(page.getByLabel("Emitters")).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: testInfo.outputPath(`event-trigger-${viewport.name}.png`) });

      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Add event trigger" }).click();

      const card = page.getByRole("region", { name: "Event trigger" });
      await expect(card).toContainText("Steps attach to the created task", { timeout: 30_000 });

      await page.reload();
      await expect(page.getByRole("region", { name: "Event trigger" })).toContainText(
        "Steps attach to the created task",
        { timeout: 30_000 },
      );

      const task = await createTask(request, seeded.companyId, "Created after the trigger", "todo");
      await expect
        .poll(
          async () =>
            (await stepTasks(request, seeded.companyId))
              .filter((issue) => issue.parentId === task.id)
              .map((issue) => issue.title)
              .sort(),
          { timeout: 60_000 },
        )
        .toEqual(["Implement", "Review"]);
      expect(problems.consoleErrors).toEqual([]);
      expect(problems.failedRequests.filter((failed) => !MISSING_PLAN_DOCUMENT.test(failed))).toEqual([]);
    });
  });
}
