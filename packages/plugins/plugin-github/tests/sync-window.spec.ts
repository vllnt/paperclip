import { afterEach, describe, expect, it, vi } from "vitest";
import { currentSweep, newestUpdate, resumeFrom, SWEEP_INTERVAL_MS, validTime, walkUpdated, type UpdatedPage } from "../src/sync-window.js";

type Row = { id: number; updatedAt: string };
/** Update times 10 s apart, so the 1 s overlap of a resumed request never re-lists a neighbour. */
const at = (step: number) => new Date(Date.UTC(2026, 9, 4, 12, 0, step * 10)).toISOString();
const row = (id: number, step: number): Row => ({ id, updatedAt: at(step) });

/** A listing as GitHub serves it: filtered by `since`, oldest update first, paged. `edit` runs between two requests. */
function listing(rows: Row[], size: number, edit?: (rows: Row[], request: number) => void) {
  const requests: Array<{ since: string | undefined; page: number }> = [];
  async function fetchPage(since: string | undefined, page: number): Promise<UpdatedPage<Row>> {
    requests.push({ since, page });
    edit?.(rows, requests.length);
    const asked = since === undefined ? undefined : Date.parse(resumeFrom(since));
    const matching = rows.filter(item => asked === undefined || Date.parse(item.updatedAt) >= asked).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id - b.id);
    const items = matching.slice((page - 1) * size, page * size);
    return { items, nextPage: page * size < matching.length ? page + 1 : null, cursor: items.at(-1)?.updatedAt ?? null };
  }
  return { fetchPage, requests };
}
async function walk(rows: Row[], size: number, options: { from?: string; deadline?: number; edit?: (rows: Row[], request: number) => void; visitLimit?: number } = {}) {
  const list = listing(rows, size, options.edit);
  const visited: number[] = [], commits: string[] = [];
  const end = await walkUpdated<Row>({ from: options.from, deadline: options.deadline ?? Infinity, fetchPage: list.fetchPage,
    async visit(items) { for (const [index, item] of items.entries()) { if (options.visitLimit !== undefined && visited.length >= options.visitLimit) return index; if (!visited.includes(item.id)) visited.push(item.id); } return items.length; },
    async commit(since) { commits.push(since); } });
  return { end, visited, commits, requests: list.requests };
}

afterEach(() => vi.restoreAllMocks());

