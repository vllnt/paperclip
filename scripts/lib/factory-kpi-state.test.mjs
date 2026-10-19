import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateError, fileStore, issueDocumentStore } from "./factory-kpi-state.mjs";
import { tempDir } from "./factory-kpi-test-helpers.mjs";

const T0 = Date.parse("2026-10-18T12:00:00Z");
const signature = (over = {}) => ({
  atMs: T0,
  config: "c1",
  avg24: 2,
  min6: 1,
  target: 6,
  sustained: 0,
  done: false,
  guard: "pass",
  regression: "ok",
  violations: [],
  incomplete: false,
  ...over,
});
const verdict = (over = {}) => ({ v: "ok", r: [], f: 0, at: T0, ...over });
const tmp = async () => tempDir("kpi-state-");

test("fileStore round-trips, reports a missing file as no state, and rejects a bad file", async () => {
  const dir = await tmp();
  const path = join(dir, "nested", "state.json");
  const store = fileStore(path);
  assert.equal(await store.read(), null);
  await store.write({ lastPosted: signature(), cache: { "o/a#1": verdict(), "@rules:o/a": { fp: "abc", since: null } }, incompleteStreak: 2 });
  const back = await store.read();
  assert.deepEqual(back.lastPosted, signature());
  assert.equal(back.cache["o/a#1"].v, "ok");
  assert.deepEqual(back.cache["@rules:o/a"], { fp: "abc", since: null });
  assert.equal(back.incompleteStreak, 2);
  await writeFile(path, "not json");
  await assert.rejects(store.read(), (e) => e instanceof StateError && /not valid JSON/.test(e.message));
  await writeFile(path, JSON.stringify({ version: 99 }));
  await assert.rejects(store.read(), /unknown version/);
  assert.match(await readFile(path, "utf8"), /99/);
});

test("fileStore does not leave a temp file behind and keeps the file private", async () => {
  const dir = await tmp();
  const path = join(dir, "state.json");
  await fileStore(path).write({ lastPosted: null, cache: {} });
  assert.deepEqual(await readdir(dir), ["state.json"]);
  assert.equal((await stat(path)).mode & 0o077, 0);
});

test("two writers at once do not trample each other's temp file", async () => {
  const dir = await tmp();
  const path = join(dir, "state.json");
  await Promise.all(Array.from({ length: 8 }, (_, i) => fileStore(path).write({ lastPosted: signature({ avg24: i }), cache: {} })));
  const back = await fileStore(path).read();
  assert.ok(back.lastPosted.avg24 >= 0 && back.lastPosted.avg24 < 8);
  assert.deepEqual(await readdir(dir), ["state.json"]);
});

test("fileStore turns every filesystem failure into a StateError and cleans up", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "a-file"), "x");
  await assert.rejects(fileStore(join(dir, "a-file", "state.json")).write({ lastPosted: null, cache: {} }), (e) => e instanceof StateError && /cannot write state file/.test(e.message));
  await mkdir(join(dir, "adir"));
  await assert.rejects(fileStore(join(dir, "adir")).read(), (e) => e instanceof StateError && /cannot read state file: EISDIR/.test(e.message));
  await assert.rejects(fileStore(join(dir, "adir")).write({ lastPosted: null, cache: {} }), (e) => e instanceof StateError);
  assert.ok(!(await readdir(dir)).some((name) => name.endsWith(".tmp")), "no temp file left behind");
  const huge = join(dir, "huge.json");
  await writeFile(huge, " ".repeat(1_000_001));
  await assert.rejects(fileStore(huge).read(), /too large/);
});

