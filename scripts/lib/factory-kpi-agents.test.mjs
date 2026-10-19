import assert from "node:assert/strict";
import test from "node:test";
import { collectAgents, parseDashboard } from "./factory-kpi-agents.mjs";

const dashboard = (over = {}) => ({
  agents: { active: 5, running: 18, paused: 9, error: 1 },
  tasks: { open: 608, inProgress: 27, blocked: 93, done: 695 },
  ...over,
});
const creds = { apiUrl: "https://paperclip.example/", apiKey: "secret-key-value", companyId: "co-123" };
const respond = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("parseDashboard renames active to idle and keeps the task counts that matter", () => {
  assert.deepEqual(parseDashboard(dashboard()), {
    agents: { idle: 5, running: 18, paused: 9, error: 1 },
    tasks: { open: 608, inProgress: 27, blocked: 93 },
  });
});

test("parseDashboard rejects a missing or invalid field instead of reporting zero", () => {
  assert.throws(() => parseDashboard(dashboard({ agents: { running: 1, paused: 0, error: 0 } })), /agents\.active is missing/);
  assert.throws(() => parseDashboard(dashboard({ agents: { active: "5", running: 1, paused: 0, error: 0 } })), /agents\.active/);
  assert.throws(() => parseDashboard(dashboard({ agents: { active: -1, running: 1, paused: 0, error: 0 } })), /agents\.active/);
  assert.throws(() => parseDashboard(dashboard({ tasks: undefined })), /tasks\.open is missing/);
  assert.throws(() => parseDashboard(null), /agents\.active is missing/);
});

test("collectAgents calls the dashboard with a bearer token and returns the counts", async () => {
  const calls = [];
  const result = await collectAgents({
    ...creds,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => dashboard() };
    },
  });
  assert.equal(result.agents.idle, 5);
  assert.equal(calls[0].url, "https://paperclip.example/api/companies/co-123/dashboard");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.authorization, "Bearer secret-key-value");
});

test("collectAgents turns every failure into an error object and never throws", async () => {
  const kind = async (fetchImpl, over = {}) => (await collectAgents({ ...creds, fetchImpl, ...over })).error;
  assert.equal((await kind(respond(401, {}))).kind, "auth");
  assert.equal((await kind(respond(403, {}))).kind, "auth");
  assert.equal((await kind(respond(500, {}))).kind, "other");
  assert.match((await kind(respond(500, {}))).message, /HTTP 500/);
  assert.equal((await kind(respond(200, { agents: {} }))).kind, "other");
  assert.equal((await kind(async () => { throw new Error("ECONNREFUSED"); })).kind, "network");
  assert.equal((await kind(respond(200, {}), { apiKey: "" })).kind, "config");
  assert.equal((await kind(respond(200, {}), { companyId: "../x" })).kind, "config");
  assert.equal((await kind(respond(200, {}), { apiUrl: "" })).kind, "config");
});

test("collectAgents never echoes the API key", async () => {
  const error = (await collectAgents({ ...creds, fetchImpl: async () => { throw new Error("tls failure while sending secret-key-value"); } })).error;
  assert.ok(!error.message.includes("secret-key-value"));
  assert.match(error.message, /\[redacted\]/);
});
