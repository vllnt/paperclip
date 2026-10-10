// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function TestHarness({
  onNewIssue,
  onSearch,
  onRunChord,
}: {
  onNewIssue: () => void;
  onSearch?: () => void;
  onRunChord?: (actionId: string) => void;
}) {
  useKeyboardShortcuts({
    onNewIssue,
    onSearch,
    onRunChord,
  });

  return <div>keyboard shortcuts test</div>;
}

describe("useKeyboardShortcuts", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("ignores events already claimed by another handler", () => {
    const root = createRoot(container);
    const onNewIssue = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={onNewIssue} />);
    });

    const event = new KeyboardEvent("keydown", {
      key: "c",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    document.dispatchEvent(event);

    expect(onNewIssue).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("focuses the current page search target on slash", () => {
    const root = createRoot(container);
    const onSearch = vi.fn();
    const input = document.createElement("input");
    input.setAttribute("data-page-search-target", "true");
    vi.spyOn(input, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    document.body.appendChild(input);

    act(() => {
      root.render(<TestHarness onNewIssue={vi.fn()} onSearch={onSearch} />);
    });

    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
      cancelable: true,
    }));

    expect(document.activeElement).toBe(input);
    expect(onSearch).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    input.remove();
  });

  it("falls back to quick search when the page has no search target", () => {
    const root = createRoot(container);
    const onSearch = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={vi.fn()} onSearch={onSearch} />);
    });

    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
      cancelable: true,
    }));

    expect(onSearch).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("ignores bare shortcuts while a modal dialog is open", () => {
    const root = createRoot(container);
    const onNewIssue = vi.fn();
    const onSearch = vi.fn();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);

    act(() => {
      root.render(<TestHarness onNewIssue={onNewIssue} onSearch={onSearch} />);
    });

    for (const key of ["c", "/"]) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    }
    expect(onNewIssue).not.toHaveBeenCalled();
    expect(onSearch).not.toHaveBeenCalled();

    dialog.remove();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    expect(onNewIssue).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("does not intercept the retired Cmd/Ctrl+B collapse shortcut", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TestHarness onNewIssue={vi.fn()} />);
    });

    const metaEvent = new KeyboardEvent("keydown", {
      key: "b",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(metaEvent);
    expect(metaEvent.defaultPrevented).toBe(false);

    const ctrlEvent = new KeyboardEvent("keydown", {
      key: "b",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(ctrlEvent);
    expect(ctrlEvent.defaultPrevented).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  const pressKey = (key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event;
  };

  it("navigates to the inbox on the g \u2192 i chord", () => {
    const root = createRoot(container);
    const onRunChord = vi.fn();
    const onNewIssue = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={onNewIssue} onRunChord={onRunChord} />);
    });

    // Bare "i" does nothing.
    pressKey("i");
    expect(onRunChord).not.toHaveBeenCalled();

    pressKey("g");
    const chordEvent = pressKey("i");
    expect(onRunChord).toHaveBeenCalledTimes(1);
    expect(onRunChord).toHaveBeenCalledWith("nav.inbox");
    expect(chordEvent.defaultPrevented).toBe(true);

    // Chord disarms after firing.
    pressKey("i");
    expect(onRunChord).toHaveBeenCalledTimes(1);
    expect(onNewIssue).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("runs each catalog g chord", () => {
    const root = createRoot(container);
    const onRunChord = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={vi.fn()} onRunChord={onRunChord} />);
    });

    const expected: Array<[string, string]> = [
      ["d", "nav.dashboard"],
      ["t", "nav.tasks"],
      ["a", "nav.agents"],
      ["p", "nav.projects"],
      ["o", "nav.goals"],
      ["r", "nav.routines"],
      ["v", "nav.approvals"],
      ["e", "nav.activity"],
      ["m", "nav.costs"],
      ["s", "nav.settings"],
      ["k", "nav.skills"],
    ];
    for (const [key, actionId] of expected) {
      pressKey("g");
      expect(pressKey(key).defaultPrevented).toBe(true);
      expect(onRunChord).toHaveBeenLastCalledWith(actionId);
    }
    expect(onRunChord).toHaveBeenCalledTimes(expected.length);

    // An unknown second key disarms without running anything.
    pressKey("g");
    expect(pressKey("z").defaultPrevented).toBe(false);
    pressKey("d");
    expect(onRunChord).toHaveBeenCalledTimes(expected.length);

    act(() => {
      root.unmount();
    });
  });

  it("keeps a chord armed when the host re-renders with new handlers", () => {
    const root = createRoot(container);
    const onRunChord = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={() => {}} onRunChord={onRunChord} />);
    });

    pressKey("g");
    // The layout passes inline handlers, so any re-render gives new identities.
    act(() => {
      root.render(<TestHarness onNewIssue={() => {}} onRunChord={onRunChord} />);
    });
    expect(pressKey("d").defaultPrevented).toBe(true);
    expect(onRunChord).toHaveBeenCalledWith("nav.dashboard");

    act(() => {
      root.unmount();
    });
  });

  it("swallows armed chord keys instead of firing bare shortcuts", () => {
    const root = createRoot(container);
    const onRunChord = vi.fn();
    const onNewIssue = vi.fn();

    act(() => {
      root.render(<TestHarness onNewIssue={onNewIssue} onRunChord={onRunChord} />);
    });

    // g \u2192 c is the issue-detail focus-comment chord; globally it must not
    // open the new-issue dialog.
    pressKey("g");
    pressKey("c");
    expect(onNewIssue).not.toHaveBeenCalled();
    expect(onRunChord).not.toHaveBeenCalledWith("nav.inbox");

    // Bare "c" still creates.
    pressKey("c");
    expect(onNewIssue).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

});
