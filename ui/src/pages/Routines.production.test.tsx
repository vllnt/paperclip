// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Routines } from "./Routines.production";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let currentSearch = "";
const setSearchParamsMock = vi.hoisted(() => vi.fn());
const composerRenderMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(currentSearch), setSearchParamsMock],
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../api/routines", () => ({
  routinesApi: { list: vi.fn(async () => []), update: vi.fn(), run: vi.fn() },
}));
vi.mock("../api/folders", () => ({
  foldersApi: { list: vi.fn(async () => ({ kind: "routine", folders: [], allCount: 0, unfiledCount: 0 })) },
}));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn(async () => []) } }));
vi.mock("../api/issues", () => ({ issuesApi: { list: vi.fn(async () => []) } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: vi.fn(async () => []) } }));
vi.mock("../components/IssuesList", () => ({ IssuesList: () => null }));
vi.mock("../components/PageTabBar", () => ({ PageTabBar: () => null }));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/RoutineRunVariablesDialog", () => ({
  RoutineRunVariablesDialog: () => null,
  routineRunNeedsConfiguration: () => false,
}));
vi.mock("../components/RoutineVariablesEditor", () => ({
  RoutineVariablesEditor: () => null,
  RoutineVariablesHint: () => null,
}));
vi.mock("../components/RoutineComposerDialog", () => ({
  RoutineComposerDialog: (props: ComposerProps) => {
    composerRenderMock(props);
    return null;
  },
}));

interface ComposerProps {
  open: boolean;
  initialDraft?: { projectId?: string; folderId?: string | null };
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Routines page (production build)", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentSearch = "";
    setSearchParamsMock.mockReset();
    composerRenderMock.mockReset();
    localStorage.clear();
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
  });

  async function renderPage() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(() => root!.render(
      <QueryClientProvider client={queryClient}>
        <Routines />
      </QueryClientProvider>,
    ));
    await flush();
  }

  function openComposerProps() {
    return composerRenderMock.mock.calls.map(([props]) => props as ComposerProps).filter((props) => props.open);
  }

  it("opens the composer with the project chosen for a project page's New routine link, then drops the link", async () => {
    currentSearch = "new=1&projectId=project-1&folder=unfiled";

    await renderPage();

    expect(openComposerProps().at(-1)?.initialDraft).toEqual({ folderId: null, projectId: "project-1" });
    expect(setSearchParamsMock).toHaveBeenCalledTimes(1);
    const update = setSearchParamsMock.mock.calls[0]?.[0] as (current: URLSearchParams) => URLSearchParams;
    expect(update(new URLSearchParams(currentSearch)).toString()).toBe("folder=unfiled");
    expect(setSearchParamsMock.mock.calls[0]?.[1]).toEqual({ replace: true });
  });

  it("opens the composer without a project when the link names none", async () => {
    currentSearch = "new=1";

    await renderPage();

    expect(openComposerProps().at(-1)?.initialDraft).toEqual({ folderId: null });
    expect(setSearchParamsMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the composer closed and the URL alone without a New routine link", async () => {
    currentSearch = "projectId=project-1";

    await renderPage();

    expect(openComposerProps()).toEqual([]);
    expect(setSearchParamsMock).not.toHaveBeenCalled();
  });
});
