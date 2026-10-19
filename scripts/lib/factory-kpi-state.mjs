// Where the gate keeps its state between runs: a local file, or a Paperclip issue document so the
// state survives fresh sessions and different runners. Both stores hold the same small JSON object
// ({ version, lastPosted, cache, incompleteStreak }); anything unreadable is reported to the caller,
// never guessed, and every failure here is a StateError so the caller can tell it from a bug.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "./factory-kpi-github.mjs";
import { RULES_KEY_PREFIX } from "./factory-kpi-guard-run.mjs";

export const STATE_VERSION = 1;
const DOC_KEY_PATTERN = /^kpi-[a-z0-9_-]{1,59}$/; // the prefix keeps the gate away from documents such as `plan`
const ISSUE_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const FENCE_OPEN = "```json\n";
const FENCE_CLOSE = "\n```";
const MAX_STATE_BYTES = 1_000_000;
const VERDICTS = new Set(["ok", "violation", "unenforced"]);
const FINITE = (n) => typeof n === "number" && Number.isFinite(n);

export class StateError extends Error {
  constructor(message) {
    super(redact(message));
    this.name = "StateError";
  }
}

function validSignature(sig) {
  return (
    sig &&
    typeof sig === "object" &&
    FINITE(sig.atMs) &&
    (sig.avg24 === null || FINITE(sig.avg24)) &&
    (sig.min6 === null || FINITE(sig.min6)) &&
    FINITE(sig.sustained) &&
    Array.isArray(sig.violations) &&
    sig.violations.every((v) => typeof v === "string") &&
    typeof sig.incomplete === "boolean"
  );
}

function validCacheEntry(key, entry) {
  if (!entry || typeof entry !== "object") return false;
  if (key.startsWith(RULES_KEY_PREFIX)) return typeof entry.fp === "string" && (entry.since === null || FINITE(entry.since));
  return VERDICTS.has(entry.v) && Array.isArray(entry.r) && entry.r.every((r) => typeof r === "string") && FINITE(entry.f) && FINITE(entry.at);
}

// An entry that does not look like one we wrote is dropped (it is judged again); a bad "last posted"
// cannot be repaired by dropping, so it makes the whole state unreadable and the gate speaks.
function checkShape(state) {
  if (!state || typeof state !== "object" || Array.isArray(state) || state.version !== STATE_VERSION) {
    throw new StateError("state has an unknown version");
  }
  if (state.lastPosted !== null && state.lastPosted !== undefined && !validSignature(state.lastPosted)) {
    throw new StateError("state has a malformed last-posted record");
  }
  const raw = state.cache && typeof state.cache === "object" && !Array.isArray(state.cache) ? state.cache : {};
  const cache = Object.fromEntries(Object.entries(raw).filter(([key, entry]) => validCacheEntry(key, entry)));
  const streak = Number.isInteger(state.incompleteStreak) && state.incompleteStreak > 0 ? state.incompleteStreak : 0;
  return { lastPosted: state.lastPosted ?? null, cache, incompleteStreak: streak };
}

const serialize = (state) => JSON.stringify({ version: STATE_VERSION, ...state });

/** `read()` resolves to { lastPosted, cache, incompleteStreak } or null when nothing was saved yet. */
export function fileStore(path) {
  return {
    describe: () => `file ${path}`,
    async read() {
      let text;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new StateError(`cannot read state file: ${error.code ?? error.message}`);
      }
      if (text.length > MAX_STATE_BYTES) throw new StateError("state file is too large");
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new StateError("state file is not valid JSON");
      }
      return checkShape(parsed);
    },
    async write(state) {
      const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(tmp, `${serialize(state)}\n`, { mode: 0o600, flag: "wx" });
        await rename(tmp, path);
      } catch (error) {
        await unlink(tmp).catch(() => {});
        throw new StateError(`cannot write state file: ${error.code ?? error.message}`);
      }
    },
  };
}

// The API root without credentials or a trailing /api: the paths below add /api themselves.
function normalizeApiUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new StateError("the Paperclip API url is not a valid url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new StateError("the Paperclip API url must be http or https");
  if (url.username || url.password) throw new StateError("the Paperclip API url must not carry credentials");
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/api$/, "")}`;
}

/**
 * State kept in an issue document through the Paperclip API (`PUT` with the revision we read).
 * `fetchImpl` is injected for tests. The API key is only ever sent as a header.
 */
export function issueDocumentStore({ apiUrl, apiKey, issueId, key = "kpi-state", runId = null, fetchImpl = globalThis.fetch }) {
  if (!apiUrl || !apiKey) throw new StateError("a Paperclip API url and key are needed for issue document state");
  if (!ISSUE_ID_PATTERN.test(issueId)) throw new StateError("invalid state issue id");
  if (!DOC_KEY_PATTERN.test(key)) throw new StateError("invalid state document key: it must start with kpi-");
  const url = `${normalizeApiUrl(apiUrl)}/api/issues/${issueId}/documents/${key}`;
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(runId ? { "x-paperclip-run-id": runId } : {}) };
  let baseRevisionId = null;
  const call = async (init) => {
    try {
      return await fetchImpl(url, { ...init, headers, redirect: "error" });
    } catch (error) {
      throw new StateError(`cannot reach Paperclip: ${String(error.message).split(apiKey).join("[redacted]")}`);
    }
  };
  const readJson = async (res, what) => {
    try {
      return await res.json();
    } catch {
      throw new StateError(`${what} returned something that is not JSON`);
    }
  };
  return {
    describe: () => `issue document ${issueId}/${key}`,
    async read() {
      const res = await call({ method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) throw new StateError(`reading state failed with HTTP ${res.status}`);
      const doc = await readJson(res, "reading state");
      baseRevisionId = doc.latestRevisionId ?? null;
      const body = String(doc.body ?? "");
      if (body.length > MAX_STATE_BYTES) throw new StateError("state document is too large");
      const open = body.indexOf(FENCE_OPEN);
      const close = open === -1 ? -1 : body.indexOf(FENCE_CLOSE, open + FENCE_OPEN.length);
      if (open === -1 || close === -1) throw new StateError("state document has no JSON block");
      let parsed;
      try {
        parsed = JSON.parse(body.slice(open + FENCE_OPEN.length, close));
      } catch {
        throw new StateError("state document is not valid JSON");
      }
      return checkShape(parsed);
    },
    async write(state) {
      const body = [
        "# Factory KPI gate state",
        "",
        "Written by `scripts/factory-throughput-kpi.mjs --gate`. Do not edit by hand.",
        "",
        "```json",
        serialize(state),
        "```",
        "",
      ].join("\n");
      const res = await call({
        method: "PUT",
        body: JSON.stringify({ title: "Factory KPI gate state", format: "markdown", body, baseRevisionId, changeSummary: "gate state" }),
      });
      if (!res.ok) throw new StateError(`saving state failed with HTTP ${res.status}`);
      const saved = await readJson(res, "saving state");
      // A locked document redirects the write to another key: that is not our state.
      if (saved.key !== key) throw new StateError("state was saved under a different document key");
      baseRevisionId = saved.latestRevisionId ?? baseRevisionId;
    },
  };
}
