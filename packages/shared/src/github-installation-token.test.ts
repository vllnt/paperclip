import { describe, expect, it } from "vitest";
import { mintGitHubInstallationToken } from "./github-installation-token.js";

describe("mintGitHubInstallationToken (I-RO)", () => {
  const fence = ["anthm-fr/songtrivia", "anthm-fr/linkzic"];
  const recorder = () => {
    const calls: unknown[] = [];
    return { calls, send: async (call: unknown) => { calls.push(call); return "ghs_token"; } };
  };

  it("asks GitHub for exactly what it was given when no company writes as the App's user", async () => {
    const { calls, send } = recorder();
    expect(await mintGitHubInstallationToken({ installationId: 101, repositories: [22], permissions: { issues: "write" } }, null, send)).toBe("ghs_token");
    expect(await mintGitHubInstallationToken({ installationId: "101" }, null, send)).toBe("ghs_token");
    expect(calls).toEqual([
      { path: "/app/installations/101/access_tokens", route: "POST /app/installations/{installation_id}/access_tokens", installationId: "101", body: { repository_ids: [22], permissions: { issues: "write" } } },
      { path: "/app/installations/101/access_tokens", route: "POST /app/installations/{installation_id}/access_tokens", installationId: "101", body: {} },
    ]);
  });

  it("refuses, before asking GitHub, any token of an App-user company's App that is not read-only and named", async () => {
    const { calls, send } = recorder();
    for (const [label, request] of [
      ["a write scope", { installationId: 101, repositories: [22], permissions: { issues: "write" } }],
      ["every permission", { installationId: 101, repositories: [22] }],
      ["the whole installation", { installationId: 101, permissions: { metadata: "read" } }],
      ["two repositories by ID", { installationId: 101, repositories: [22, 23], permissions: { metadata: "read" } }],
      ["a repository outside the fence", { installationId: 101, repositories: ["vllnt/paperclip"], permissions: { metadata: "read" } }],
    ] as const) await expect(mintGitHubInstallationToken(request, fence, send), label).rejects.toThrow(/Refused to mint a GitHub App installation token/);
    await expect(mintGitHubInstallationToken({ installationId: "../x" }, null, send)).rejects.toThrow(/installation ID/);
    expect(calls).toEqual([]);
    expect(await mintGitHubInstallationToken({ installationId: 101, repositories: ["Anthm-FR/songtrivia", "Anthm-FR/linkzic"], permissions: { metadata: "read" } }, fence, send)).toBe("ghs_token");
    expect(calls).toMatchObject([{ body: { repositories: ["songtrivia", "linkzic"], permissions: { metadata: "read" } } }]);
    await expect(mintGitHubInstallationToken({ installationId: 101 }, null, async () => "")).rejects.toThrow(/did not return/);
  });
});
