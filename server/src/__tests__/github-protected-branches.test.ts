import { describe, expect, it, vi } from "vitest";
import { protectedBranchRefusal, readProtectedBranches } from "../services/github-protected-branches.js";

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

describe("protected branches read from GitHub", () => {
  it("refuses the default branch and protected branches, and allows the others", async () => {
    const github = fakeGitHub({
      ...repo("a"), ...branch("a", "develop", false), ...branch("a", "protected", true), ...branch("a", "locked", false, [{ type: "deletion" }]),
      ...branch("a", "rewritten", false, [{ type: "non_fast_forward" }]), ...branch("a", "future", false, [{ type: "some_new_rule" }]),
      ...branch("a", "signed", false, [{ type: "required_signatures" }, { type: "required_linear_history" }]), ...branch("a", "feature", false),
      [`repos/acme/a/rules/branches/missing?per_page=100&page=1`]: { status: 200, body: [] },
    });
    const all = ["develop", "protected", "locked", "rewritten", "future", "signed", "feature", "missing"];
    await readProtectedBranches("acme/a", all, "read-token", github.fetchImpl);
    expect(protectedBranchRefusal("acme/a", ["develop"])).toMatch(/^Denied: agents never delete or force-push a default or protected branch \(develop is the default branch of acme\/a\)/);
    expect(protectedBranchRefusal("acme/a", ["DEVELOP"])).toMatch(/is the default branch/);
    for (const name of ["protected", "locked", "rewritten", "future"]) {
      expect(protectedBranchRefusal("acme/a", ["feature", name]), name).toMatch(new RegExp(`\\(${name} is a protected branch of acme/a\\)`));
    }
    // Rules about commit contents or history shape do not guard a branch; a branch that does not exist has no classic protection.
    expect(protectedBranchRefusal("acme/a", ["feature", "signed", "missing"])).toBeNull();
    // Name floor: staging and production stay refused even when GitHub says they are neither the default nor protected.
    for (const name of ["staging", "production", "Production", "MAIN"]) {
      expect(protectedBranchRefusal("acme/a", ["feature", name]), name).toMatch(new RegExp(`${name} is a protected branch name`));
    }
    // Only authenticated GETs to api.github.com.
    expect(github.requests.every(request => request.method === "GET" && request.url.startsWith("https://api.github.com/repos/acme/a") && request.authorization === "Bearer read-token")).toBe(true);
  });

  it("fails closed for a branch it has not read, or when GitHub does not answer clearly", async () => {
    expect(protectedBranchRefusal("acme/unread", ["feature"])).toMatch(/^Denied: Paperclip could not read from GitHub whether feature is the default or a protected branch of acme\/unread/);
    for (const [name, routes] of [
      ["unreachable", { "repos/acme/unreachable": new TypeError("fetch failed") }],
      ["no-default", { "repos/acme/no-default": { status: 200, body: {} } }],
      ["forbidden", { ...repo("forbidden"), "repos/acme/forbidden/branches/feature": { status: 403, body: { message: "Forbidden" } } }],
      ["odd", { ...repo("odd"), "repos/acme/odd/branches/feature": { status: 200, body: { protected: "yes" } } }],
      ["rules-down", { ...repo("rules-down"), ...branch("rules-down", "feature", false), "repos/acme/rules-down/rules/branches/feature?per_page=100&page=1": { status: 500 } }],
      ["many-rules", { ...repo("many-rules"), "repos/acme/many-rules/branches/feature": { status: 200, body: { protected: false } },
        ...Object.fromEntries(Array.from({ length: 11 }, (_, page) => [`repos/acme/many-rules/rules/branches/feature?per_page=100&page=${page + 1}`, { status: 200, body: [], next: true }])) }],
    ] as Array<[string, Record<string, Route>]>) {
      await expect(readProtectedBranches(`acme/${name}`, ["feature"], "read-token", fakeGitHub(routes).fetchImpl), name).rejects.toThrow();
      expect(protectedBranchRefusal(`acme/${name}`, ["feature"]), name).toMatch(/could not read from GitHub/);
    }
  });

  it("reads every page of rules, encodes branch names, and keeps facts per repository for five minutes", async () => {
    const start = Date.parse("2026-10-09T10:00:00.000Z");
    const github = fakeGitHub({
      ...repo("b", "main"), "repos/acme/b/branches/release%2F1": { status: 200, body: { protected: false } },
      "repos/acme/b/rules/branches/release%2F1?per_page=100&page=1": { status: 200, body: [{ type: "creation" }], next: true },
      "repos/acme/b/rules/branches/release%2F1?per_page=100&page=2": { status: 200, body: [{ type: "update" }] },
      ...branch("b", "feature", false),
    });
    await readProtectedBranches("acme/b", ["release/1", "feature"], "read-token", github.fetchImpl, start);
    expect(protectedBranchRefusal("acme/b", ["release/1"], start)).toMatch(/release\/1 is a protected branch/);
    expect(protectedBranchRefusal("acme/b", ["feature"], start)).toBeNull();
    const reads = github.requests.length;
    // Fresh facts are not read again; a fact about to expire is.
    await readProtectedBranches("acme/b", ["feature"], "read-token", github.fetchImpl, start + 3 * 60_000);
    expect(github.requests.length).toBe(reads);
    expect(protectedBranchRefusal("acme/b", ["feature"], start + 4 * 60_000 + 59_000)).toBeNull();
    expect(protectedBranchRefusal("acme/b", ["feature"], start + 5 * 60_000)).toMatch(/could not read from GitHub/);
    await readProtectedBranches("acme/b", ["feature"], "read-token", github.fetchImpl, start + 4 * 60_000 + 30_000);
    expect(github.requests.length).toBeGreaterThan(reads);
    expect(protectedBranchRefusal("acme/b", ["feature"], start + 5 * 60_000)).toBeNull();
    // Facts belong to one repository.
    expect(protectedBranchRefusal("acme/other", ["feature"], start)).toMatch(/could not read from GitHub/);
  });
});
