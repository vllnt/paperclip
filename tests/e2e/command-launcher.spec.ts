import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

/**
 * E2E: the Cmd/Ctrl+K command launcher and the `g` chords, driven by the
 * keyboard only. Every step presses keys; nothing is clicked.
 */

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

interface Seed {
  companyId: string;
  prefix: string;
  projectName: string;
  issueIdentifier: string;
  issueTitle: string;
}

async function seedCompany(request: APIRequestContext): Promise<Seed> {
  const suffix = randomUUID().slice(0, 8);
  const company = await json(await request.post("/api/companies", { data: { name: `Launcher ${suffix}` } }));
  // An agent keeps the onboarding wizard from covering every page.
  await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Launcher Agent", role: "engineer",
      adapterType: "codex_local", adapterConfig: { model: "gpt-6-sol" },
      runtimeConfig: { heartbeat: { enabled: false } },
    },
  }));
  const projectName = `Zephyr launcher ${suffix}`;
  await json(await request.post(`/api/companies/${company.id}/projects`, { data: { name: projectName } }));
  const issueTitle = `Launcher keyboard task ${suffix}`;
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: issueTitle, status: "todo" },
  }));
  return { companyId: company.id, prefix: company.issuePrefix, projectName, issueIdentifier: issue.identifier, issueTitle };
}

// Known server behaviour, not this feature: issue detail probes for a "plan"
// document that most issues do not have, and the probe answers 404.
const KNOWN_HTTP_ERRORS = [/\/api\/issues\/[^/]+\/documents\/plan$/];

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  // HTTP failures are tracked by URL below; Chrome also echoes each one as a
  // URL-less "Failed to load resource" console error.
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    if (KNOWN_HTTP_ERRORS.some((pattern) => pattern.test(url.pathname))) return;
    errors.push(`HTTP ${response.status()} ${url.pathname}`);
  });
  return errors;
}

async function openLauncher(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  // Screen readers get a named combobox (the browser computes the name).
  const input = page.getByRole("combobox", { name: "Command launcher" });
  await expect(input).toBeFocused();
  return input;
}

async function pressChord(page: Page, second: string) {
  await page.keyboard.press("g");
  await page.keyboard.press(second);
}

