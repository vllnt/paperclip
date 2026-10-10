// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchRedirect } from "./SearchRedirect";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const openCommandPalette = vi.hoisted(() => vi.fn());

vi.mock("../context/CommandActionsContext", () => ({
  useOpenCommandPalette: () => openCommandPalette,
}));

// The app's router wrapper adds the active company prefix; do the same here.
vi.mock("@/lib/router", async () => {
  const router = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    useLocation: router.useLocation,
    Navigate: ({ to, ...props }: { to: string; replace?: boolean }) => <router.Navigate to={`/PAP${to}`} {...props} />,
  };
});

describe("SearchRedirect", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    openCommandPalette.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("sends an old /search link to the dashboard with the launcher open and filled in", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/PAP/search?q=deploy&scope=issues&sort=updated&status=blocked&updatedWithin=7d"]}>
          <Routes>
            <Route path="/:companyPrefix/search" element={<SearchRedirect />} />
            <Route path="/:companyPrefix/dashboard" element={<div data-testid="dashboard">Dashboard</div>} />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(openCommandPalette).toHaveBeenCalledWith("deploy status:blocked updated:>7d scope:issues sort:updated");
    expect(container.querySelector("[data-testid='dashboard']")).not.toBeNull();

    act(() => root.unmount());
  });

  it("opens an empty launcher for a bare /search link", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/PAP/search"]}>
          <Routes>
            <Route path="/:companyPrefix/search" element={<SearchRedirect />} />
            <Route path="/:companyPrefix/dashboard" element={<div data-testid="dashboard">Dashboard</div>} />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(openCommandPalette).toHaveBeenCalledWith("");
    expect(container.querySelector("[data-testid='dashboard']")).not.toBeNull();

    act(() => root.unmount());
  });
});
