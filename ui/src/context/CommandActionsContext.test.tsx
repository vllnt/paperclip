// @vitest-environment jsdom

import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommandActionsProvider,
  useCommandActions,
  useRegisterCommandActions,
  type CommandActionBindings,
  type CommandActionsHandle,
  type CommandActionsValue,
} from "./CommandActionsContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) },
}));

let latest: CommandActionsValue | null = null;
const NO_GLOBAL_BINDINGS: CommandActionBindings = {};

function Probe() {
  latest = useCommandActions();
  return null;
}

function Page({ bindings }: { bindings: CommandActionBindings }) {
  useRegisterCommandActions(bindings);
  return null;
}

describe("CommandActionsProvider", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(node: ReactNode, globalBindings: CommandActionBindings = NO_GLOBAL_BINDINGS, handleRef?: React.Ref<CommandActionsHandle>) {
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <CommandActionsProvider globalBindings={globalBindings} handleRef={handleRef}>
            {node}
            <Probe />
          </CommandActionsProvider>
        </QueryClientProvider>,
      );
    });
  }

  function available(id: string) {
    return latest?.actions.find((action) => action.id === id);
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
  });

  it("lists global actions as non-contextual and page actions as contextual", () => {
    render(<Page bindings={{ "issue.archive-from-inbox": { run: vi.fn() } }} />, { "nav.dashboard": { run: vi.fn() } });

    expect(available("nav.dashboard")?.contextual).toBe(false);
    expect(available("issue.archive-from-inbox")?.contextual).toBe(true);
    expect([...(latest?.contextualIds ?? [])]).toEqual(["issue.archive-from-inbox"]);
    // Catalog actions without a handler are not available.
    expect(available("nav.tasks")).toBeUndefined();
  });

  it("lets the newest page registration win and restores the older one when it unmounts", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <>
        <Page bindings={{ "issue.archive-from-inbox": { run: outer } }} />
        <Page bindings={{ "issue.archive-from-inbox": { run: inner, title: "Archive this one" } }} />
      </>,
    );
    expect(available("issue.archive-from-inbox")?.title).toBe("Archive this one");
    act(() => {
      latest?.run("issue.archive-from-inbox");
    });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    render(<Page bindings={{ "issue.archive-from-inbox": { run: outer } }} />);
    act(() => {
      latest?.run("issue.archive-from-inbox");
    });
    expect(outer).toHaveBeenCalledTimes(1);

    render(null);
    expect(available("issue.archive-from-inbox")).toBeUndefined();
    let ran = true;
    act(() => {
      ran = latest?.run("issue.archive-from-inbox") ?? true;
    });
    expect(ran).toBe(false);
  });

  it("treats a null binding as 'this page does not provide the action'", () => {
    const global = vi.fn();
    render(<Page bindings={{ "issue.open-file": null, "ui.shortcuts": null }} />, { "ui.shortcuts": { run: global } });

    expect(available("issue.open-file")).toBeUndefined();
    // Another provider of the same action still applies.
    expect(available("ui.shortcuts")?.contextual).toBe(false);
  });

  it("runs the latest handler a page passed, without re-registering", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<Page bindings={{ "issue.archive-from-inbox": { run: first } }} />);
    const registeredActions = latest?.actions;
    render(<Page bindings={{ "issue.archive-from-inbox": { run: second } }} />);
    expect(latest?.actions).toBe(registeredActions);

    act(() => {
      latest?.run("issue.archive-from-inbox");
    });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("records each run for frecency and exposes run and open through the handle", () => {
    const handleRef = createRef<CommandActionsHandle>();
    const toDashboard = vi.fn();
    render(null, { "nav.dashboard": { run: toDashboard } }, handleRef);

    act(() => {
      handleRef.current?.run("nav.dashboard");
    });
    expect(toDashboard).toHaveBeenCalledTimes(1);
    expect(latest?.usage["nav.dashboard"]?.count).toBe(1);
    const stored = window.localStorage.getItem("paperclip.commandActionUsage.v1:company-1:user-1")
      ?? window.localStorage.getItem("paperclip.commandActionUsage.v1:company-1:__local_board__");
    expect(JSON.parse(stored ?? "{}")["nav.dashboard"]?.count).toBe(1);

    expect(latest?.paletteOpen).toBe(false);
    act(() => {
      handleRef.current?.openCommandPalette();
    });
    expect(latest?.paletteOpen).toBe(true);
  });
});
