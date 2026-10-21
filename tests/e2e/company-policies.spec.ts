import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * Company and project policies: a board user creates, edits, restores, archives and deletes written rules
 * on the company Policies page, and adds a project policy from the project's Configuration tab.
 */

const SCREENSHOT_DIR = process.env.PAPERCLIP_E2E_SCREENSHOT_DIR;

async function post<T>(request: APIRequestContext, url: string, data: Record<string, unknown>): Promise<T> {
  const res = await request.post(url, { data });
  expect(res.ok(), `POST ${url} failed ${res.status()}: ${await res.text()}`).toBe(true);
  return res.json();
}

async function seed(request: APIRequestContext) {
  const company = await post<{ id: string; issuePrefix: string }>(request, "/api/companies", { name: `Policies ${Date.now()}` });
  const project = await post<{ id: string; urlKey: string }>(request, `/api/companies/${company.id}/projects`, {
    name: "Website",
  });
  return { company, project };
}

/**
 * Console errors and uncaught page errors, plus requests answered with an error status. The browser words a
 * failed request as "Failed to load resource" without its address, so those are kept by path instead.
 */
function watchPageProblems(page: Page) {
  const problems = { consoleErrors: [] as string[], failedRequests: [] as string[] };
  page.on("pageerror", (err) => problems.consoleErrors.push(`PAGEERROR: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error" || msg.text().startsWith("Failed to load resource")) return;
    problems.consoleErrors.push(`CONSOLE: ${msg.text().slice(0, 300)}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      problems.failedRequests.push(`${response.request().method()} ${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  return problems;
}

async function choose(dialog: Locator, page: Page, label: string, option: string) {
  await dialog.getByLabel(label).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function typeBody(dialog: Locator, page: Page, text: string) {
  const editor = dialog.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
}

async function expectNoHorizontalScroll(page: Page, width: number) {
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(pageWidth, "no horizontal page scroll").toBeLessThanOrEqual(width);
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`board manages company and project policies (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const problems = watchPageProblems(page);
    const { company, project } = await seed(page.request);

    await page.goto(`/${company.issuePrefix}/policies`);
    await expect(page.getByText("No policies yet. Write the first rule agents should follow.")).toBeVisible();
    await expectNoHorizontalScroll(page, viewport.width);
    if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/policies-empty-${viewport.name}.png` });

    await page.getByRole("button", { name: "New policy" }).first().click();
    let dialog = page.getByRole("dialog", { name: "New policy" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Title").fill("Code review");
    await expect(dialog.getByLabel("Key")).toHaveValue("code-review");
    await dialog.getByLabel("Summary").fill("Every change gets a second reviewer.");
    await typeBody(dialog, page, "Ask another agent to review each pull request.");
    await choose(dialog, page, "Status", "active");
    if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/policies-editor-${viewport.name}.png` });
    await dialog.getByRole("button", { name: "Create policy" }).click();
    await expect(dialog).toBeHidden();

    const companySection = page.getByRole("region", { name: "Company" });
    await expect(companySection.getByText("Code review")).toBeVisible();
    await expect(companySection.getByText("policy://code-review")).toBeVisible();
    await expect(companySection.getByText("Every change gets a second reviewer.")).toBeVisible();

    await page.getByRole("button", { name: "New policy" }).first().click();
    dialog = page.getByRole("dialog", { name: "New policy" });
    await dialog.getByLabel("Title").fill("Code review");
    await dialog.getByRole("button", { name: "Create policy" }).click();
    await expect(dialog.getByRole("alert")).toContainText('A policy with the key "code-review" already exists');
    await dialog.getByLabel("Key").fill("code-review-two");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await companySection.getByText("Code review").click();
    dialog = page.getByRole("dialog", { name: "Edit policy" });
    await expect(dialog.getByText("policy://code-review")).toBeVisible();
    await expect(dialog.getByRole("alert"), "the cancelled create's error is gone").toHaveCount(0);
    await typeBody(dialog, page, "Ask two agents to review each pull request.");
    await dialog.getByLabel("Change note").fill("Two reviewers");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();

    await page.reload();
    await page.getByRole("region", { name: "Company" }).getByText("Code review").click();
    dialog = page.getByRole("dialog", { name: "Edit policy" });
    await expect(dialog.getByText("Ask two agents to review each pull request.")).toBeVisible();
    await dialog.getByRole("button", { name: "History (2 revisions)" }).click();
    const revisions = dialog.getByRole("list", { name: "Policy revisions" });
    await expect(revisions.getByText("Two reviewers")).toBeVisible();
    await expect(revisions.getByText("Current")).toBeVisible();
    await revisions.getByRole("button", { name: "View" }).last().click();
    await expect(revisions.getByText("Ask another agent to review each pull request.")).toBeVisible();
    if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/policies-history-${viewport.name}.png` });
    await revisions.getByRole("button", { name: "Restore" }).click();
    await expect(dialog).toBeHidden();

    await companySection.getByText("Code review").click();
    dialog = page.getByRole("dialog", { name: "Edit policy" });
    await expect(dialog.getByText("Ask another agent to review each pull request.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "History (3 revisions)" })).toBeVisible();
    await choose(dialog, page, "Status", "archived");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Only archived policies.")).toBeVisible();

    await page.getByRole("button", { name: "Show archived (1)" }).click();
    await page.getByRole("region", { name: "Company" }).getByText("Code review").click();
    dialog = page.getByRole("dialog", { name: "Edit policy" });
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await dialog.getByRole("button", { name: "Confirm delete" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("No policies yet. Write the first rule agents should follow.")).toBeVisible();

    await page.goto(`/${company.issuePrefix}/projects/${project.urlKey}/configuration`);
    const projectSection = page.getByRole("region", { name: "Policies" });
    await expect(projectSection.getByText("No project policies yet.")).toBeVisible();
    await projectSection.getByRole("button", { name: "New policy" }).click();
    dialog = page.getByRole("dialog", { name: "New policy" });
    await expect(dialog.getByLabel("Applies to")).toContainText("Project: Website");
    await dialog.getByLabel("Title").fill("Release checklist");
    await dialog.getByRole("button", { name: "Create policy" }).click();
    await expect(dialog).toBeHidden();
    await expect(projectSection.getByText("Release checklist")).toBeVisible();
    await expect(projectSection.getByText("draft")).toBeVisible();
    await expectNoHorizontalScroll(page, viewport.width);
    if (SCREENSHOT_DIR) await projectSection.screenshot({ path: `${SCREENSHOT_DIR}/policies-project-${viewport.name}.png` });

    await page.goto(`/${company.issuePrefix}/policies`);
    const projectsGroup = page.getByRole("region", { name: "Projects" });
    await expect(projectsGroup.getByText("Release checklist")).toBeVisible();
    await expect(projectsGroup.getByText("Website")).toBeVisible();
    await expectNoHorizontalScroll(page, viewport.width);
    if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/policies-list-${viewport.name}.png` });

    expect(problems.consoleErrors).toEqual([]);
    expect(problems.failedRequests, "only the duplicate key is refused").toEqual([
      `POST 409 /api/companies/${company.id}/policies`,
    ]);
  });
}
