import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * The project Configuration tab lists the routines that belong to the project, hides archived ones
 * until asked, and offers a New routine link that opens the composer with the project chosen.
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

    await page.goto(`/${company.issuePrefix}/projects/${empty.urlKey}/configuration`);
    await expect(section.getByText("No routines in this project yet.")).toBeVisible();
    if (SCREENSHOT_DIR) await section.screenshot({ path: `${SCREENSHOT_DIR}/project-routines-empty-${viewport.name}.png` });
    await section.getByRole("link", { name: "New routine" }).click();
    await expect(page).toHaveURL(new RegExp(`/routines$`));
    const composer = page.getByRole("dialog");
    await expect(composer).toBeVisible();
    await expect(composer.getByText("Empty project")).toBeVisible();
    if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/project-routines-composer-${viewport.name}.png` });

    expect(errors).toEqual([]);
  });
}
