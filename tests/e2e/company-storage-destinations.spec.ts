import { expect, test, type Page } from "@playwright/test";

/**
 * Company Settings → Storage destinations: a board user connects an
 * S3-compatible bucket with company secrets, probes it and retires it. The
 * endpoint uses the reserved `.invalid` TLD, so the probe fails without
 * network access and the UI must show why.
 */

async function createCompany(page: Page, name: string): Promise<{ id: string; prefix: string }> {
  const res = await page.request.post("/api/companies", { data: { name } });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return { id: company.id, prefix: company.issuePrefix ?? company.prefix };
}

async function createSecret(page: Page, companyId: string, name: string, value: string) {
  const res = await page.request.post(`/api/companies/${companyId}/secrets`, {
    data: { name, provider: "local_encrypted", value },
  });
  expect(res.ok(), `create secret failed ${res.status()}: ${await res.text()}`).toBe(true);
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Failed API calls are expected in this spec and surface in the UI.
    if (/Failed to load resource/.test(text)) return;
    errors.push(`CONSOLE: ${text.slice(0, 300)}`);
  });
  return errors;
}

async function fillDestination(page: Page, endpoint: string) {
  const form = page.getByTestId("storage-destination-form");
  await form.getByTestId("storage-destination-label").fill("Archive bucket");
  await form.getByTestId("storage-destination-endpoint").fill(endpoint);
  await form.getByTestId("storage-destination-region").fill("eu-west-1");
  await form.getByTestId("storage-destination-bucket").fill("acme-archive");
  await form.getByTestId("storage-destination-access-secret").selectOption({ label: "Archive access key" });
  await form.getByTestId("storage-destination-secret-secret").selectOption({ label: "Archive secret key" });
  return form;
}

test("board user connects, probes and retires a storage destination", async ({ page }) => {
  const errors = collectConsoleErrors(page);
  const company = await createCompany(page, "Storage Destinations E2E");
  await createSecret(page, company.id, "Archive access key", "AKIA-E2E");
  await createSecret(page, company.id, "Archive secret key", "secret-e2e");

  await page.goto(`/${company.prefix}/company/settings`);
  const section = page.getByTestId("company-settings-storage-section");
  await expect(section.getByTestId("storage-destinations-empty")).toBeVisible();

  await section.getByTestId("storage-destination-add").click();
  const form = await fillDestination(page, "https://s3.paperclip-e2e.invalid");
  await form.getByTestId("storage-destination-save").click();

  await expect(section.getByText("Archive bucket", { exact: true })).toBeVisible();
  await expect(section.getByText(/s3\.paperclip-e2e\.invalid \/ acme-archive \/ paperclip/)).toBeVisible();
  await expect(section.getByTestId("storage-destination-status")).toHaveText("Not probed yet.");

  await section.getByTestId("storage-destination-probe").click();
  await expect(section.getByTestId("storage-destination-status")).toHaveText("The endpoint is unreachable or outside the network policy of this instance.", { timeout: 45_000 });

  // The audit trail has the creation and the failed probe.
  const activity = await page.request.get(`/api/companies/${company.id}/activity?entityType=storage_destination`);
  const actions = (await activity.json()).map((row: { action: string }) => row.action);
  expect(actions).toEqual(expect.arrayContaining(["storage.destination_created", "storage.destination_probed"]));

  page.once("dialog", (dialog) => dialog.accept());
  await section.getByTestId("storage-destination-retire").click();
  await expect(section.getByTestId("storage-destination-status")).toHaveText("Retired. Kept for history; nothing is written to it.");
  await expect(section.getByTestId("storage-destination-probe")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("storage destination form explains a refused endpoint and keeps the input", async ({ page }) => {
  const company = await createCompany(page, "Storage Destinations Error E2E");
  await createSecret(page, company.id, "Archive access key", "AKIA-E2E");
  await createSecret(page, company.id, "Archive secret key", "secret-e2e");
  await page.goto(`/${company.prefix}/company/settings`);
  const section = page.getByTestId("company-settings-storage-section");
  await section.getByTestId("storage-destination-add").click();
  const form = await fillDestination(page, "http://s3.paperclip-e2e.invalid");
  await form.getByTestId("storage-destination-save").click();
  await expect(form.getByTestId("storage-destination-save-error")).toContainText("HTTPS");

  // Recover: fix the endpoint and save.
  await form.getByTestId("storage-destination-endpoint").fill("https://s3.paperclip-e2e.invalid");
  await form.getByTestId("storage-destination-save").click();
  await expect(section.getByTestId("storage-destination-status")).toHaveText("Not probed yet.");
});
