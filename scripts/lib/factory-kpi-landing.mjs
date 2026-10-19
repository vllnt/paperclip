// Merges that did not go into the default branch (stacked PRs, bridges, feature-branch work) are not
// landed yet, so they are reported next to the KPI and never counted in it. Nothing here can change
// the headline numbers: a failed read only blanks this section.

import { GhError, mapLimit, parseRepo } from "./factory-kpi-github.mjs";
import { DAY_MS } from "./factory-kpi-metrics.mjs";

const BASES_PER_QUERY = 20;
const MAX_BASES = 60;
const CARRIERS_PER_BASE = 5;
const MAX_CHAIN = 10;
const MAX_BASES_LISTED = 5;
const MAX_STACKED_LISTED = 10;

/**
 * For each base branch, the PRs of this repository that were opened from that branch (open or merged),
 * newest first. A PR from a fork is not a carrier: its branch lives in another repository.
 */
export async function fetchCarriers(gh, repo, baseRefs) {
  const { owner, name } = parseRepo(repo);
  const carriers = new Map();
  for (let i = 0; i < baseRefs.length; i += BASES_PER_QUERY) {
    const chunk = baseRefs.slice(i, i + BASES_PER_QUERY);
    const declared = chunk.map((_, k) => `$h${k}:String!`).join(",");
    const fields = chunk
      .map(
        (_, k) =>
          `c${k}:pullRequests(headRefName:$h${k},states:[OPEN,MERGED],first:${CARRIERS_PER_BASE},orderBy:{field:CREATED_AT,direction:DESC}){nodes{number state baseRefName headRefOid isCrossRepository}}`,
      )
      .join(" ");
    const query = `query($owner:String!,$name:String!,${declared}){repository(owner:$owner,name:$name){${fields}}}`;
    const variables = { owner, name, ...Object.fromEntries(chunk.map((ref, k) => [`h${k}`, ref])) };
    const data = await gh.graphql(query, variables);
    if (!data?.repository) throw new GhError("notfound", `repository ${repo} not visible to this token`);
    chunk.forEach((ref, k) => {
      const nodes = (data.repository[`c${k}`]?.nodes ?? []).filter((n) => !n.isCrossRepository);
      carriers.set(
        ref,
        nodes.map((n) => ({ number: n.number, state: n.state, baseRef: n.baseRefName, headOid: n.headRefOid ?? null })),
      );
    });
  }
  return carriers;
}

/**
 * What a merge into a non-default branch became. `carried`: another PR of the repository was opened
 * from the branch it merged into, so it travels with that PR. `evidence` is "tip" when the merge
 * commit is exactly that PR's head commit (the strongest proof), else "branch" (the link is the branch
 * name only; ancestry is not checked). `unattached`: no PR carries the branch.
 */
export function classifyMerge(pr, carriers) {
  const options = (carriers.get(pr.baseRef) ?? []).filter((c) => c.number !== pr.number);
  if (!options.length) return { class: "unattached" };
  const exact = pr.mergeOid ? options.find((c) => c.headOid === pr.mergeOid) : undefined;
  const carrier = exact ?? options[0];
  return { class: "carried", carrier: carrier.number, carrierState: carrier.state, evidence: exact ? "tip" : "branch" };
}

/**
 * Per landed PR, the merged PRs that went into its branch before it landed, following base -> head
 * links through merged PRs (a stack of stacks). Only merges inside the fetched window are known, so the
 * counts are lower bounds. Returns Map(landed number -> [stacked numbers]).
 */
