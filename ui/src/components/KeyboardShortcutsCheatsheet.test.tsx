// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMAND_ACTIONS } from "@paperclipai/shared/command-actions";
import { KeyboardShortcutsCheatsheetContent } from "./KeyboardShortcutsCheatsheet";

describe("KeyboardShortcutsCheatsheet", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("does not advertise the retired sidebar collapse shortcut", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(<KeyboardShortcutsCheatsheetContent />);
    });

    const row = [...container.querySelectorAll("span")].find(
      (node) => node.textContent?.trim() === "Collapse or expand sidebar",
    )?.parentElement;
    expect(row).toBeUndefined();

    flushSync(() => {
      root.unmount();
    });
  });

  it("lists every launcher shortcut from the action catalog", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(<KeyboardShortcutsCheatsheetContent />);
    });

    const rows = [...container.querySelectorAll("[data-shortcut-row]")].map((row) => ({
      label: row.querySelector("span")?.textContent ?? "",
      keys: [...row.querySelectorAll("kbd")].map((key) => key.textContent),
    }));
    for (const action of COMMAND_ACTIONS) {
      if (!action.shortcut) continue;
      expect(rows, action.id).toContainEqual({ label: action.title, keys: [...action.shortcut] });
    }
    const headings = [...container.querySelectorAll("h3")].map((heading) => heading.textContent);
    expect(headings).toEqual(["Go to", "Global", "Task detail", "Inbox", "Decisions"]);

    flushSync(() => {
      root.unmount();
    });
  });
});
