import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Agent } from "@paperclipai/shared";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Public fixture credentials only. No installed CLI, host account or live inference.
const KEY = "providers-e2e-key";
const OTHER_KEY = "providers-e2e-other-key";
const baseUrl = `http://127.0.0.1:${process.env.PAPERCLIP_E2E_GATEWAY_PORT}`;
let server: Server;
const calls: Array<{ path: string; model?: string }> = [];
let unavailable = false;
const workspaces: string[] = [];

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body || "{}");
    calls.push({ path: req.url!, model: input.model });
    res.setHeader("Content-Type", "application/json");
    const key = req.headers.authorization?.replace(/^Bearer /, "");
    if (unavailable || (key !== KEY && key !== OTHER_KEY)) {
      res.writeHead(unavailable ? 503 : 401);
      res.end(JSON.stringify({ error: "private upstream error must not appear" }));
      return;
    }
    res.end(JSON.stringify(req.url === "/v1/models"
      ? { data: (key === OTHER_KEY ? ["other-model"] : ["fixture-codex", "fixture-claude"]).map(id => ({ id })) }
      : req.url === "/v1/messages"
        ? { type: "message", content: [{ type: "text", text: "OK" }] }
        : { object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.PAPERCLIP_E2E_GATEWAY_PORT), "127.0.0.1", resolve);
  });
});
test.afterAll(async () => {
  await Promise.all(workspaces.map(cwd => rm(cwd, { recursive: true, force: true })));
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function json<T = Record<string, unknown>>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  expect(response.ok(), `${response.url()}: ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}
async function company(request: APIRequestContext) {
  return json<{ id: string; issuePrefix: string }>(await request.post("/api/companies", {
    data: { name: `Providers E2E ${Date.now()}` },
  }));
}
async function connect(request: APIRequestContext, companyId: string, name: string, key = KEY) {
  return json<{ connectionId: string; grantId: string }>(await request.post(`/api/companies/${companyId}/ai-connections`, {
    data: { name, provider: "openai", method: "api_key", ownership: "shared", apiKey: key,
      gateway: { baseUrl }, testModel: key === KEY ? "fixture-codex" : "other-model", allAgents: true },
  }));
}
async function addFromUi(page: Page, name: string, provider: "openai" | "anthropic") {
  await page.getByRole("button", { name: "Add API provider" }).click();
  const form = page.getByRole("form", { name: "Add provider", exact: true });
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("API format").selectOption(provider);
  await form.getByLabel("API URL").fill(`${baseUrl}/v1`);
  await form.getByLabel("API key", { exact: true }).fill(KEY);
  await form.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(form.getByText("Connection test passed")).toBeVisible();
  await expect(form.getByText("Available models (2)")).toBeVisible();
  const model = provider === "openai" ? "fixture-codex" : "fixture-claude";
  await form.getByLabel("Search models").fill(model);
  await expect(form.getByRole("radio")).toHaveCount(1);
  await form.getByRole("radio", { name: model }).check();
  await form.getByRole("button", { name: "Test model", exact: true }).click();
  await expect(form.getByText("Model test passed")).toBeVisible();
  await form.getByRole("button", { name: "Save provider", exact: true }).click();
  await expect(page.getByRole("article", { name, exact: true })).toBeVisible();
}

test("bundled Providers: standalone test, both APIs, disconnect and reconnect", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const org = await company(request);
  await page.goto(`/${org.issuePrefix}/providers`);
  await expect(page.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  await expect(page.getByText("Harnesses", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add API provider" }).click();
  const form = page.getByRole("form", { name: "Add provider", exact: true });
  await form.getByLabel("API URL").fill(baseUrl);
  await form.getByLabel("API key", { exact: true }).fill("invalid-fixture-key");
  await form.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("rejected this API key");
  await expect(page.getByText("private upstream error must not appear")).toHaveCount(0);
  await form.getByLabel("API key", { exact: true }).fill(KEY);
  await form.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(form.getByText("Available models (2)")).toBeVisible();
  const unsaved = await json<{ connections: unknown[] }>(await request.get(`/api/companies/${org.id}/ai-connections`));
  expect(unsaved.connections).toEqual([]);
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await addFromUi(page, "Codex proxy", "openai");
  await addFromUi(page, "Claude proxy", "anthropic");
  expect(calls.some(call => call.path === "/v1/responses" && call.model === "fixture-codex")).toBe(true);
  expect(calls.some(call => call.path === "/v1/messages" && call.model === "fixture-claude")).toBe(true);
  const card = page.getByRole("article", { name: "Codex proxy", exact: true });
  await card.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(card.getByText("Test passed", { exact: false }).first()).toBeVisible();
  await card.getByRole("button", { name: "Disconnect", exact: true }).click();
  await card.getByRole("button", { name: "Disconnect provider", exact: true }).click();
  await expect(card.getByText("Disconnected", { exact: false })).toBeVisible();
  await expect(card.getByRole("button", { name: "Test connection", exact: true })).toBeDisabled();
  await card.getByRole("button", { name: "Reconnect", exact: true }).click();
  const reconnect = page.getByRole("form", { name: "Reconnect provider" });
  await expect(reconnect.getByLabel("API URL")).toBeDisabled();
  await reconnect.getByLabel("New API key").fill(KEY);
  await reconnect.getByLabel("Model to test").fill("fixture-codex");
  await reconnect.getByRole("button", { name: "Save new key" }).click();
  await expect(card.getByText("Connected", { exact: false })).toBeVisible();
  await page.reload();
  await expect(card).toBeVisible();
  const listing = await json<{ connections: Array<{ id: string; grantId: string; name: string }> }>(await request.get(`/api/companies/${org.id}/ai-connections`));
  const connection = listing.connections.find(c => c.name === "Codex proxy")!;
  const other = await company(request);
  expect((await request.post(`/api/companies/${other.id}/ai-connections/gateway/test`, {
    data: { connectionId: connection.id, grantId: connection.grantId },
  })).status()).toBe(404);
  expect((await request.post(`/api/companies/${org.id}/ai-connections/gateway/test`, {
    data: { connectionId: connection.id, grantId: connection.grantId, gateway: { baseUrl: "https://unapproved.example" } },
  })).status()).toBe(400);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("providers-mobile.png") });
});

test("agent provider selection changes models, saves, and fails closed", async ({ page, request }) => {
  test.setTimeout(120_000);
  const org = await company(request);
  const first = await connect(request, org.id, "First proxy");
  const second = await connect(request, org.id, "Second proxy", OTHER_KEY);
  const cwd = await mkdtemp(path.join(os.tmpdir(), "providers-e2e-agent-"));
  workspaces.push(cwd);
  const agent = await json<{ id: string }>(await request.post(`/api/companies/${org.id}/agents`, { data: {
    name: "Provider selection fixture", role: "qa", adapterType: "codex_local",
    adapterConfig: { model: "fixture-codex", cwd },
    runtimeConfig: { heartbeat: { enabled: false }, aiConnection: { provider: "openai", method: "api_key", mode: "shared", ...first } },
  } }));
  await page.goto(`/${org.issuePrefix}/agents/${agent.id}/runtime`);
  const provider = page.getByRole("combobox", { name: "Provider", exact: true });
  await provider.click();
  await page.getByRole("option", { name: "Second proxy · API key", exact: true }).click();
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await expect(page.getByRole("button", { name: "other-model", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "fixture-claude", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "other-model", exact: true }).click();
  const [savedResponse] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "PATCH" && /\/api\/agents\/[^/]+$/.test(response.url())),
    page.getByRole("button", { name: "Save changes", exact: true }).click(),
  ]);
  expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
  await expect.poll(async () => {
    const saved = await json<Agent>(await request.get(`/api/agents/${agent.id}`));
    return [(saved.runtimeConfig.aiConnection as { connectionId: string }).connectionId, saved.adapterConfig.model];
  }).toEqual([second.connectionId, "other-model"]);
  await page.reload();
  await expect(provider).toContainText("Second proxy");
  unavailable = true;
  try {
    await page.getByRole("button", { name: "Model", exact: true }).click();
    await page.getByRole("button", { name: "Refresh models", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "gateway" })).toBeVisible();
    await expect(page.getByRole("button", { name: "fixture-codex", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Detect model", exact: true })).toHaveCount(0);
  } finally { unavailable = false; }
  await page.getByRole("button", { name: "Refresh models", exact: true }).click();
  await expect(page.getByRole("button", { name: "other-model", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // Subscription rendering uses a browser fixture; no OAuth token or host account is read.
  const subscription = { id: "77777777-7777-4777-8777-777777777777", grantId: "88888888-8888-4888-8888-888888888888",
    companyId: org.id, provider: "openai", method: "subscription", ownership: "personal", name: "Fixture ChatGPT", isDefault: true, status: "connected" };
  await page.route(`**/api/companies/${org.id}/ai-connections*`, async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.connections.push({ ...subscription, ownerUserId: body.currentUserId });
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/tool-connections/${subscription.id}/grants`, route => route.fulfill({ json: { grants: [] } }));
  await page.route(`**/api/companies/${org.id}/adapters/codex_local/models*`, route => route.fulfill({ json: [{ id: "subscription-model", label: "Subscription model" }] }));
  await page.reload();
  await provider.click();
  await page.getByRole("option", { name: /Fixture ChatGPT/ }).click();
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await expect(page.getByRole("button", { name: "Subscription model", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "fixture-codex", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page.goto(`/${org.issuePrefix}/providers`);
  await expect(page.getByRole("article", { name: "Fixture ChatGPT" })).toContainText("Subscription");
  await expect(page.getByRole("article", { name: "First proxy" })).toBeVisible();
});
