import { expect, test, type APIResponse, type Page } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`CONSOLE: ${msg.text()}`);
  });
  return errors;
}

test("an owner restricts a project, manages its access list, and the list persists", async ({ page, request }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const company = await json(await request.post("/api/companies", { data: { name: `Project access ${Date.now()}` } }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
    name: "Access fixture agent", role: "engineer", adapterType: "process",
    adapterConfig: { command: "/usr/bin/true" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  } }));
  const project = await json(await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Access acceptance" } }));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${company.issuePrefix}/projects/${project.urlKey}/configuration`);
  const section = page.getByRole("region", { name: "Access", exact: true });
  await section.scrollIntoViewIfNeeded();
  const agentRow = section.getByTestId("project-access-row").filter({ hasText: "Access fixture agent" });

  // Company mode: every company agent can reach the project.
  await expect(section.getByTestId("project-access-mode")).toContainText("Open to company");
  await expect(agentRow).toContainText("Company");
  await expect(section.getByTestId("project-access-enforcement-note")).toHaveCount(0);

  // Restricting removes the unlisted agent and says enforcement is not on yet.
  await section.getByTestId("project-access-mode").click();
  await page.getByRole("option", { name: "Restricted", exact: true }).click();
  await expect(section.getByTestId("project-access-mode")).toContainText("Restricted");
  await expect(section.getByTestId("project-access-enforcement-note")).toContainText("Not enforced yet");
  await expect(agentRow).toHaveCount(0);

  // Adding the agent puts it back with the access-list reason, and it survives a reload.
  await section.getByTestId("project-access-add").click();
  await page.getByPlaceholder("Search users and agents").fill("Access fixture");
  await page.getByRole("button", { name: "Access fixture agent (agent)", exact: true }).click();
  await expect(agentRow).toContainText("Access list");
  await section.screenshot({ path: test.info().outputPath("project-access-desktop.png") });
  await page.reload();
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByTestId("project-access-mode")).toContainText("Restricted");
  await expect(agentRow).toContainText("Access list");

  const persisted = await json(await request.get(`/api/projects/${project.id}/access`));
  expect(persisted.accessMode).toBe("restricted");
  expect(persisted.principals).toEqual(expect.arrayContaining([
    expect.objectContaining({ principalType: "agent", principalId: agent.id, sources: ["explicit"] }),
  ]));

  // Removing it from the list takes it out again.
  await section.getByRole("button", { name: "Remove Access fixture agent from the access list", exact: true }).click();
  await expect(agentRow).toHaveCount(0);
  const afterRemove = await json(await request.get(`/api/projects/${project.id}/access`));
  expect(afterRemove.principals.some((p: { principalId: string }) => p.principalId === agent.id)).toBe(false);

  // Mobile: the section fits without horizontal scrolling.
  await page.setViewportSize({ width: 375, height: 667 });
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByTestId("project-access-mode")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("project-access-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  expect(errors).toEqual([]);
});

test("a failed access change shows the error and leaves the mode unchanged", async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await json(await request.post("/api/companies", { data: { name: `Project access error ${Date.now()}` } }));
  const project = await json(await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Access failure" } }));
  await page.route(`**/api/projects/${project.id}/access/mode**`, (route) =>
    route.fulfill({ status: 403, json: { error: "Company admin access required" } }));

  await page.goto(`/${company.issuePrefix}/projects/${project.urlKey}/configuration`);
  const section = page.getByRole("region", { name: "Access", exact: true });
  await section.scrollIntoViewIfNeeded();
  await section.getByTestId("project-access-mode").click();
  await page.getByRole("option", { name: "Restricted", exact: true }).click();
  await expect(section.getByRole("alert")).toContainText("Company admin access required");
  await expect(section.getByTestId("project-access-mode")).toContainText("Open to company");
  const persisted = await json(await request.get(`/api/projects/${project.id}/access`));
  expect(persisted.accessMode).toBe("company");
});
