// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList } from "./command";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Palette({ shouldFilter }: { shouldFilter?: boolean }) {
  return (
    <CommandDialog open onOpenChange={() => {}} commandProps={shouldFilter === undefined ? undefined : { shouldFilter }}>
      <CommandInput value="zz" onValueChange={() => {}} />
      <CommandList>
        <CommandGroup heading="Ours">
          <CommandItem value="action:second">Second by name</CommandItem>
          <CommandItem value="action:first">First by name</CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

function visibleItems() {
  return Array.from(document.querySelectorAll<HTMLElement>("[cmdk-item]"))
    .filter((item) => !item.closest("[hidden]") && item.style.display !== "none");
}

describe("CommandDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  it("passes commandProps to cmdk, so shouldFilter=false keeps every row in render order", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<Palette shouldFilter={false} />);
    });

    const items = visibleItems();
    expect(items.map((item) => item.textContent)).toEqual(["Second by name", "First by name"]);
    expect(items[0]?.getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      root.unmount();
    });
  });

  it("filters rows by default, which is why the palette turns it off", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<Palette />);
    });

    expect(visibleItems()).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });
});
