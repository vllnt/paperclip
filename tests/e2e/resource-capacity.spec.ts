import { expect, test, type Page } from "@playwright/test";

/**
 * Resource capacity on the web: an instance admin opens the settings page
 * from the sidebar and sees this server's level and numbers, then sees the
 * same line on the environment the company's agent runs on. The e2e server
 * is `local_trusted`, so the board is an instance admin. The non-admin 403
 * and the company isolation are covered by the route and page unit tests.
 */

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`CONSOLE: ${msg.text().slice(0, 300)}`);
  });
  return errors;
}

test("an instance admin reads server and environment capacity from settings", async ({ page }) => {
  const errors = collectErrors(page);

  const experimental = await page.request.get("/api/instance/settings/experimental");
  expect(experimental.ok()).toBe(true);
  const environmentsWereEnabled = (await experimental.json()).enableEnvironments === true;
  const enable = await page.request.patch("/api/instance/settings/experimental", {
    data: { enableEnvironments: true },
  });
  expect(enable.ok(), `enable environments failed ${enable.status()}`).toBe(true);

  try {
    const companyRes = await page.request.post("/api/companies", { data: { name: "Capacity E2E" } });
    expect(companyRes.ok(), `create company failed ${companyRes.status()}`).toBe(true);
    const company = await companyRes.json();
    const agentRes = await page.request.post(`/api/companies/${company.id}/agents`, {
      data: { name: "Capacity Agent", role: "engineer", adapterType: "process", adapterConfig: { command: "true" } },
    });
    expect(agentRes.ok(), `create agent failed ${agentRes.status()}`).toBe(true);

    await page.goto(`/${company.issuePrefix}/company/settings`);
    await page.getByRole("link", { name: "Resource capacity" }).click();

    await expect(page).toHaveURL(/\/company\/settings\/instance\/resource-capacity$/);
    await expect(page.getByRole("heading", { name: "Resource capacity" })).toBeVisible();
    await expect(page.getByText("this server")).toBeVisible();
    // The sampler records this host when the server starts.
    await expect(page.getByText(/disk data.*free .* · memory .* available · load .*\/core · sampled/).first()).toBeVisible();
    await expect(page.getByText("Local · local")).toBeVisible();

    await page.getByRole("link", { name: "Environments" }).click();
    await expect(page).toHaveURL(/\/company\/settings\/instance\/environments$/);
    await expect(page.getByText(/disk workspaces .* free .* · sampled/)).toBeVisible();

    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`/${company.issuePrefix}/company/settings/instance/resource-capacity`);
    await expect(page.getByRole("heading", { name: "Resource capacity" })).toBeVisible();
    await expect(page.getByText("Local · local")).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await page.request.patch("/api/instance/settings/experimental", {
      data: { enableEnvironments: environmentsWereEnabled },
    });
  }
});