describe("walkUpdated", () => {
  it("visits every issue in update order and saves its place after each page (the overlap re-lists the boundary issue)", async () => {
    const result = await walk([row(1, 1), row(2, 2), row(3, 3), row(4, 4), row(5, 5)], 2);
    expect(result.end).toBe("done");
    expect(result.visited).toEqual([1, 2, 3, 4, 5]);
    expect(result.commits).toEqual([at(2), at(3), at(4), at(5)]);
  });

  it("asks again from the page's newest time instead of turning to a page number", async () => {
    const result = await walk([row(1, 1), row(2, 2), row(3, 3), row(4, 4), row(5, 5)], 2);
    expect(result.requests.every(request => request.page === 1)).toBe(true);
  });

  it("misses no issue when an issue that was already read changes during the walk (it moves to the end; a page number would skip issue 3)", async () => {
    const edit = (rows: Row[], request: number) => { if (request === 2) rows[0] = row(1, 9); };
    const result = await walk([row(1, 1), row(2, 2), row(3, 3), row(4, 4), row(5, 5)], 2, { edit });
    expect(result.end).toBe("done");
    expect([...result.visited].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("turns to the next page when a whole page shares the cursor's time, and ends", async () => {
    const same = Array.from({ length: 5 }, (_, index) => row(index + 1, 7));
    const result = await walk(same, 2);
    expect(result.end).toBe("done");
    expect(result.visited).toEqual([1, 2, 3, 4, 5]);
    expect(result.requests.length).toBeLessThan(10);
    expect(result.requests.some(request => request.page > 1)).toBe(true);
  });

  it("moves past a page that holds no issue (only pull requests) by its cursor", async () => {
    const pages: Array<UpdatedPage<Row>> = [{ items: [], nextPage: 2, cursor: at(5) }, { items: [row(9, 6)], nextPage: null, cursor: at(6) }];
    const seen: Array<string | undefined> = [];
    const end = await walkUpdated<Row>({ from: undefined, deadline: Infinity, commit: async () => {}, visit: async items => items.length,
      async fetchPage(since) { seen.push(since); return pages[seen.length - 1] ?? { items: [], nextPage: null, cursor: null }; } });
    expect(end).toBe("done");
    expect(seen).toEqual([undefined, at(5)]);
  });

  it("resumes from the saved place after the deadline", async () => {
    const rows = Array.from({ length: 6 }, (_, index) => row(index + 1, index + 1));
    const first = await walk(rows, 2, { visitLimit: 3 });
    expect(first.end).toBe("budget");
    const saved = first.commits.at(-1);
    expect(saved).toBe(at(3));
    const second = await walk(rows, 2, { from: saved });
    expect(second.end).toBe("done");
    expect([...new Set([...first.visited, ...second.visited])].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("saves the last finished issue when the deadline comes mid-page, so the next run does not redo the page", async () => {
    const rows = Array.from({ length: 6 }, (_, index) => row(index + 1, index + 1));
    const first = await walk(rows, 4, { visitLimit: 2 });
    expect(first).toMatchObject({ end: "budget", visited: [1, 2], commits: [at(2)] });
    const second = await walk(rows, 4, { from: first.commits.at(-1) });
    expect(second.end).toBe("done");
    expect(second.visited).toEqual([2, 3, 4, 5, 6]);
  });

  it("re-lists the unfinished issues that share the saved time after a mid-page deadline", async () => {
    const rows = [row(1, 1), row(2, 2), row(3, 2), row(4, 2), row(5, 3)];
    const first = await walk(rows, 5, { visitLimit: 2 });
    expect(first).toMatchObject({ end: "budget", visited: [1, 2], commits: [at(2)] });
    const second = await walk(rows, 5, { from: first.commits.at(-1) });
    expect(second.visited).toEqual([2, 3, 4, 5]);
  });

  it("saves nothing when the deadline comes before the page's first issue", async () => {
    const result = await walk([row(1, 1), row(2, 2)], 2, { visitLimit: 0 });
    expect(result).toMatchObject({ end: "budget", visited: [], commits: [] });
  });

  it("ends at once when the deadline has passed, and without a request", async () => {
    const result = await walk([row(1, 1)], 2, { deadline: Date.now() - 1 });
    expect(result).toMatchObject({ end: "budget", requests: [] });
  });

  it("stops when the page source says so", async () => {
    const visit = vi.fn(async (items: Row[]) => items.length);
    expect(await walkUpdated<Row>({ from: undefined, deadline: Infinity, fetchPage: async () => null, visit, commit: async () => {} })).toBe("stopped");
    expect(visit).not.toHaveBeenCalled();
  });
});

describe("cursor helpers", () => {
  it("resumes one second before the cursor", () => {
    expect(resumeFrom("2026-10-04T12:00:05Z")).toBe("2026-10-04T12:00:04.000Z");
  });
  it("finds the newest update and ignores a time that does not parse", () => {
    expect(newestUpdate([{ updatedAt: at(1) }, { updatedAt: "nonsense" }, { updatedAt: at(3) }, { updatedAt: at(2) }])).toBe(at(3));
    expect(newestUpdate([])).toBeNull();
    expect(validTime("nonsense")).toBeUndefined();
    expect(validTime(at(1))).toBe(at(1));
  });
  it("starts a full pass for a new repository, continues one in progress, and repeats it after the interval", () => {
    const now = Date.parse(at(0));
    expect(currentSweep({}, undefined, now)).toEqual({ startedAt: at(0) });
    const going = { startedAt: at(0), since: at(5) };
    expect(currentSweep({ sweep: going }, undefined, now + 1000)).toBe(going);
    const done = { sweptAt: at(0) };
    expect(currentSweep(done, undefined, now + SWEEP_INTERVAL_MS - 1)).toBeUndefined();
    expect(currentSweep(done, undefined, now + SWEEP_INTERVAL_MS)).toEqual({ startedAt: new Date(now + SWEEP_INTERVAL_MS).toISOString() });
  });
  it("starts a pass again when the settings were saved after the last one started", () => {
    const now = Date.parse(at(0)) + 60_000;
    expect(currentSweep({ sweptAt: at(0) }, at(30), now)).toEqual({ startedAt: new Date(now).toISOString() });
    expect(currentSweep({ sweptAt: at(30) }, at(0), now)).toBeUndefined();
    expect(currentSweep({ sweep: { startedAt: at(0), since: at(5) } }, at(30), now)).toEqual({ startedAt: new Date(now).toISOString() });
    expect(currentSweep({ sweep: { startedAt: at(30), since: at(35) } }, at(0), now)).toEqual({ startedAt: at(30), since: at(35) });
  });
});
