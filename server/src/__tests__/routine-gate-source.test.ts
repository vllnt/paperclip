import { describe, expect, it, vi } from "vitest";
import { ROUTINE_GATE_LIMITS, type RoutineGate } from "@paperclipai/shared";
import { unprocessable } from "../errors.ts";
import { gateScriptSha } from "../services/routine-gates/command.ts";
import { GateSourceError, createGateScriptSource } from "../services/routine-gates/source.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const gate: Pick<RoutineGate, "repo" | "path" | "commitSha"> = {
  repo: "vllnt/paperclip-gates",
  path: "gates/pr open.sh",
  commitSha: SHA,
};

interface FakeGitHub {
  defaultBranch?: string | null;
  compareStatus?: string;
  file?: Record<string, unknown> | number;
  repoStatus?: number;
  compareStatusCode?: number;
  throwNetwork?: boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(config: FakeGitHub = {}) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (config.throwNetwork) throw new TypeError("fetch failed");
    const { pathname } = new URL(url);
    if (pathname.includes("/compare/")) {
      if (config.compareStatusCode) return jsonResponse({}, config.compareStatusCode);
      return jsonResponse({ status: config.compareStatus ?? "identical" });
    }
    if (pathname.includes("/contents/")) {
      if (typeof config.file === "number") return jsonResponse({}, config.file);
      return jsonResponse(
        config.file ?? { type: "file", encoding: "base64", size: 11, content: Buffer.from("exit 0\n# ok").toString("base64") },
      );
    }
    if (config.repoStatus) return jsonResponse({}, config.repoStatus);
    return jsonResponse({ default_branch: config.defaultBranch === undefined ? "main" : config.defaultBranch });
  });
  return { impl: impl as unknown as typeof fetch, calls, spy: impl };
}

function source(config: FakeGitHub = {}, overrides: { allowed?: string[]; mintToken?: (c: string, r: string) => Promise<string> } = {}) {
  const github = fakeFetch(config);
  const mintToken = vi.fn(overrides.mintToken ?? (async () => "ghs_token"));
  const svc = createGateScriptSource({
    allowedRepos: async () => overrides.allowed ?? ["vllnt/paperclip-gates"],
    mintToken,
    fetchImpl: github.impl,
  });
  return { svc, github, mintToken };
}

async function failure(promise: Promise<unknown>): Promise<GateSourceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GateSourceError);
    return error as GateSourceError;
  }
  throw new Error("expected the load to fail");
}

