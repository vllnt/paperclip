import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIResponse } from "@playwright/test";
import { createDb, closeRegisteredClients, agentHarnessCooldowns } from "../../packages/db/src/index.ts";

async function json<T>(response: APIResponse, label: string): Promise<T> {
  expect(response.ok(), `${label} failed ${response.status()}: ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

let serverDbUrl: string | null = null;

async function serverDb() {
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
  const pid = await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8");
  serverDbUrl = `postgres://paperclip:paperclip@127.0.0.1:${pid.split("\n")[3]}/paperclip`;
  return createDb(serverDbUrl);
}

test.afterAll(async () => {
  if (serverDbUrl) await closeRegisteredClients(serverDbUrl);
});

test("an operator configures a Codex fallback for a Claude agent and sees the fallback state", async ({ page, request }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `Fallbacks browser E2E ${Date.now()}` } }),
    "create company",
  );
  const agent = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Implementer",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: { model: "claude-opus-5-5" },
        runtimeConfig: { heartbeat: { enabled: false } },
      },
    }),
    "create agent",
  );

  await page.goto(`/${company.issuePrefix}/agents/${agent.id}/runtime`);
  const section = page.getByTestId("agent-fallbacks-section");
  await expect(section.getByRole("heading", { name: "Fallback harnesses" })).toBeVisible();
  await expect(section.getByTestId("agent-fallbacks-empty")).toBeVisible();

  // An Anthropic model on Codex is refused before it can be saved.
  await section.getByRole("button", { name: "Add fallback" }).click();
  await section.getByLabel("Fallback 1 model").fill("claude-opus-5-5");
  await expect(section.getByTestId("agent-fallback-error-0")).toContainText("Anthropic models never run through codex_local");
  await expect(section.getByRole("button", { name: "Save fallbacks" })).toBeDisabled();

  await section.getByLabel("Fallback 1 model").fill("gpt-5.5");
  await section.getByLabel("Fallback 1 effort").fill("high");
  await expect(section.getByTestId("agent-fallback-error-0")).toHaveCount(0);
  await section.getByRole("button", { name: "Save fallbacks" }).click();
  await expect(page.getByText("Fallbacks saved")).toBeVisible();

  const stored = await json<{ fallbacks: Array<Record<string, unknown>> }>(
    await request.get(`/api/agents/${agent.id}`),
    "read agent",
  );
  expect(stored.fallbacks).toMatchObject([{ adapterType: "codex_local", model: "gpt-5.5", effort: "high" }]);

  // The primary runs out of quota: the agent shows the fallback it now uses.
  const db = await serverDb();
  await db.insert(agentHarnessCooldowns).values({
    companyId: company.id,
    agentId: agent.id,
    targetKey: "claude_local:claude-opus-5-5",
    adapterType: "claude_local",
    model: "claude-opus-5-5",
    reason: "provider_usage_limit",
    cooldownUntil: new Date(Date.now() + 90 * 60_000),
  });
  await page.reload();
  await expect(page.getByTestId("agent-harness-fallback-badge")).toContainText("On fallback codex_local/gpt-5.5 until");
  await expect(page.getByTestId("agent-fallbacks-section").getByLabel("Fallback 1 model")).toHaveValue("gpt-5.5");
  const screenshotDir = process.env.PAPERCLIP_E2E_SCREENSHOT_DIR;
  if (screenshotDir) {
    const dismiss = page.getByRole("button", { name: "Dismiss announcement" });
    if (await dismiss.isVisible()) await dismiss.click();
    for (const [name, width, height] of [["desktop", 1920, 1080], ["tablet", 768, 1024], ["mobile", 375, 667]] as const) {
      await page.setViewportSize({ width, height });
      await expect(page.getByTestId("agent-harness-fallback-badge")).toBeVisible();
      await page.screenshot({ path: path.join(screenshotDir, `agent-fallbacks-header-${name}.png`) });
      await page.getByTestId("agent-fallbacks-section").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshotDir, `agent-fallbacks-section-${name}.png`) });
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  }

  // Removing the chain persists, and the empty state returns.
  await page.getByTestId("agent-fallbacks-section").getByRole("button", { name: "Remove fallback 1" }).click();
  await page.getByTestId("agent-fallbacks-section").getByRole("button", { name: "Save fallbacks" }).click();
  await expect(page.getByTestId("agent-fallbacks-section").getByTestId("agent-fallbacks-empty")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("agent-fallbacks-section").getByTestId("agent-fallbacks-empty")).toBeVisible();

  expect(consoleErrors).toEqual([]);
});
