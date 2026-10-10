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
      // Company search ranks the task, then the agent, then the project.
      const selected = page.locator("[cmdk-item][aria-selected='true']");
      await expect(selected).toContainText(seed.issueTitle);
      await page.keyboard.press("ArrowDown");
      await expect(selected).toContainText("Launcher Agent");
      await page.keyboard.press("ArrowUp");
      await expect(selected).toContainText(seed.issueTitle);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/issues/${seed.issueIdentifier}`));

      // No match: the launcher says so and stays open (the search page is gone).
      await openLauncher(page);
      await page.keyboard.type("qqxz nothing");
      await expect(page.getByTestId("command-search-empty")).toContainText("qqxz nothing");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // The cheatsheet lists the catalog chords.
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

    test("searches from the sidebar Search trigger, loads more and opens a result", async ({ page, request }) => {
      const seed = await seedCompany(request);
      for (let index = 1; index <= 24; index += 1) {
        await json(await request.post(`/api/companies/${seed.companyId}/issues`, {
          data: { title: `Zircon rollout step ${index}`, status: "todo" },
        }));
      }
      const errors = trackPageErrors(page);
      await page.goto(`/${seed.prefix}/dashboard`);
      await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "New Task", exact: true }).and(page.locator("aside button"))).toHaveCount(0);

      if (viewport.name === "mobile") {
        await page.getByRole("button", { name: "Open sidebar" }).click();
      }
      const trigger = page.locator("button[data-sidebar-search-trigger]");
      await expect(trigger).toBeVisible();
      await expect(trigger).toContainText(/⌘K|Ctrl K/);
      await trigger.click();
      const input = page.getByRole("combobox", { name: "Command launcher" });
      await expect(input).toBeFocused();

      await page.keyboard.type("zircon");
      const results = page.getByTestId("command-search-result");
      await expect(results).toHaveCount(20);
      await page.getByTestId("command-search-more").click();
      await expect(results).toHaveCount(24);

      // Escape returns focus to the trigger. On phones the launcher closes the
      // sidebar when it opens, so focus falls back to the page.
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      if (viewport.name === "mobile") await expect(page.locator("#main-content")).toBeFocused();
      else await expect(trigger).toBeFocused();

      await page.keyboard.press("ControlOrMeta+k");
      await expect(input).toBeFocused();
      await page.keyboard.type("zircon rollout step 7");
      await expect(page.getByRole("option").first()).toContainText("Zircon rollout step 7");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/issues/`));
      await expect(page.locator("#main-content").getByText("Zircon rollout step 7").first()).toBeVisible();

      expect(errors).toEqual([]);
    });

    test("creates a task from the launcher", async ({ page, request }) => {
      const seed = await seedCompany(request);
      const errors = trackPageErrors(page);
      await page.goto(`/${seed.prefix}/dashboard`);
      await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
      await page.locator("#main-content").focus();

      await openLauncher(page);
      await expect(page.getByRole("option").first()).toContainText("Create new task");
      await page.keyboard.press("Enter");
      await expect(page.getByPlaceholder("Task title")).toBeVisible();

      expect(errors).toEqual([]);
    });

    test("opens an old /search link as the launcher with its query filled in", async ({ page, request }) => {
      const seed = await seedCompany(request);
      const errors = trackPageErrors(page);
      await page.goto(`/${seed.prefix}/search?q=zircon&status=todo&sort=updated`);

      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/dashboard`));
      const input = page.getByRole("combobox", { name: "Command launcher" });
      await expect(input).toBeVisible();
      await expect(input).toHaveValue("zircon status:todo sort:updated");

      expect(errors).toEqual([]);
    });

    test("asks for words when only scope: or sort: is typed, then searches with them", async ({ page, request }) => {
      const seed = await seedCompany(request);
      const errors = trackPageErrors(page);
      const searches: string[] = [];
      page.on("request", (sent) => {
        const url = new URL(sent.url());
        if (/\/api\/companies\/[^/]+\/search$/.test(url.pathname)) searches.push(url.search);
      });
      await page.goto(`/${seed.prefix}/dashboard`);
      await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
      await page.locator("#main-content").focus();

      const input = await openLauncher(page);
      await input.fill("scope:issues sort:updated");
      await expect(page.getByTestId("command-search-hint")).toContainText("Add words or a filter");
      // Past the debounce, still no request.
      await page.waitForTimeout(500);
      expect(searches).toEqual([]);

      await input.fill("scope:issues sort:updated launcher keyboard");
      await expect(page.getByTestId("command-search-hint")).toHaveCount(0);
      await expect(page.getByRole("option").first()).toContainText(seed.issueTitle);
      expect(searches).toHaveLength(1);
      const params = new URLSearchParams(searches[0]);
      expect([params.get("q"), params.get("scope"), params.get("sort")]).toEqual(["launcher keyboard", "issues", "updated"]);

      expect(errors).toEqual([]);
    });

    test("does not open a result of the previous query while the next search loads", async ({ page, request }) => {
      const seed = await seedCompany(request);
      const quasarTitle = `Quasar beta ${randomUUID().slice(0, 8)}`;
      const quasar = await json(await request.post(`/api/companies/${seed.companyId}/issues`, {
        data: { title: quasarTitle, status: "todo" },
      }));
      const errors = trackPageErrors(page);
      let release: () => void = () => {};
      const held = new Promise<void>((done) => {
        release = done;
      });
      await page.route(/\/api\/companies\/[^/]+\/search\?.*q=quasar/, async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(`/${seed.prefix}/dashboard`);
      await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
      await page.locator("#main-content").focus();

      const input = await openLauncher(page);
      await input.fill("launcher keyboard");
      const oldRow = page.getByRole("option").filter({ hasText: seed.issueTitle });
      await expect(oldRow).toHaveAttribute("aria-selected", "true");

      // The next search is held, so the old row is still on screen. Enter
      // must not open it.
      const quasarRequest = page.waitForRequest(/q=quasar/);
      await input.fill("quasar");
      await quasarRequest;
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/dashboard$`));
      await expect(input).toBeVisible();
      await expect(oldRow).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByRole("status").filter({ hasText: "Searching…" })).toBeVisible();

      release();
      await expect(oldRow).toHaveCount(0);
      await expect(page.getByRole("option").first()).toContainText(quasarTitle);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/issues/${quasar.identifier}$`));
      await expect(page.locator("#main-content").getByText(quasarTitle).first()).toBeVisible();

      expect(errors).toEqual([]);
    });

    test("keeps a row chosen with the arrow keys when search results arrive late", async ({ page, request }) => {
      const seed = await seedCompany(request);
      await json(await request.post(`/api/companies/${seed.companyId}/issues`, {
        data: { title: `Board cleanup ${randomUUID().slice(0, 8)}`, status: "todo" },
      }));
      const errors = trackPageErrors(page);
      let release: () => void = () => {};
      const held = new Promise<void>((done) => {
        release = done;
      });
      await page.route(/\/api\/companies\/[^/]+\/search\?.*q=board/, async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(`/${seed.prefix}/dashboard`);
      await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
      await page.locator("#main-content").focus();

      // "board" is inside "Keyboard shortcuts" and "Dashboard" and is a
      // keyword of "Tasks". None is a strong match, so the task results rank
      // above them once they arrive.
      const input = await openLauncher(page);
      await input.fill("board");
      const selected = page.locator("[role='option'][aria-selected='true']");
      await expect(selected).not.toContainText("Tasks");
      await expect(page.getByRole("option").filter({ hasText: "Tasks" })).toBeVisible();
      for (let press = 0; press < 5 && !(await selected.textContent())?.includes("Tasks"); press += 1) {
        await page.keyboard.press("ArrowDown");
      }
      await expect(selected).toContainText("Tasks");

      release();
      await expect(page.getByRole("option").first()).toContainText("Board cleanup");
      await expect(selected).toContainText("Tasks");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/issues$`));

      expect(errors).toEqual([]);
    });

    test("returns focus to where it was when the launcher closes without running anything", async ({ page, request }) => {
      const seed = await seedCompany(request);
      const errors = trackPageErrors(page);
      await page.goto(`/${seed.prefix}/dashboard`);
      await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);

      const main = page.locator("#main-content");
      await main.focus();
      await openLauncher(page);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(main).toBeFocused();

      // A focused control in the page gets focus back too. (Text fields keep
      // Cmd/Ctrl+K for themselves, so the launcher never opens from one.)
      const link = main.getByRole("link").first();
      await link.focus();
      await openLauncher(page);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(link).toBeFocused();

      expect(errors).toEqual([]);
    });

    test("does not open over an open popover", async ({ page, request }) => {
      const seed = await seedCompany(request);
      const errors = trackPageErrors(page);
      await page.goto(`/${seed.prefix}/dashboard`);
      await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
      // Records whether the last Cmd/Ctrl+K was claimed by any handler.
      await page.evaluate(() => {
        window.addEventListener("keydown", (event) => {
          if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
            document.documentElement.dataset.lastCommandKPrevented = String(event.defaultPrevented);
          }
        });
      });

      if (viewport.name === "mobile") {
        await page.getByRole("button", { name: "Open sidebar" }).focus();
        await page.keyboard.press("Enter");
      }
      const accountButton = page.getByRole("button", { name: "Open account menu" });
      await accountButton.focus();
      await page.keyboard.press("Enter");
      const viewProfile = page.getByRole("link", { name: "View profile" });
      await expect(viewProfile).toBeVisible();
      await viewProfile.focus();

      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByRole("combobox", { name: "Command launcher" })).toHaveCount(0);
      await expect(viewProfile).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.lastCommandKPrevented)).toBe("false");

      expect(errors).toEqual([]);
    });

    // Popper content Radix left mounted after it hid or closed, content that
    // does not render, and a DOM check that throws: none of them is an open
    // popup, so none may keep the launcher closed.
    for (const variant of ["hidden menu", "aria-hidden wrapper", "closed wrapper", "display none menu", "throwing check"] as const) {
      test(`opens over popper content that is not really open (${variant})`, async ({ page, request }) => {
        const seed = await seedCompany(request);
        const errors = trackPageErrors(page);
        await page.goto(`/${seed.prefix}/dashboard`);
        await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
        await page.evaluate((stale) => {
          const wrapper = document.createElement("div");
          wrapper.setAttribute("data-radix-popper-content-wrapper", "");
          const menu = document.createElement("div");
          menu.setAttribute("role", "menu");
          menu.setAttribute("data-state", "open");
          menu.textContent = "Stale menu item";
          if (stale === "hidden menu") menu.hidden = true;
          if (stale === "aria-hidden wrapper") wrapper.setAttribute("aria-hidden", "true");
          if (stale === "closed wrapper") wrapper.setAttribute("data-state", "closed");
          if (stale === "display none menu") menu.style.display = "none";
          if (stale === "throwing check") {
            Object.defineProperty(menu, "closest", {
              value: () => {
                throw new Error("DOM check failed");
              },
            });
          }
          wrapper.append(menu);
          document.body.append(wrapper);
        }, variant);

        await page.locator("#main-content").focus();
        await page.keyboard.press("ControlOrMeta+k");
        await expect(page.getByRole("combobox", { name: "Command launcher" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("combobox", { name: "Command launcher" })).toHaveCount(0);

        expect(errors).toEqual([]);
      });
    }

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
          await page.keyboard.type("open file");
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
