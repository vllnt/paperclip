import { extractCompanyPrefixFromPath } from "./company-routes";
import { runWithoutStaleChunkReload } from "./stale-chunk-reload";

type ChunkLoader = () => Promise<unknown>;

const SECTION_LOADERS: Readonly<Record<string, ChunkLoader>> = {
  dashboard: () => import("../pages/Dashboard"),
  issues: () => import("../pages/Issues"),
  projects: () => import("../pages/Projects"),
  inbox: () => import("../pages/Inbox"),
};

const ISSUE_DETAIL_LOADER: ChunkLoader = () => import("../pages/IssueDetail");

const ISSUE_LIST_VIEWS: ReadonlySet<string> = new Set(["all", "active", "backlog", "done", "recent"]);

const requested = new Set<ChunkLoader>();

function segmentsAfterCompanyPrefix(pathname: string): string[] {
  const segments = pathname.split("/").filter(Boolean);
  return extractCompanyPrefixFromPath(pathname) ? segments.slice(1) : segments;
}

/**
 * Picks the chunk that the first render of a path needs.
 *
 * @param pathname - A location path such as `/PER/issues/PER-3`.
 * @returns A loader for the busiest routes, or null when the route is not preloaded.
 */
export function routeChunkLoaderFor(pathname: string): ChunkLoader | null {
  const [section = "", detail] = segmentsAfterCompanyPrefix(pathname);
  const key = section.toLowerCase();
  if (key === "issues" && detail && !ISSUE_LIST_VIEWS.has(detail.toLowerCase())) {
    return ISSUE_DETAIL_LOADER;
  }
  return SECTION_LOADERS[key] ?? null;
}

/**
 * Starts fetching the chunk for the page that is open, before React has mounted
 * the router. The fetch then runs while the app boots and loads the company,
 * instead of after the route renders. It reuses the same module as the lazy
 * route, so nothing is fetched twice.
 *
 * @param pathname - The current location path.
 */
export function preloadRouteChunk(pathname: string): void {
  routeChunkLoaderFor(pathname)?.().catch(() => undefined);
}

/**
 * Fetches a route chunk ahead of a likely navigation. It fetches each chunk once,
 * ignores failures, and never reloads the page when a fetch fails.
 *
 * @param load - The loader of the chunk.
 */
function prefetch(load: ChunkLoader): void {
  if (requested.has(load)) return;
  requested.add(load);
  runWithoutStaleChunkReload(load).catch(() => {
    requested.delete(load);
  });
}

/**
 * Prefetches the chunk for a link target when the user is about to follow it:
 * on hover, keyboard focus or touch. This removes the empty gap that the first
 * visit to a page would otherwise show while its chunk loads.
 *
 * @param target - The document to listen on. Defaults to the global document.
 * @returns A function that removes the listeners.
 */
export function installRoutePrefetchOnIntent(target: Document = document): () => void {
  const onIntent = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (anchor.origin !== target.location.origin) return;
    const load = routeChunkLoaderFor(anchor.pathname);
    if (load) prefetch(load);
  };
  const types = ["pointerover", "focusin", "touchstart"] as const;
  for (const type of types) target.addEventListener(type, onIntent, { passive: true });
  return () => {
    for (const type of types) target.removeEventListener(type, onIntent);
  };
}
