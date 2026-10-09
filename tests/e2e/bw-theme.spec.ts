import { expect, test, type Page } from "@playwright/test";

const STORAGE_KEY = "paperclip.theme";
const PURE_BLACK = /^(oklch\(0 0 0\)|rgb\(0, 0, 0\))$/;
const PURE_WHITE = /^(oklch\(1 0 0\)|rgb\(255, 255, 255\))$/;
const LARGE_SURFACE_AREA = 40_000;
const MAX_GREY_SPREAD = 24;

async function createCompanyPrefix(page: Page): Promise<string> {
  const response = await page.request.post("/api/companies", {
    data: { name: `BW theme ${Date.now()}` },
  });
  expect(response.ok(), `create company failed ${response.status()}: ${await response.text()}`).toBe(true);
  const company = await response.json();

  const agent = await page.request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Theme fixture",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: { engine: "acp", cwd: "/tmp", agentCommand: "true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    },
  });
  expect(agent.ok(), `create agent failed ${agent.status()}: ${await agent.text()}`).toBe(true);
  const issue = await page.request.post(`/api/companies/${company.id}/issues`, {
    data: { title: "Theme fixture task", status: "backlog", priority: "medium" },
  });
  expect(issue.ok(), `create issue failed ${issue.status()}: ${await issue.text()}`).toBe(true);

  return company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";
}

async function expectRealPageNotOnboarding(page: Page): Promise<void> {
  await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
}

async function bodyColors(page: Page): Promise<{ background: string; color: string }> {
  return page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return { background: style.backgroundColor, color: style.color };
  });
}

/**
 * Lists large elements (cards, panels, sidebars) whose fill, composited over
 * the page colour, is nearly neutral but not pure black or pure white. A
 * translucent grey counts the same as an opaque one. Loading skeletons are
 * skipped: they need a quiet fill to be visible. Colours are normalised
 * through a canvas so any CSS colour syntax (oklch, color-mix, rgb) is read the
 * same way.
 */
async function largeGreySurfaces(page: Page, minArea: number, maxSpread: number): Promise<string[]> {
  return page.evaluate(
    ({ minArea: area, maxSpread: spread }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("no 2d canvas context");
      const read = (cssColor: string): number[] => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = "#000000";
        context.fillStyle = cssColor;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      };
      const [pageRed, pageGreen, pageBlue] = read(getComputedStyle(document.body).backgroundColor);
      const offenders: string[] = [];
      for (const element of document.querySelectorAll("body *")) {
        const rect = element.getBoundingClientRect();
        if (rect.width * rect.height < area) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.backgroundImage !== "none") continue;
        if (element.closest('[data-slot="skeleton"]')) continue;
        const [fillRed, fillGreen, fillBlue, fillAlpha] = read(style.backgroundColor);
        if (fillAlpha < 5) continue;
        const weight = fillAlpha / 255;
        const red = Math.round(pageRed + (fillRed - pageRed) * weight);
        const green = Math.round(pageGreen + (fillGreen - pageGreen) * weight);
        const blue = Math.round(pageBlue + (fillBlue - pageBlue) * weight);
        const pure = (red <= 2 && green <= 2 && blue <= 2) || (red >= 253 && green >= 253 && blue >= 253);
        const neutral = Math.max(red, green, blue) - Math.min(red, green, blue) <= spread;
        if (neutral && !pure) {
          offenders.push(`${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)} rgb(${red},${green},${blue})`);
        }
      }
      return offenders;
    },
    { minArea, maxSpread },
  );
}

async function installFirstPaintProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (!document.body) return;
      Reflect.set(window, "__themeWhenBodyCreated", document.documentElement.className);
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
}

async function openAccountMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open account menu" }).click();
  await expect(page.getByRole("radiogroup", { name: "Appearance" })).toBeVisible();
}

for (const scheme of ["dark", "light"] as const) {
  test(`System follows the ${scheme} OS and paints pure surfaces with no grey panels`, async ({ page }) => {
    const prefix = await createCompanyPrefix(page);
    await page.emulateMedia({ colorScheme: scheme });

    for (const route of ["dashboard", "issues", "agents", "routines"]) {
      await page.goto(`/${prefix}/${route}`);
      await expect(page.locator("main, [role=main], #root > *").first()).toBeVisible();
      await expectRealPageNotOnboarding(page);
      await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b).*$/);

      const colors = await bodyColors(page);
      expect(colors.background, `${route} background`).toMatch(scheme === "dark" ? PURE_BLACK : PURE_WHITE);
      expect(colors.color, `${route} text`).toMatch(scheme === "dark" ? PURE_WHITE : PURE_BLACK);
      expect(await largeGreySurfaces(page, LARGE_SURFACE_AREA, MAX_GREY_SPREAD), `${route} grey panels`).toEqual([]);
    }
  });
}

test("a pinned choice beats the OS, persists, and reloads without painting the wrong theme", async ({ page }) => {
  const prefix = await createCompanyPrefix(page);
  await installFirstPaintProbe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/${prefix}/dashboard`);
  await expectRealPageNotOnboarding(page);
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();

  await openAccountMenu(page);
  await page.locator('label[title="Light"]').click();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe("light");
  expect((await bodyColors(page)).background).toMatch(PURE_WHITE);

  await page.reload();
  const classWhenBodyCreated: unknown = await page.evaluate(() => Reflect.get(window, "__themeWhenBodyCreated"));
  expect(classWhenBodyCreated, "html class when <body> is created, before React runs").toBe("");
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);

  await openAccountMenu(page);
  await expect(page.locator('input[aria-label="Light"]')).toBeChecked();
  await page.locator('label[title="System"]').click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
});

test("System tracks an OS change mid-session, and Dark stays dark when the OS flips", async ({ page }) => {
  const prefix = await createCompanyPrefix(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`/${prefix}/dashboard`);
  await expectRealPageNotOnboarding(page);
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);

  await openAccountMenu(page);
  await page.locator('label[title="Dark"]').click();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
});

test("the mode switch works at a phone width through the sidebar drawer", async ({ page }) => {
  const prefix = await createCompanyPrefix(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`/${prefix}/dashboard`);
  await expectRealPageNotOnboarding(page);

  await page.getByRole("button", { name: "Open sidebar" }).click();
  await openAccountMenu(page);
  await page.locator('label[title="Dark"]').click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  expect((await bodyColors(page)).background).toMatch(PURE_BLACK);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
