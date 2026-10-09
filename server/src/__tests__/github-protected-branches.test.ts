import { describe, expect, it, vi } from "vitest";
import { protectedBranchRefusal, readProtectedBranches, withProtectedBranchFacts } from "../services/github-protected-branches.js";

type Route = { status: number; body?: unknown; next?: boolean } | Error;

/** A GitHub that answers each GET path from `routes` (anything else is a 404), recording every request. */
function fakeGitHub(routes: Record<string, Route>) {
  const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") });
    const route = routes[url.replace("https://api.github.com/", "")];
    if (route instanceof Error) throw route;
    const answer = route ?? { status: 404, body: { message: "Not Found" } };
    return new Response(JSON.stringify(answer.body ?? null), {
      status: answer.status,
      headers: answer.next ? { link: '<https://api.github.com/next>; rel="next"' } : {},
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

const repo = (name: string, defaultBranch = "develop"): Record<string, Route> => ({ [`repos/acme/${name}`]: { status: 200, body: { default_branch: defaultBranch } } });
const branch = (name: string, path: string, isProtected: boolean, rules: unknown[] = []): Record<string, Route> => ({
  [`repos/acme/${name}/branches/${path}`]: { status: 200, body: { name: path, protected: isProtected } },
  [`repos/acme/${name}/rules/branches/${path}?per_page=100&page=1`]: { status: 200, body: rules },
});

/** Reads `branches` of `repository` from the fake GitHub, then asks the classifier's question inside that operation. */
async function refusal(routes: Record<string, Route>, repository: string, branches: string[], asked = branches) {
  const github = fakeGitHub(routes);
  const facts = await readProtectedBranches(repository, branches, "read-token", github.fetchImpl);
  return { github, message: await withProtectedBranchFacts(facts, async () => protectedBranchRefusal(repository, asked)) };
}

describe("protected branches read from GitHub", () => {
  const routes = {
    ...repo("a"), ...branch("a", "develop", false), ...branch("a", "protected", true), ...branch("a", "locked", false, [{ type: "deletion" }]),
    ...branch("a", "rewritten", false, [{ type: "non_fast_forward" }]), ...branch("a", "future", false, [{ type: "some_new_rule" }]),
    ...branch("a", "signed", false, [{ type: "required_signatures" }, { type: "required_linear_history" }]), ...branch("a", "feature", false),
    "repos/acme/a/rules/branches/missing?per_page=100&page=1": { status: 200, body: [] },
  };
  const all = ["develop", "protected", "locked", "rewritten", "future", "signed", "feature", "missing"];

  it("refuses the default branch and protected branches, and allows the others", async () => {
    expect((await refusal(routes, "acme/a", all, ["develop"])).message).toMatch(/^Denied: agents never delete or force-push a default or protected branch \(develop is the default branch of acme\/a\)/);
    expect((await refusal(routes, "acme/a", all, ["DEVELOP"])).message).toMatch(/is the default branch/);
    for (const name of ["protected", "locked", "rewritten", "future"]) {
      expect((await refusal(routes, "acme/a", all, ["feature", name])).message, name).toMatch(new RegExp(`\\(${name} is a protected branch of acme/a\\)`));
    }
    // Rules about commit contents or history shape do not guard a branch; a branch that does not exist has no classic protection.
    expect((await refusal(routes, "acme/a", all, ["feature", "signed", "missing"])).message).toBeNull();
    // Name floor: staging and production stay refused even when GitHub says they are neither the default nor protected.
    for (const name of ["staging", "production", "Production", "MAIN"]) {
      expect((await refusal(routes, "acme/a", all, ["feature", name])).message, name).toMatch(new RegExp(`${name} is a protected branch name`));
    }
    // Only authenticated GETs to api.github.com.
    const { github } = await refusal(routes, "acme/a", all);
    expect(github.requests.every(request => request.method === "GET" && request.url.startsWith("https://api.github.com/repos/acme/a") && request.authorization === "Bearer read-token")).toBe(true);
  });

  it("fails closed outside an operation's facts: none, another repository, or a branch that was not read", async () => {
    expect(protectedBranchRefusal("acme/unread", ["feature"])).toMatch(/^Denied: Paperclip could not read from GitHub whether feature is the default or a protected branch of acme\/unread/);
    expect((await refusal(routes, "acme/a", ["feature"], ["feature", "signed"])).message).toMatch(/whether signed is the default/);
    const github = fakeGitHub(routes);
    const facts = await readProtectedBranches("acme/a", ["feature"], "read-token", github.fetchImpl);
    expect(await withProtectedBranchFacts(facts, async () => protectedBranchRefusal("acme/other", ["feature"]))).toMatch(/could not read from GitHub/);
  });

  it("throws when GitHub does not answer clearly", async () => {
    for (const [name, failing] of [
      ["unreachable", { "repos/acme/unreachable": new TypeError("fetch failed") }],
      ["no-default", { "repos/acme/no-default": { status: 200, body: {} } }],
      ["forbidden", { ...repo("forbidden"), "repos/acme/forbidden/branches/feature": { status: 403, body: { message: "Forbidden" } } }],
      ["odd", { ...repo("odd"), "repos/acme/odd/branches/feature": { status: 200, body: { protected: "yes" } } }],
      ["rules-down", { ...repo("rules-down"), ...branch("rules-down", "feature", false), "repos/acme/rules-down/rules/branches/feature?per_page=100&page=1": { status: 500 } }],
      ["many-rules", { ...repo("many-rules"), "repos/acme/many-rules/branches/feature": { status: 200, body: { protected: false } },
        ...Object.fromEntries(Array.from({ length: 11 }, (_, page) => [`repos/acme/many-rules/rules/branches/feature?per_page=100&page=${page + 1}`, { status: 200, body: [], next: true }])) }],
    ] as Array<[string, Record<string, Route>]>) {
      await expect(readProtectedBranches(`acme/${name}`, ["feature"], "read-token", fakeGitHub(failing).fetchImpl), name).rejects.toThrow();
    }
  });

  it("reads every page of rules and encodes branch names", async () => {
    const { message } = await refusal({
      ...repo("b", "main"), "repos/acme/b/branches/release%2F1": { status: 200, body: { protected: false } },
      "repos/acme/b/rules/branches/release%2F1?per_page=100&page=1": { status: 200, body: [{ type: "creation" }], next: true },
      "repos/acme/b/rules/branches/release%2F1?per_page=100&page=2": { status: 200, body: [{ type: "update" }] },
      ...branch("b", "feature", false),
    }, "acme/b", ["release/1", "feature"], ["release/1"]);
    expect(message).toMatch(/release\/1 is a protected branch/);
  });

  it("keeps nothing between operations: every read asks GitHub, and overlapping operations see only their own facts (review r3b)", async () => {
    const unprotected = fakeGitHub({ ...repo("c"), ...branch("c", "feature", false) });
    const protectedNow = fakeGitHub({ ...repo("c"), ...branch("c", "feature", true) });
    const first = await readProtectedBranches("acme/c", ["feature"], "read-token", unprotected.fetchImpl);
    const readsBefore = unprotected.requests.length;
    // Facts are gone outside the operation that carried them.
    await withProtectedBranchFacts(first, async () => expect(protectedBranchRefusal("acme/c", ["feature"])).toBeNull());
    expect(protectedBranchRefusal("acme/c", ["feature"])).toMatch(/could not read from GitHub/);
    // A second read after protection changed is a new GitHub request with the new answer.
    const second = await readProtectedBranches("acme/c", ["feature"], "read-token", protectedNow.fetchImpl);
    expect(protectedNow.requests.length).toBeGreaterThan(0);
    expect(unprotected.requests.length).toBe(readsBefore);
    // Two operations running at once, one with facts and one without, never see each other's.
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const allowed = withProtectedBranchFacts(first, async () => { await gate; return protectedBranchRefusal("acme/c", ["feature"]); });
    const refused = withProtectedBranchFacts(second, async () => { await gate; return protectedBranchRefusal("acme/c", ["feature"]); });
    const unknown = withProtectedBranchFacts(null, async () => { await gate; return protectedBranchRefusal("acme/c", ["feature"]); });
    release();
    expect(await allowed).toBeNull();
    expect(await refused).toMatch(/feature is a protected branch of acme\/c/);
    expect(await unknown).toMatch(/could not read from GitHub/);
  });
});