test("a state that is not the shape we wrote is not trusted: a bad record is unreadable, bad cache entries are dropped", async () => {
  const dir = await tmp();
  const path = join(dir, "state.json");
  const write = (state) => writeFile(path, JSON.stringify({ version: 1, ...state }));
  for (const bad of [{ lastPosted: "yesterday" }, { lastPosted: { atMs: "soon" } }, { lastPosted: { ...signature(), violations: "none" } }, { lastPosted: { ...signature(), incomplete: "no" } }]) {
    await write({ cache: {}, ...bad });
    await assert.rejects(fileStore(path).read(), /malformed last-posted record/, JSON.stringify(bad).slice(0, 40));
  }
  await write({
    lastPosted: signature(),
    cache: {
      "o/a#1": verdict(),
      "o/a#2": verdict({ v: "pass" }),
      "o/a#3": verdict({ r: "text" }),
      "o/a#4": verdict({ at: "now" }),
      "o/a#5": null,
      "@rules:o/a": { fp: "abc", since: 5 },
      "@rules:o/b": { fp: 12, since: null },
      "@rules:o/c": { fp: "abc", since: "soon" },
      "@rules:o/d": { fp: "abc" },
    },
    incompleteStreak: 1.5,
  });
  const back = await fileStore(path).read();
  assert.deepEqual(Object.keys(back.cache).sort(), ["@rules:o/a", "o/a#1"]);
  assert.equal(back.incompleteStreak, 0, "a streak that is not a whole number is reset");
  await write({ lastPosted: null, cache: ["x"] });
  assert.deepEqual((await fileStore(path).read()).cache, {});
  await writeFile(path, "[]");
  await assert.rejects(fileStore(path).read(), /unknown version/);
});

function fakeApi({ doc = null, putStatus = 200, getStatus = null, savedKey = "kpi-state", badJson = false } = {}) {
  const calls = [];
  let current = doc;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const json = badJson ? async () => { throw new SyntaxError("Unexpected token <"); } : null;
    if (init.method === "GET") {
      if (getStatus) return { ok: false, status: getStatus, json: async () => ({}) };
      return current ? { ok: true, status: 200, json: json ?? (async () => current) } : { ok: false, status: 404, json: async () => ({}) };
    }
    const sent = JSON.parse(init.body);
    if (putStatus !== 200) return { ok: false, status: putStatus, json: async () => ({}) };
    current = { key: savedKey, body: sent.body, latestRevisionId: `rev-${calls.length}` };
    return { ok: true, status: 200, json: json ?? (async () => current) };
  };
  return { calls, fetchImpl, get current() { return current; } };
}
const storeFor = (api, over = {}) =>
  issueDocumentStore({ apiUrl: "https://paperclip.example/", apiKey: "secret-key", issueId: "abc-123", runId: "run-1", fetchImpl: api.fetchImpl, ...over });