describe("createGateScriptSource", () => {
  it("loads a script that is on the default branch and returns its content and sha", async () => {
    const { svc } = source();
    const script = await svc.load("company-1", gate);
    expect(script.content).toBe("exit 0\n# ok");
    expect(script.sha256).toBe(gateScriptSha("exit 0\n# ok"));
  });

  it("refuses a repository that is not on the allowlist before any token is minted", async () => {
    const { svc, github, mintToken } = source({}, { allowed: ["vllnt/other"] });
    const error = await failure(svc.load("company-1", gate));
    expect(error).toMatchObject({ kind: "refused", code: "gate_repo_not_allowed" });
    expect(mintToken).not.toHaveBeenCalled();
    expect(github.spy).not.toHaveBeenCalled();
  });

  it("matches the allowlist case-insensitively", async () => {
    const { svc } = source({}, { allowed: ["vllnt/paperclip-gates"] });
    await expect(svc.load("company-1", { ...gate, repo: "VLLNT/Paperclip-Gates" })).resolves.toBeDefined();
  });

  it("asks for a token scoped to the one repository", async () => {
    const { svc, mintToken } = source();
    await svc.load("company-1", gate);
    expect(mintToken).toHaveBeenCalledWith("company-1", "vllnt/paperclip-gates");
  });

  it.each(["ahead", "diverged"])("refuses a commit that is %s of the default branch (not merged by PR)", async (compareStatus) => {
    const { svc, github } = source({ compareStatus });
    const error = await failure(svc.load("company-1", gate));
    expect(error).toMatchObject({ kind: "refused", code: "gate_commit_not_on_default_branch" });
    // The file is never fetched for an unmerged commit.
    expect(github.calls.some((url) => url.includes("/contents/"))).toBe(false);
  });

  it.each(["identical", "behind"])("accepts a commit that is %s relative to the default branch", async (compareStatus) => {
    const { svc } = source({ compareStatus });
    await expect(svc.load("company-1", gate)).resolves.toBeDefined();
  });

  it("compares the pinned commit against the repo's default branch and reads the file at that exact ref", async () => {
    const { svc, github } = source({ defaultBranch: "trunk" });
    await svc.load("company-1", gate);
    const compare = github.calls.find((url) => url.includes("/compare/"))!;
    expect(compare).toContain(`/repos/vllnt/paperclip-gates/compare/trunk...${SHA}`);
    const contents = github.calls.find((url) => url.includes("/contents/"))!;
    expect(contents).toContain("/contents/gates/pr%20open.sh?ref=" + SHA);
  });

  it("refuses a script larger than 64 KB by reported size and by decoded size", async () => {
    const big = "x".repeat(ROUTINE_GATE_LIMITS.scriptMaxBytes + 1);
    const bySize = source({ file: { type: "file", encoding: "base64", size: big.length, content: "" } });
    expect(await failure(bySize.svc.load("company-1", gate))).toMatchObject({ code: "gate_script_too_large" });

    const byContent = source({
      file: { type: "file", encoding: "base64", size: 10, content: Buffer.from(big).toString("base64") },
    });
    expect(await failure(byContent.svc.load("company-1", gate))).toMatchObject({ kind: "refused", code: "gate_script_too_large" });
  });

  it("refuses a path that is not a file", async () => {
    const { svc } = source({ file: { type: "dir" } });
    expect(await failure(svc.load("company-1", gate))).toMatchObject({ kind: "refused", code: "gate_script_not_found" });
  });

  it("maps GitHub 404/422 to not found and 401/403 to access denied (both refusals)", async () => {
    expect(await failure(source({ repoStatus: 404 }).svc.load("c", gate))).toMatchObject({ kind: "refused", code: "gate_script_not_found" });
    expect(await failure(source({ compareStatusCode: 422 }).svc.load("c", gate))).toMatchObject({
      kind: "refused",
      code: "gate_script_not_found",
    });
    expect(await failure(source({ repoStatus: 403 }).svc.load("c", gate))).toMatchObject({
      kind: "refused",
      code: "gate_github_access_denied",
    });
    expect(await failure(source({ repoStatus: 401 }).svc.load("c", gate))).toMatchObject({ code: "gate_github_access_denied" });
  });

  it("treats GitHub 5xx and network failures as unavailable (a retry can fix them)", async () => {
    expect(await failure(source({ repoStatus: 502 }).svc.load("c", gate))).toMatchObject({ kind: "unavailable" });
    expect(await failure(source({ throwNetwork: true }).svc.load("c", gate))).toMatchObject({ kind: "unavailable" });
    expect(await failure(source({ defaultBranch: null }).svc.load("c", gate))).toMatchObject({ kind: "unavailable" });
  });

  it("classifies token-mint failures: a missing connection is a refusal, a GitHub outage is unavailable", async () => {
    const notConnected = source({}, { mintToken: async () => { throw new Error("Connect a GitHub App to this company"); } });
    expect(await failure(notConnected.svc.load("c", gate))).toMatchObject({ kind: "refused", code: "gate_github_not_connected" });

    const outage = source({}, { mintToken: async () => { throw unprocessable("GitHub rejected", { providerStatus: 503 }); } });
    expect(await failure(outage.svc.load("c", gate))).toMatchObject({ kind: "unavailable" });

    const transient = source({}, { mintToken: async () => { throw unprocessable("GitHub is temporarily unavailable. Retry."); } });
    expect(await failure(transient.svc.load("c", gate))).toMatchObject({ kind: "unavailable" });
  });

  it("caches a verified (repo, sha, path) but still checks the allowlist on every load", async () => {
    let allowed = ["vllnt/paperclip-gates"];
    const github = fakeFetch();
    const svc = createGateScriptSource({ allowedRepos: async () => allowed, mintToken: async () => "t", fetchImpl: github.impl });
    await svc.load("company-1", gate);
    const first = github.calls.length;
    await svc.load("company-1", gate);
    expect(github.calls.length).toBe(first);

    allowed = [];
    expect(await failure(svc.load("company-1", gate))).toMatchObject({ code: "gate_repo_not_allowed" });

    allowed = ["vllnt/paperclip-gates"];
    svc.clearCache();
    await svc.load("company-1", gate);
    expect(github.calls.length).toBeGreaterThan(first);
  });
});
