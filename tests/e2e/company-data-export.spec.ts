import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/**
 * Company Settings → Data export: a board user downloads the company's run
 * history (company archive format v1) from the web UI, the same export the
 * API and `paperclipai archive export` provide.
 */

async function createCompany(page: Page, name: string): Promise<{ id: string; prefix: string }> {
  const res = await page.request.post("/api/companies", { data: { name } });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return { id: company.id, prefix: company.issuePrefix ?? company.prefix };
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`CONSOLE: ${msg.text().slice(0, 300)}`);
  });
  return errors;
}

test("board user downloads the company data export from settings", async ({ page }) => {
  const errors = collectConsoleErrors(page);
  const company = await createCompany(page, "Data Export E2E");

  await page.goto(`/${company.prefix}/company/settings`);
  const section = page.getByTestId("company-settings-data-export-section");
  await expect(section).toBeVisible();
  await expect(section).toContainText("Data export");

  // Narrow the export: no transcripts, runs finished since a date.
  await section.getByTestId("company-data-export-include-transcript").click();
  await section.getByTestId("company-data-export-since").fill("2026-01-01");
  const link = section.getByTestId("company-data-export-download");
  await expect(link).toHaveAttribute(
    "href",
    `/api/companies/${company.id}/archive/export?follow=true&include=run%2Cevents%2Ccosts%2Cactivity&since=2026-01-01T00%3A00%3A00.000Z`,
  );

  const downloadPromise = page.waitForEvent("download");
  await link.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`paperclip-archive-${company.id}.ndjson`);
  const file = await download.path();
  const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(lines[0]).toMatchObject({
    kind: "export.header",
    v: 1,
    companyId: company.id,
    data: { include: ["run", "events", "costs", "activity"], since: "2026-01-01T00:00:00.000Z", follow: true },
  });
  expect(lines.at(-1)).toMatchObject({ kind: "export.end", data: { next: null } });

  // The download is audited.
  const activity = await page.request.get(`/api/companies/${company.id}/activity?entityType=company`);
  expect(activity.ok()).toBe(true);
  expect(await activity.json()).toEqual(
    expect.arrayContaining([expect.objectContaining({ action: "company.data_exported", entityId: company.id })]),
  );

  expect(errors).toEqual([]);
});

test("data export explains why it cannot download with nothing selected", async ({ page }) => {
  const company = await createCompany(page, "Data Export Empty E2E");
  await page.goto(`/${company.prefix}/company/settings`);
  const section = page.getByTestId("company-settings-data-export-section");
  for (const entity of ["run", "events", "transcript", "costs", "activity"]) {
    await section.getByTestId(`company-data-export-include-${entity}`).click();
  }
  await expect(section.getByTestId("company-data-export-download")).toBeDisabled();
  await expect(section).toContainText("Choose at least one kind of record.");

  // Recover: choosing one kind enables the download again.
  await section.getByTestId("company-data-export-include-run").click();
  await expect(section.getByTestId("company-data-export-download")).toHaveAttribute(
    "href",
    `/api/companies/${company.id}/archive/export?follow=true&include=run`,
  );
});