export function stackedUnderLanded({ defaultBranch, landed, other }) {
  const byHead = new Map();
  for (const pr of [...landed, ...other]) {
    if (pr.crossRepo || !pr.headRef) continue;
    const known = byHead.get(pr.headRef);
    if (!known || pr.mergedAtMs > known.mergedAtMs) byHead.set(pr.headRef, pr);
  }
  const under = new Map();
  for (const pr of other) {
    let current = pr;
    // MAX_CHAIN also ends a loop of branches that point at each other; none of those ever lands.
    for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
      const next = byHead.get(current.baseRef);
      // A merge into a branch after that branch's PR landed is not part of what landed.
      if (!next || current.mergedAtMs > next.mergedAtMs) break;
      if (next.baseRef === defaultBranch) {
        under.set(next.number, [...(under.get(next.number) ?? []), pr.number]);
        break;
      }
      current = next;
    }
  }
  return under;
}

/** True when the PR merged in the 24 h that end at endMs, the window of the landing section. */
export const inLastDay = (pr, endMs) => pr.mergedAtMs > endMs - DAY_MS && pr.mergedAtMs <= endMs;

const byCountThenName = (a, b) => b.count - a.count || (a.base < b.base ? -1 : a.base > b.base ? 1 : 0);

/** One repository's landing section, from its merged PRs and (when readable) the carriers of the bases. */
export function summarizeLanding({ repo, defaultBranch, landed, other, carriers, error = null, complete = true, endMs }) {
  const landed24 = landed.filter((pr) => inLastDay(pr, endMs));
  const other24 = other.filter((pr) => inLastDay(pr, endMs)).sort((a, b) => b.mergedAtMs - a.mergedAtMs);
  const classes = other24.map((pr) => ({
    pr,
    ...(carriers ? classifyMerge(pr, carriers) : { class: "unknown" }),
  }));
  const count = (cls) => classes.filter((c) => c.class === cls).length;
  const bases = new Map();
  for (const { pr } of classes) bases.set(pr.baseRef, (bases.get(pr.baseRef) ?? 0) + 1);
  const under = stackedUnderLanded({ defaultBranch, landed, other });
  const landed24Numbers = new Set(landed24.map((pr) => pr.number));
  return {
    repo,
    defaultBranch,
    complete,
    ...(error ? { error } : {}),
    landed24h: landed24.length,
    other24h: other24.length,
    carried: count("carried"),
    tipVerified: classes.filter((c) => c.evidence === "tip").length,
    unattached: count("unattached"),
    unknown: count("unknown"),
    byBase: [...bases].map(([base, n]) => ({ base, count: n })).sort(byCountThenName).slice(0, MAX_BASES_LISTED),
    stacked: [...under]
      .filter(([number]) => landed24Numbers.has(number))
      .map(([number, list]) => ({ number, stacked: list.length }))
      .sort((a, b) => b.stacked - a.stacked || a.number - b.number)
      .slice(0, MAX_STACKED_LISTED),
  };
}

/**
 * The landing section for every repository that was read. A repository whose carriers cannot be read
 * keeps its counts and marks the classification unknown; the error stays inside this section.
 */
export async function collectLanding(gh, results, { endMs }) {
  const readable = results.filter((r) => !r.error);
  const repos = await mapLimit(readable, async (r) => {
    const bases = [...new Set(r.otherMerged.filter((pr) => inLastDay(pr, endMs)).map((pr) => pr.baseRef))].slice(0, MAX_BASES);
    let carriers;
    let error = null;
    try {
      carriers = await fetchCarriers(gh, r.repo, bases);
    } catch (e) {
      carriers = null;
      error = { kind: e instanceof GhError ? e.kind : "other", message: e.message };
    }
    return summarizeLanding({
      repo: r.repo,
      defaultBranch: r.defaultBranch,
      landed: r.prs,
      other: r.otherMerged,
      carriers,
      error,
      complete: r.complete,
      endMs,
    });
  });
  const sum = (key) => repos.reduce((total, r) => total + r[key], 0);
  return {
    windowHours: 24,
    landed24h: sum("landed24h"),
    other24h: sum("other24h"),
    raw24h: sum("landed24h") + sum("other24h"),
    carried: sum("carried"),
    tipVerified: sum("tipVerified"),
    unattached: sum("unattached"),
    unknown: sum("unknown"),
    repos,
  };
}