for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
  test.describe(`command launcher (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("runs actions, entities, search and chords from the keyboard", async ({ page, request }) => {
      const seed = await seedCompany(request);
      const errors = trackPageErrors(page);
      await page.goto(`/${seed.prefix}/dashboard`);
      await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
      await expect(page.locator("#main-content")).toBeVisible();

      // An action whose title starts with the query is the first row; Enter runs it.
      await openLauncher(page);
      await page.keyboard.type("agen");
      await expect(page.getByRole("option").first()).toContainText("Agents");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/agents`));
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // The used action comes back under Recent.
      await openLauncher(page);
      await expect(page.getByRole("group", { name: "Recent" }).getByRole("option").first()).toContainText("Agents");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // Chords navigate without the launcher.
      await page.locator("#main-content").focus();
      await pressChord(page, "d");
      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/dashboard`));
      await pressChord(page, "p");
      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/projects`));

      // An entity match: the project, by a prefix of its name.
      await openLauncher(page);
      await page.keyboard.type("zephyr");
      await expect(page.getByRole("option").first()).toContainText(seed.projectName);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/projects/`));

      // Arrow keys move the selection between rows; Enter runs the selected row.
      await openLauncher(page);
      await page.keyboard.type("launcher");
      const taskRow = page.getByRole("option", { name: new RegExp(seed.issueTitle) });
      await expect(taskRow).toBeVisible();
      const selected = page.locator("[cmdk-item][aria-selected='true']");
      await expect(selected).toContainText(seed.projectName);
      await page.keyboard.press("ArrowDown");
      await expect(selected).toContainText(seed.issueTitle);
      await page.keyboard.press("ArrowUp");
      await expect(selected).toContainText(seed.projectName);
      await page.keyboard.press("ArrowDown");
      await expect(selected).toContainText(seed.issueTitle);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/issues/${seed.issueIdentifier}`));

      // No local match: Enter hands the query to the full search page.
      await openLauncher(page);
      await page.keyboard.type("qqxz nothing");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/search\\?q=qqxz\\+nothing`));

      // The cheatsheet lists the catalog chords. The search page focuses its
      // own input on arrival; wait for that before moving focus off it.
      await expect(page.getByRole("textbox", { name: "Search query" })).toBeFocused();
      await page.locator("#main-content").focus();
      await page.keyboard.press("?");
      const cheatsheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      await expect(cheatsheet).toBeVisible();
      await expect(cheatsheet.getByRole("heading", { name: "Go to" })).toBeVisible();
      await expect(cheatsheet.locator("[data-shortcut-row]").filter({ hasText: "Approvals" })).toContainText("v");
      // The sheet fits the viewport, and its list scrolls to the last row.
      const box = await cheatsheet.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      const lastRow = cheatsheet.locator("[data-shortcut-row]").last();
      await lastRow.scrollIntoViewIfNeeded();
      await expect(lastRow).toBeInViewport();
      await page.keyboard.press("Escape");
      await expect(cheatsheet).toBeHidden();

      expect(errors).toEqual([]);
    });

    test("lists the issue page's own actions under This view", async ({ page, request }) => {
      const seed = await seedCompany(request);
      const errors = trackPageErrors(page);
      await page.goto(`/${seed.prefix}/issues/${seed.issueIdentifier}`);
      await expect(page.locator("#main-content").getByText(seed.issueTitle).first()).toBeVisible({ timeout: 30_000 });

      // Inside the issue's editor the key belongs to the editor, not the launcher.
      const editor = page.locator("#main-content [contenteditable='true']").first();
      await editor.focus();
      await expect(editor).toBeFocused();
      await page.keyboard.press("ControlOrMeta+k");
      // The launcher stays closed; the editor may run its own Cmd/Ctrl+K
      // (its link dialog), which Escape closes.
      await expect(page.getByRole("combobox", { name: "Command launcher" })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.locator("#main-content").focus();

      await openLauncher(page);
      const thisView = page.getByRole("group", { name: "This view" });
      await expect(thisView.getByRole("option", { name: /Archive from inbox/ })).toBeVisible();
      // The file action needs the experimental file viewer, which is off.
      await expect(page.getByRole("option", { name: /Open file in this issue/ })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // Away from the issue, the page's actions are gone.
      await page.locator("#main-content").focus();
      await pressChord(page, "d");
      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/dashboard`));
      await openLauncher(page);
      await expect(page.getByRole("group", { name: "This view" })).toHaveCount(0);
      await expect(page.getByRole("option", { name: /Archive from inbox/ })).toHaveCount(0);

      expect(errors).toEqual([]);
    });

    test("offers the file viewer where it can open when the experimental flag is on", async ({ page, request }) => {
      const seed = await seedCompany(request);
      const before = await json(await request.get("/api/instance/settings/experimental"));
      await json(await request.patch("/api/instance/settings/experimental", { data: { enableExperimentalFileViewer: true } }));
      try {
        const errors = trackPageErrors(page);
        await page.goto(`/${seed.prefix}/issues/${seed.issueIdentifier}`);
        await expect(page.locator("#main-content").getByText(seed.issueTitle).first()).toBeVisible({ timeout: 30_000 });

        await openLauncher(page);
        if (viewport.name === "mobile") {
          // The file browser opens in the side panel, which phones do not show,
          // so the launcher does not offer an action that would do nothing.
          await expect(page.getByRole("option", { name: /Open file in this issue/ })).toHaveCount(0);
        } else {
          await expect(page.getByRole("option").first()).toContainText("Open file in this issue");
          await page.keyboard.press("Enter");
          await expect(page.getByRole("dialog", { name: /Command/ })).toHaveCount(0);
          await expect(page.getByLabel("Search workspace files")).toBeFocused();
        }

        expect(errors).toEqual([]);
      } finally {
        await request.patch("/api/instance/settings/experimental", {
          data: { enableExperimentalFileViewer: before.enableExperimentalFileViewer === true },
        });
      }
    });
  });
}
