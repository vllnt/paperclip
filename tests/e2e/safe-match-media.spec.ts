import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

interface Fixture {
  prefix: string;
  issueIdentifier: string;
}

async function createFixture(page: Page): Promise<Fixture> {
  const response = await page.request.post("/api/companies", { data: { name: `Media query ${Date.now()}` } });
  expect(response.ok(), `create company failed ${response.status()}: ${await response.text()}`).toBe(true);
  const company = await response.json();

  const agent = await page.request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Media query fixture",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: { engine: "acp", cwd: "/tmp", agentCommand: "true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    },
  });
  expect(agent.ok(), `create agent failed ${agent.status()}: ${await agent.text()}`).toBe(true);
  const issue = await page.request.post(`/api/companies/${company.id}/issues`, {
    data: { title: "Media query fixture task", status: "backlog", priority: "medium" },
  });
  expect(issue.ok(), `create issue failed ${issue.status()}: ${await issue.text()}`).toBe(true);

  return { prefix: company.issuePrefix, issueIdentifier: (await issue.json()).identifier };
}

/** Some embedded webviews expose `window.matchMedia` but throw when it is called. */
async function makeMatchMediaThrow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error("matchMedia failed (injected by the test)");
      },
    });
  });
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function expectAppRendered(page: Page, route: string): Promise<void> {
  await expect(page.locator("main, [role=main]").first(), `${route} renders its main region`).toBeVisible();
  await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
}

for (const viewport of VIEWPORTS) {
  test.describe(`with window.matchMedia throwing at ${viewport.name} width`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await makeMatchMediaThrow(page);
    });

    test("the board pages still render and a new task can be started", async ({ page }) => {
      test.setTimeout(180_000);
      const fixture = await createFixture(page);
      const errors = collectBrowserErrors(page);

      for (const route of ["dashboard", "issues", `issues/${fixture.issueIdentifier}`, "agents", "routines"]) {
        await page.goto(`/${fixture.prefix}/${route}`);
        await expectAppRendered(page, route);
      }

      await page.goto(`/${fixture.prefix}/dashboard`);
      await expectAppRendered(page, "dashboard");
      if (viewport.name === "phone") await page.getByRole("button", { name: "Open sidebar" }).click();
      await page.getByRole("button", { name: "New Task" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();

      expect(errors, "page and console errors").toEqual([]);
    });

    test("the signed-out sign-in page still renders", async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await page.route("**/api/health", (route) =>
        route.fulfill({
          json: { status: "ok", deploymentMode: "authenticated", deploymentExposure: "private", authReady: true, bootstrapStatus: "ready" },
        }),
      );
      await page.route("**/api/auth/get-session", (route) => route.fulfill({ json: null }));

      await page.goto("/auth");
      await expect(page.getByRole("heading", { name: "Sign in to Paperclip" })).toBeVisible();
      await expect(page.getByRole("radiogroup", { name: "Appearance" })).toBeVisible();
      expect(errors, "page and console errors").toEqual([]);
    });

    test("the design guide, which mounts the media-query components, still renders", async ({ page }) => {
      const fixture = await createFixture(page);
      const errors = collectBrowserErrors(page);

      await page.goto(`/${fixture.prefix}/design-guide`);
      await expect(page.getByText("StatusBadge (all statuses)").first()).toBeVisible();

      // The page's demo data logs a 404 and two 500s for resources that do not exist; those are not under test.
      const unexpected = errors.filter((error) => !error.startsWith("console: Failed to load resource"));
      expect(unexpected, "page and console errors").toEqual([]);
    });
  });
}
