// Test-only helpers: a fake `gh` client that serves GraphQL pages from in-memory PR lists.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { GhError } from "./factory-kpi-github.mjs";

export const HOUR = 3_600_000;

// Temporary directories are removed when the test file ends: /tmp is a small tmpfs on some runners.
const madeDirs = [];
after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
});
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

export function mergedNode(number, mergedAtMs, over = {}) {
  return {
    number,
    title: over.title ?? `change ${number}`,
    createdAt: new Date(mergedAtMs - (over.openMs ?? HOUR)).toISOString(),
    mergedAt: new Date(mergedAtMs).toISOString(),
    updatedAt: new Date(over.updatedMs ?? mergedAtMs).toISOString(),
    additions: over.additions ?? 20,
    deletions: over.deletions ?? 5,
    baseRefName: over.base ?? "main",
    headRefName: over.head ?? `feat/${number}`,
    author: { login: over.author ?? "agent" },
    labels: { nodes: (over.labels ?? []).map((name) => ({ name })) },
    reviews: { nodes: (over.reviews ?? []).map(reviewNode) },
    timelineItems: { nodes: [].concat(over.readyMs ?? []).map((ms) => ({ createdAt: new Date(ms).toISOString() })) },
  };
}

export function reviewNode({ state = "APPROVED", atMs, author = "reviewer" }) {
  return { state, submittedAt: new Date(atMs).toISOString(), author: { login: author } };
}

export function openNode(number, over = {}) {
  return {
    number,
    isDraft: over.draft ?? false,
    mergeable: over.mergeable ?? "MERGEABLE",
    reviewDecision: over.reviewDecision ?? null,
    createdAt: new Date(over.createdMs ?? 0).toISOString(),
    author: { login: over.author ?? "agent" },
    reviews: { nodes: (over.reviews ?? []).map(reviewNode) },
    timelineItems: { nodes: over.readyMs ? [{ createdAt: new Date(over.readyMs).toISOString() }] : [] },
    commits: { nodes: [{ commit: { statusCheckRollup: over.checks === undefined ? { state: "SUCCESS" } : over.checks && { state: over.checks } } }] },
  };
}

export function checkRun(name, conclusion, completedMs, status = "COMPLETED") {
  return {
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    completedAt: completedMs === null ? null : new Date(completedMs).toISOString(),
  };
}

export function detailNode(number, mergedMs, { author = "agent", reviews = [], checks = [], truncated = false, reviewsTruncated = false } = {}) {
  return {
    number,
    mergedAt: new Date(mergedMs).toISOString(),
    author: { login: author },
    reviews: {
      pageInfo: { hasNextPage: reviewsTruncated },
      nodes: reviews.map((r) => ({ state: r.state, submittedAt: new Date(r.atMs).toISOString(), author: { login: r.author } })),
    },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: truncated }, nodes: checks } } } }] },
  };
}

/**
 * repos: { "owner/name": { defaultBranch, merged: node[], open?: node[], details?: { [number]: node } } | Error,
 *          "REST <path>": value | Error }
 * Pages come newest-updated first, like the real query. `calls` records every request.
 */
export function fakeGh(repos, { pageSize = 100 } = {}) {
  const calls = [];
  return {
    calls,
    async graphql(_query, variables) {
      calls.push({ kind: "graphql", variables, query: _query });
      const repo = repos[`${variables.owner}/${variables.name}`];
      if (repo instanceof Error) throw repo;
      if (!repo) return { repository: null };
      if (variables.first === undefined) {
        const wanted = [..._query.matchAll(/p(\d+):pullRequest/g)].map((m) => Number(m[1]));
        return { repository: Object.fromEntries(wanted.map((n) => [`p${n}`, repo.details?.[n] ?? null])) };
      }
      if (_query.includes("states:OPEN")) {
        const open = repo.open ?? [];
        const start = variables.cursor ? Number(variables.cursor) : 0;
        const nodes = open.slice(start, start + Math.min(variables.first, pageSize));
        const next = start + nodes.length;
        return { repository: { pullRequests: { pageInfo: { hasNextPage: next < open.length, endCursor: String(next) }, nodes } } };
      }
      const sorted = [...repo.merged].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const start = variables.cursor ? Number(variables.cursor) : 0;
      const nodes = sorted.slice(start, start + Math.min(variables.first, pageSize));
      const next = start + nodes.length;
      return {
        repository: {
          defaultBranchRef: { name: repo.defaultBranch ?? "main" },
          pullRequests: { pageInfo: { hasNextPage: next < sorted.length, endCursor: String(next) }, nodes },
        },
      };
    },
    async rest(path, params) {
      calls.push({ kind: "rest", path, params });
      const handler = repos[`REST ${path}`];
      if (handler instanceof Error) throw handler;
      if (handler === undefined) throw new GhError("notfound", `no fixture for ${path}`, 404);
      return handler;
    },
  };
}

// Evenly spread `perHour` merges per hour over (fromMs, toMs]; numbers start at `firstNumber`.
export function steadyNodes(fromMs, toMs, perHour, firstNumber = 1, over = {}) {
  const nodes = [];
  let number = firstNumber;
  for (let t = fromMs; t < toMs; t += HOUR) {
    for (let i = 1; i <= perHour; i += 1) nodes.push(mergedNode(number++, t + Math.floor((i * HOUR) / (perHour + 1)), over));
  }
  return nodes;
}
