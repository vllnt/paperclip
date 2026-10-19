import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type Page } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

const CAPPED_RESPONSE = {
  status: 429,
  headers: { "content-type": "application/json", "retry-after": "1" },
  body: JSON.stringify({
    error: "Too many concurrent issue-list requests for this actor/client",
    retryAfterSeconds: 1,
  }),
};

// The server's per-client in-flight cap can answer 429 for whichever list
// requests of a board load arrive last; here: the task list and the Done column.
async function capTaskListAndDoneColumn(page: Page) {
  let capping = true;
  await page.route(/\/api\/companies\/[^/]+\/issues\?/, async (route) => {
    const url = decodeURIComponent(route.request().url());
    const capped = url.includes("sortField=updated") || /[?&]status=done(&|$)/.test(url);
    if (capping && capped) return route.fulfill(CAPPED_RESPONSE);
    return route.continue();
  });
  return () => {
    capping = false;
  };
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`board view keeps loaded columns visible when some list requests are rejected (${viewport.name})`, async ({ page, request }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    const company = await json(await request.post("/api/companies", {
      data: { name: `Board Loading ${randomUUID().slice(0, 8)}` },
    }));
    for (const [title, status] of [
      ["Board backlog card", "backlog"],
      ["Board todo card", "todo"],
      ["Board done card", "done"],
    ] as const) {
      await json(await request.post(`/api/companies/${company.id}/issues`, { data: { title, status } }));
    }

    await page.goto(`/${company.issuePrefix}/issues`);
    await page.getByRole("button", { name: "Board view" }).click();
    await expect(page.getByText("Board done card")).toBeVisible();

    const releaseCap = await capTaskListAndDoneColumn(page);
    await page.reload();

    const todoColumn = page.locator("[data-kanban-status='todo']");
    const doneColumn = page.locator("[data-kanban-status='done']");
    await expect(todoColumn.getByText("Board todo card")).toBeVisible();
    // The rejected Done column says so instead of claiming zero tasks.
    await expect(doneColumn.getByRole("alert")).toContainText("Couldn’t load done tasks.", { timeout: 20_000 });
    await expect(doneColumn.locator("[data-kanban-count]")).toHaveText("–");
    // No list-shaped skeleton or task-list error is painted over the board.
    await expect(page.locator("[data-slot='skeleton'].rounded-none")).toHaveCount(0);
    await expect(page.getByText("Too many concurrent issue-list requests")).toHaveCount(0);

    releaseCap();
    await doneColumn.getByRole("button", { name: "Retry" }).click();
    await expect(doneColumn.getByText("Board done card")).toBeVisible();
    await expect(doneColumn.locator("[data-kanban-count]")).toHaveText("1");
    await expect(doneColumn).toHaveAttribute("data-kanban-state", "ready");
    expect(consoleErrors).toEqual([]);
  });
}