test("issueDocumentStore creates the document, then updates it with the revision it read", async () => {
  const api = fakeApi();
  const store = storeFor(api);
  assert.equal(await store.read(), null);
  await store.write({ lastPosted: signature(), cache: {} });
  const create = JSON.parse(api.calls[1].init.body);
  assert.equal(create.baseRevisionId, null);
  assert.equal(api.calls[1].url, "https://paperclip.example/api/issues/abc-123/documents/kpi-state");
  assert.equal(api.calls[1].init.method, "PUT");
  assert.equal(api.calls[1].init.headers.authorization, "Bearer secret-key");
  assert.equal(api.calls[1].init.headers["x-paperclip-run-id"], "run-1");
  assert.equal(api.calls[1].init.redirect, "error", "a redirect would carry the key to another host");

  await store.write({ lastPosted: signature({ avg24: 3 }), cache: {} });
  assert.equal(JSON.parse(api.calls.at(-1).init.body).baseRevisionId, "rev-2", "a second write from the same store names the revision it just saved");
  const fresh = storeFor(api);
  const back = await fresh.read();
  assert.deepEqual(back.lastPosted, signature({ avg24: 3 }));
  await fresh.write({ lastPosted: signature({ avg24: 9 }), cache: {} });
  const update = JSON.parse(api.calls.at(-1).init.body);
  assert.equal(update.baseRevisionId, "rev-3", "the update names the revision that was read");
  assert.match(update.body, /^# Factory KPI gate state/);
  assert.match(update.body, /```json\n\{.*\}\n```/);
});

test("issueDocumentStore finds its block even when the document has other fences or backticks", async () => {
  const state = JSON.stringify({ version: 1, lastPosted: signature(), cache: {} });
  const body = `intro\n\n\`\`\`text\nnot ours\n\`\`\`\n\n\`\`\`json\n${state}\n\`\`\`\n\nmore \`\`\`json\n{"version":2}\n\`\`\`\n`;
  const back = await storeFor(fakeApi({ doc: { key: "kpi-state", body, latestRevisionId: "r1" } })).read();
  assert.equal(back.lastPosted.avg24, 2);
  const huge = { key: "kpi-state", body: "x".repeat(1_000_001), latestRevisionId: "r" };
  await assert.rejects(storeFor(fakeApi({ doc: huge })).read(), /too large/);
});

test("issueDocumentStore turns every failure into a StateError without the key in the message", async () => {
  await assert.rejects(storeFor(fakeApi({ getStatus: 500 })).read(), /reading state failed with HTTP 500/);
  await assert.rejects(storeFor(fakeApi({ putStatus: 409 })).write({ lastPosted: null, cache: {} }), /saving state failed with HTTP 409/);
  await assert.rejects(storeFor(fakeApi({ savedKey: "other" })).write({ lastPosted: null, cache: {} }), /different document key/);
  await assert.rejects(storeFor(fakeApi({ doc: { key: "kpi-state", body: "no block here", latestRevisionId: "r" } })).read(), /no JSON block/);
  await assert.rejects(storeFor(fakeApi({ doc: { key: "kpi-state", body: "```json\n{oops\n```", latestRevisionId: "r" } })).read(), /not valid JSON/);
  await assert.rejects(storeFor(fakeApi({ doc: { key: "kpi-state", body: "x", latestRevisionId: "r" }, badJson: true })).read(), (e) => e instanceof StateError && /not JSON/.test(e.message));
  const down = storeFor({ fetchImpl: async () => { throw new Error("connect ECONNREFUSED; Authorization: Bearer secret-key-12345678901234567890"); } });
  await assert.rejects(down.read(), (e) => e instanceof StateError && /cannot reach Paperclip/.test(e.message) && !e.message.includes("secret-key-1234"));
  const raw = storeFor({ fetchImpl: async () => { throw new Error("socket closed while sending secret-key to host"); } });
  await assert.rejects(raw.read(), (e) => /cannot reach Paperclip/.test(e.message) && !e.message.includes("secret-key"));
});

test("issueDocumentStore refuses to start without credentials, with odd identifiers, or with another document's name", () => {
  const make = (over) => issueDocumentStore({ apiUrl: "https://x.example", apiKey: "k", issueId: "abc", ...over });
  assert.throws(() => make({ apiUrl: "" }), StateError);
  assert.throws(() => make({ apiKey: "" }), StateError);
  assert.throws(() => make({ issueId: "../etc" }), /invalid state issue id/);
  for (const key of ["Bad Key", "plan", "state", "kpi-", "kpi-Upper", `kpi-${"a".repeat(60)}`]) {
    assert.throws(() => make({ key }), /invalid state document key/, key);
  }
  assert.doesNotThrow(() => make({ key: "kpi-state-2" }));
});

test("issueDocumentStore only talks to an http(s) API root without credentials, and ignores a trailing /api", () => {
  const urlFor = async (apiUrl) => {
    const api = fakeApi();
    await issueDocumentStore({ apiUrl, apiKey: "k", issueId: "abc", fetchImpl: api.fetchImpl }).read();
    return api.calls[0].url;
  };
  return Promise.all([
    assert.rejects(urlFor("ftp://x.example"), /http or https/),
    assert.rejects(urlFor("not a url"), /not a valid url/),
    assert.rejects(urlFor("https://user:pw@x.example"), /must not carry credentials/),
    assert.rejects(urlFor("https://user@x.example"), /must not carry credentials/),
    urlFor("https://x.example/api").then((u) => assert.equal(u, "https://x.example/api/issues/abc/documents/kpi-state")),
    urlFor("https://x.example/api/").then((u) => assert.equal(u, "https://x.example/api/issues/abc/documents/kpi-state")),
    urlFor("http://localhost:3100").then((u) => assert.equal(u, "http://localhost:3100/api/issues/abc/documents/kpi-state")),
    urlFor("https://x.example/prefix").then((u) => assert.equal(u, "https://x.example/prefix/api/issues/abc/documents/kpi-state")),
  ]);
});
