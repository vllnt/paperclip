import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * The project Configuration tab lists the routines that belong to the project, hides archived ones
 * until asked, and creates and edits them in place: New routine opens the composer with the project
 * chosen, and Edit opens it filled from the routine.
 */

const SCREENSHOT_DIR = process.env.PAPERCLIP_E2E_SCREENSHOT_DIR;

async function post<T>(request: APIRequestContext, url: string, data: Record<string, unknown>): Promise<T> {
  const res = await request.post(url, { data });
  expect(res.ok(), `POST ${url} failed ${res.status()}: ${await res.text()}`).toBe(true);
  return res.json();
}

async function seed(request: APIRequestContext) {
  const company = await post<{ id: string; issuePrefix: string }>(request, "/api/companies", { name: `Project Routines ${Date.now()}` });
  const alpha = await post<{ id: string; urlKey: string }>(request, `/api/companies/${company.id}/projects`, { name: "Alpha" });
  const empty = await post<{ id: string; urlKey: string }>(request, `/api/companies/${company.id}/projects`, { name: "Empty project" });
  await post(request, `/api/companies/${company.id}/routines`, { title: "Nightly triage", projectId: alpha.id });
  await post(request, `/api/companies/${company.id}/routines`, {
    title: "Weekly dependency sweep with a deliberately long title that has to wrap on a phone",
    projectId: alpha.id,
  });
  await post(request, `/api/companies/${company.id}/routines`, { title: "Old sync", projectId: alpha.id, status: "archived" });
  await post(request, `/api/companies/${company.id}/routines`, { title: "Unscoped routine", projectId: null });
  return { company, alpha, empty };
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
  test(`project Configuration tab lists the project's routines (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const errors = collectConsoleErrors(page);
    const { company, alpha, empty } = await seed(page.request);

    await page.goto(`/${company.issuePrefix}/projects/${alpha.urlKey}/configuration`);
    const section = page.getByRole("region", { name: "Routines" });
    await expect(section.getByText("Nightly triage")).toBeVisible();
    await expect(section.getByText(/Weekly dependency sweep/)).toBeVisible();
    await expect(section.getByText("Unscoped routine")).toHaveCount(0);
    await expect(section.getByText("Old sync")).toHaveCount(0);
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth, "no horizontal page scroll").toBeLessThanOrEqual(viewport.width);
    if (SCREENSHOT_DIR) await section.screenshot({ path: `${SCREENSHOT_DIR}/project-routines-${viewport.name}.png` });

    await section.getByRole("button", { name: "Show archived (1)" }).click();
    await expect(section.getByText("Old sync")).toBeVisible();
    await section.getByRole("button", { name: "Hide archived" }).click();
    await expect(section.getByText("Old sync")).toHaveCount(0);

    await section.getByText("Nightly triage").click();
    await expect(page).toHaveURL(/\/routines\/[0-9a-f-]+\/overview$/);
    await page.goBack();
    await expect(section.getByText("Nightly triage")).toBeVisible();

    await section.getByRole("button", { name: "Edit Nightly triage" }).click();
    const editor = page.getByRole("dialog");
    await expect(editor.getByText("Edit routine")).toBeVisible();
    const editorTitle = editor.getByRole("textbox", { name: "Routine title" });
    await expect(editorTitle).toHaveValue("Nightly triage");
    await expect(editor.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await editorTitle.fill("Morning triage");
    if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/project-routines-editor-${viewport.name}.png` });
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor).toHaveCount(0);
    await expect(section.getByText("Morning triage")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${alpha.urlKey}/configuration$`));
    await page.reload();
    await expect(section.getByText("Morning triage")).toBeVisible();
    await expect(section.getByText("Nightly triage")).toHaveCount(0);

    await page.goto(`/${company.issuePrefix}/projects/${empty.urlKey}/configuration`);
    await expect(section.getByText("No routines in this project yet.")).toBeVisible();
    if (SCREENSHOT_DIR) await section.screenshot({ path: `${SCREENSHOT_DIR}/project-routines-empty-${viewport.name}.png` });
    await section.getByRole("button", { name: "New routine" }).click();
    const composer = page.getByRole("dialog");
    await expect(composer.getByText("New routine")).toBeVisible();
    await expect(composer.getByText("Empty project")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${empty.urlKey}/configuration$`));
    if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/project-routines-composer-${viewport.name}.png` });
    await composer.getByRole("textbox", { name: "Routine title" }).fill("Release notes digest");
    await composer.getByRole("button", { name: "Create routine" }).click();
    await expect(composer).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/projects/${empty.urlKey}/configuration$`));
    await expect(section.getByText("Release notes digest")).toBeVisible();
    await expect(page.getByRole("link", { name: "Add a trigger" })).toBeVisible();

    const created = await page.request.get(`/api/companies/${company.id}/routines?projectId=${empty.id}`);
    expect(((await created.json()) as Array<{ title: string }>).map((routine) => routine.title)).toEqual(["Release notes digest"]);

    expect(errors).toEqual([]);
  });

  test(`a stale edit on the project page says someone else saved first (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const errors = collectConsoleErrors(page);
    const { company, alpha } = await seed(page.request);
    const routines = await page.request.get(`/api/companies/${company.id}/routines?projectId=${alpha.id}`);
    const nightly = ((await routines.json()) as Array<{ id: string; title: string }>).find((routine) => routine.title === "Nightly triage")!;

    await page.goto(`/${company.issuePrefix}/projects/${alpha.urlKey}/configuration`);
    const section = page.getByRole("region", { name: "Routines" });
    await section.getByRole("button", { name: "Edit Nightly triage" }).click();
    const editor = page.getByRole("dialog");
    await editor.getByRole("textbox", { name: "Routine title" }).fill("Edited in the dialog");

    const concurrent = await page.request.patch(`/api/routines/${nightly.id}`, { data: { title: "Edited elsewhere" } });
    expect(concurrent.ok()).toBe(true);

    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor.getByRole("alert")).toContainText("Someone else saved this routine");
    await editor.getByRole("button", { name: "Cancel" }).click();
    await expect(section.getByText("Edited elsewhere")).toBeVisible();

    await section.getByRole("button", { name: "Edit Edited elsewhere" }).click();
    const reopened = page.getByRole("dialog");
    await expect(reopened.getByRole("textbox", { name: "Routine title" })).toHaveValue("Edited elsewhere");
    await expect(reopened.getByRole("alert")).toHaveCount(0);

    await reopened.getByRole("textbox", { name: "Routine title" }).fill("Edited after the conflict");
    await reopened.getByRole("button", { name: "Save changes" }).click();
    await expect(section.getByText("Edited after the conflict")).toBeVisible();

    // The failed save logs its 409 response; nothing else may.
    expect(errors.filter((line) => !line.includes("409"))).toEqual([]);
  });
}
