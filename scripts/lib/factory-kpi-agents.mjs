// Idle versus busy agents from the Paperclip dashboard (one GET). Supporting context only: it never
// feeds the verdict or the gate. A missing number is reported as an error, never as zero.

import { redact } from "./factory-kpi-github.mjs";

const ID = /^[A-Za-z0-9-]+$/;

const count = (value, name) => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`dashboard field ${name} is missing`);
  return value;
};

/** The dashboard calls agents that are ready and not running `active`; here they are `idle`. */
export function parseDashboard(body) {
  const { agents, tasks } = body ?? {};
  return {
    agents: {
      idle: count(agents?.active, "agents.active"),
      running: count(agents?.running, "agents.running"),
      paused: count(agents?.paused, "agents.paused"),
      error: count(agents?.error, "agents.error"),
    },
    tasks: {
      open: count(tasks?.open, "tasks.open"),
      inProgress: count(tasks?.inProgress, "tasks.inProgress"),
      blocked: count(tasks?.blocked, "tasks.blocked"),
    },
  };
}

/** Resolves to the parsed counts, or `{ error: { kind, message } }`. Never throws. */
export async function collectAgents({ apiUrl, apiKey, companyId, fetchImpl = globalThis.fetch }) {
  const fail = (kind, message) => ({ error: { kind, message: redact(String(message).split(apiKey ?? "\0").join("[redacted]")) } });
  if (!apiUrl || !apiKey || !companyId || !ID.test(companyId)) return fail("config", "Paperclip API url, key and company id are needed");
  let res;
  try {
    res = await fetchImpl(`${apiUrl.replace(/\/+$/, "")}/api/companies/${companyId}/dashboard`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    return fail("network", `cannot reach Paperclip: ${error.message}`);
  }
  if (!res.ok) return fail(res.status === 401 || res.status === 403 ? "auth" : "other", `dashboard request failed with HTTP ${res.status}`);
  try {
    return parseDashboard(await res.json());
  } catch (error) {
    return fail("other", error.message);
  }
}
