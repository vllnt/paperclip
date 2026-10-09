// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const loads = vi.hoisted(() => ({ Dashboard: 0, Issues: 0, Projects: 0, Inbox: 0, IssueDetail: 0 }));

type RoutePreload = typeof import("./route-preload");

let routePreload: RoutePreload;

beforeEach(async () => {
  vi.resetModules();
  for (const key of Object.keys(loads)) Reflect.set(loads, key, 0);
  for (const page of ["Dashboard", "Issues", "Projects", "Inbox", "IssueDetail"]) {
    vi.doMock(`../pages/${page}`, () => {
      Reflect.set(loads, page, Reflect.get(loads, page) + 1);
      return {};
    });
  }
  routePreload = await import("./route-preload");
});

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function anchor(href: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = "link";
  document.body.appendChild(link);
  return link;
}

describe("routeChunkLoaderFor", () => {
  it("preloads the busiest sections", () => {
    for (const path of ["/PER/dashboard", "/PER/issues", "/PER/projects", "/PER/inbox/mine"]) {
      expect(routePreload.routeChunkLoaderFor(path), path).toBeTypeOf("function");
    }
  });

  it("uses a different chunk for an issue page than for the issue list", () => {
    const list = routePreload.routeChunkLoaderFor("/PER/issues");
    const detail = routePreload.routeChunkLoaderFor("/PER/issues/PER-3");

    expect(detail).toBeTypeOf("function");
    expect(detail).not.toBe(list);
  });

  it("treats the issue list views as the list", () => {
    const list = routePreload.routeChunkLoaderFor("/PER/issues");

    for (const view of ["all", "active", "backlog", "done", "recent"]) {
      expect(routePreload.routeChunkLoaderFor(`/PER/issues/${view}`), view).toBe(list);
    }
  });

  it("does not preload other routes", () => {
    for (const path of ["/PER/agents/all", "/PER/costs", "/PER/company/settings", "/auth", "/", "/PER"]) {
      expect(routePreload.routeChunkLoaderFor(path), path).toBeNull();
    }
  });

  it("matches a path without a company prefix", () => {
    expect(routePreload.routeChunkLoaderFor("/dashboard")).toBeTypeOf("function");
  });
});

describe("preloadRouteChunk", () => {
  it("loads the chunk of the open page and nothing else", async () => {
    routePreload.preloadRouteChunk("/PER/issues/PER-3");
    await settle();

    expect(loads.IssueDetail).toBe(1);
    expect(loads.Issues).toBe(0);
  });

  it("does nothing for a route it does not know", async () => {
    routePreload.preloadRouteChunk("/PER/costs");
    await settle();

    expect(Object.values(loads).every((count) => count === 0)).toBe(true);
  });
});

describe("installRoutePrefetchOnIntent", () => {
  it.each(["pointerover", "focusin", "touchstart"])("prefetches a busy route on %s", async (type) => {
    const remove = routePreload.installRoutePrefetchOnIntent();
    const link = anchor("/PER/dashboard");

    link.dispatchEvent(new Event(type, { bubbles: true }));
    await settle();

    expect(loads.Dashboard).toBe(1);
    remove();
    link.remove();
  });

  it("prefetches from an element inside the link", async () => {
    const remove = routePreload.installRoutePrefetchOnIntent();
    const link = anchor("/PER/projects");
    const inner = document.createElement("span");
    link.appendChild(inner);

    inner.dispatchEvent(new Event("pointerover", { bubbles: true }));
    await settle();

    expect(loads.Projects).toBe(1);
    remove();
    link.remove();
  });

  it("fetches each chunk once however often the pointer moves over it", async () => {
    const remove = routePreload.installRoutePrefetchOnIntent();
    const link = anchor("/PER/inbox/mine");

    for (let index = 0; index < 5; index += 1) link.dispatchEvent(new Event("pointerover", { bubbles: true }));
    await settle();

    expect(loads.Inbox).toBe(1);
    remove();
    link.remove();
  });

  it("ignores links to other routes and to other sites", async () => {
    const remove = routePreload.installRoutePrefetchOnIntent();
    const same = anchor("/PER/agents/all");
    const other = anchor("https://example.com/PER/dashboard");

    same.dispatchEvent(new Event("pointerover", { bubbles: true }));
    other.dispatchEvent(new Event("pointerover", { bubbles: true }));
    await settle();

    expect(Object.values(loads).every((count) => count === 0)).toBe(true);
    remove();
    same.remove();
    other.remove();
  });

  it("stops listening after it is removed", async () => {
    const remove = routePreload.installRoutePrefetchOnIntent();
    const link = anchor("/PER/dashboard");
    remove();

    link.dispatchEvent(new Event("pointerover", { bubbles: true }));
    await settle();

    expect(loads.Dashboard).toBe(0);
    link.remove();
  });
});
