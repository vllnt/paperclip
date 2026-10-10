// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  findPageSearchShortcutTarget,
  focusPageSearchShortcutTarget,
  hasBlockingShortcutDialog,
  isInsideOpenModalDialog,
  isKeyboardShortcutTextInputTarget,
  resolveAttentionQueueKeyAction,
  resolveGoChordKeyAction,
  shouldOpenCommandLauncher,
  resolveIssueDetailGoKeyAction,
  resolveInboxQuickArchiveKeyAction,
  resolveInboxUndoArchiveKeyAction,
  shouldBlurPageSearchOnEnter,
  shouldBlurPageSearchOnEscape,
} from "./keyboardShortcuts";

describe("keyboardShortcuts helpers", () => {
  describe("resolveAttentionQueueKeyAction", () => {
    const baseArgs = {
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: document.body,
      hasOpenDialog: false,
      hasSelection: true,
    };

    it.each([
      ["j", "next"],
      ["ArrowDown", "next"],
      ["k", "previous"],
      ["ArrowUp", "previous"],
      ["Enter", "toggle"],
      ["x", "dismiss"],
    ] as const)("maps %s to %s", (key, expected) => {
      expect(resolveAttentionQueueKeyAction({ ...baseArgs, key })).toBe(expected);
    });

    it("does not act while typing, dialog-bound, modified, or unselected", () => {
      const input = document.createElement("input");
      expect(resolveAttentionQueueKeyAction({ ...baseArgs, key: "j", target: input })).toBe("ignore");
      expect(resolveAttentionQueueKeyAction({ ...baseArgs, key: "j", hasOpenDialog: true })).toBe("ignore");
      expect(resolveAttentionQueueKeyAction({ ...baseArgs, key: "j", metaKey: true })).toBe("ignore");
      expect(resolveAttentionQueueKeyAction({ ...baseArgs, key: "Enter", hasSelection: false })).toBe("ignore");
    });
  });

  it("detects editable shortcut targets", () => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div contenteditable="true"><span id="contenteditable-child">Editable</span></div>
      <div role="textbox"><span id="textbox-child">Textbox</span></div>
      <button id="button">Action</button>
    `;

    const editableChild = wrapper.querySelector("#contenteditable-child");
    const textboxChild = wrapper.querySelector("#textbox-child");
    const button = wrapper.querySelector("#button");

    expect(isKeyboardShortcutTextInputTarget(editableChild)).toBe(true);
    expect(isKeyboardShortcutTextInputTarget(textboxChild)).toBe(true);
    expect(isKeyboardShortcutTextInputTarget(button)).toBe(false);
  });

  it("reports when a modal dialog is open", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div role="dialog" aria-modal="true"></div>`;

    expect(hasBlockingShortcutDialog(root)).toBe(true);
    expect(hasBlockingShortcutDialog(document.createElement("div"))).toBe(false);
  });

  it("ignores non-dialog elements that happen to be aria-modal", () => {
    const root = document.createElement("div");
    root.innerHTML = `<section aria-modal="true"></section>`;

    expect(hasBlockingShortcutDialog(root)).toBe(false);
  });

  it("finds the visible page search shortcut target", () => {
    const root = document.createElement("div");
    const hidden = document.createElement("input");
    hidden.setAttribute("data-page-search-target", "true");
    vi.spyOn(hidden, "getClientRects").mockReturnValue([] as unknown as DOMRectList);

    const visible = document.createElement("input");
    visible.setAttribute("data-page-search-target", "true");
    vi.spyOn(visible, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);

    root.append(hidden, visible);
    document.body.appendChild(root);

    expect(findPageSearchShortcutTarget(root)).toBe(visible);

    root.remove();
  });

  it("focuses and selects the page search shortcut target", () => {
    const root = document.createElement("div");
    const input = document.createElement("input");
    input.value = "existing query";
    input.setAttribute("data-page-search-target", "true");
    vi.spyOn(input, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    root.appendChild(input);
    document.body.appendChild(root);

    expect(focusPageSearchShortcutTarget(root)).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);

    root.remove();
  });

  it("blurs page search on a plain Enter press", () => {
    expect(shouldBlurPageSearchOnEnter({
      key: "Enter",
      isComposing: false,
    })).toBe(true);
  });

  it("keeps focus while composing with an IME", () => {
    expect(shouldBlurPageSearchOnEnter({
      key: "Enter",
      isComposing: true,
    })).toBe(false);
  });

  it("blurs page search on Escape when the field is already empty", () => {
    expect(shouldBlurPageSearchOnEscape({
      key: "Escape",
      isComposing: false,
      currentValue: "",
    })).toBe(true);
  });

  it("keeps focus on the first Escape while the field still has text", () => {
    expect(shouldBlurPageSearchOnEscape({
      key: "Escape",
      isComposing: false,
      currentValue: "query",
    })).toBe(false);
  });

  it("archives only the first clean y press", () => {
    const button = document.createElement("button");

    expect(resolveInboxQuickArchiveKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "y",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("archive");
  });

  it("ignores non-y keypresses", () => {
    const button = document.createElement("button");

    expect(resolveInboxQuickArchiveKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "n",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("ignore");
  });

  it("stays inert for modifier combos before a real keypress", () => {
    const button = document.createElement("button");

    expect(resolveInboxQuickArchiveKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "Meta",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("ignore");

    expect(resolveInboxQuickArchiveKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "y",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("ignore");
  });

  it("ignores input typing instead of archiving", () => {
    const input = document.createElement("input");

    expect(resolveInboxQuickArchiveKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "y",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: input,
      hasOpenDialog: false,
    })).toBe("ignore");
  });

  it("undoes only a clean lowercase u press when an archive is available", () => {
    const button = document.createElement("button");

    expect(resolveInboxUndoArchiveKeyAction({
      hasUndoableArchive: true,
      defaultPrevented: false,
      key: "u",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("undo_archive");
  });

  it("keeps uppercase U available for mark-unread handling", () => {
    const button = document.createElement("button");

    expect(resolveInboxUndoArchiveKeyAction({
      hasUndoableArchive: true,
      defaultPrevented: false,
      key: "U",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("ignore");
  });

  it("arms go-to-inbox on a clean g press", () => {
    const button = document.createElement("button");

    expect(resolveIssueDetailGoKeyAction({
      armed: false,
      defaultPrevented: false,
      key: "g",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("arm");
  });

  it("navigates to inbox on i after g", () => {
    const button = document.createElement("button");

    expect(resolveIssueDetailGoKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "i",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("navigate_inbox");
  });

  it("focuses the comment composer on c after g", () => {
    const button = document.createElement("button");

    expect(resolveIssueDetailGoKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "c",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("focus_comment");
  });

  it("opens the file viewer on f after g", () => {
    const button = document.createElement("button");

    expect(resolveIssueDetailGoKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "f",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: button,
      hasOpenDialog: false,
    })).toBe("open_file_viewer");
  });

  it("disarms go-to-inbox instead of firing from an editor", () => {
    const input = document.createElement("textarea");

    expect(resolveIssueDetailGoKeyAction({
      armed: true,
      defaultPrevented: false,
      key: "i",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: input,
      hasOpenDialog: false,
    })).toBe("disarm");
  });
});

describe("resolveGoChordKeyAction", () => {
  const chords = new Map([["d", "nav.dashboard"]]);
  const base = {
    armed: false,
    chords,
    defaultPrevented: false,
    key: "g",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    target: null,
    hasOpenDialog: false,
  };

  it("arms on g and runs the mapped action on the next key", () => {
    expect(resolveGoChordKeyAction(base)).toEqual({ type: "arm" });
    expect(resolveGoChordKeyAction({ ...base, armed: true, key: "D" })).toEqual({ type: "run", actionId: "nav.dashboard" });
    expect(resolveGoChordKeyAction({ ...base, armed: true, key: "x" })).toEqual({ type: "disarm" });
  });

  it("ignores typing in text fields and keys over a modal dialog", () => {
    const input = document.createElement("input");
    expect(resolveGoChordKeyAction({ ...base, target: input })).toEqual({ type: "ignore" });
    expect(resolveGoChordKeyAction({ ...base, armed: true, key: "d", target: input })).toEqual({ type: "disarm" });
    expect(resolveGoChordKeyAction({ ...base, hasOpenDialog: true })).toEqual({ type: "ignore" });
  });

  it("ignores modified keys and disarms on keys another handler claimed", () => {
    expect(resolveGoChordKeyAction({ ...base, metaKey: true })).toEqual({ type: "ignore" });
    expect(resolveGoChordKeyAction({ ...base, armed: true, key: "d", defaultPrevented: true })).toEqual({ type: "disarm" });
  });
});

describe("hasBlockingShortcutDialog", () => {
  function mount(attributes: Record<string, string>) {
    const root = document.createElement("div");
    const element = document.createElement("div");
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    root.appendChild(element);
    return root;
  }

  it("detects open Radix modal contents, which carry no aria-modal", () => {
    expect(hasBlockingShortcutDialog(mount({ role: "dialog", "data-slot": "dialog-content", "data-state": "open" }))).toBe(true);
    expect(hasBlockingShortcutDialog(mount({ role: "dialog", "data-slot": "sheet-content", "data-state": "open" }))).toBe(true);
    expect(hasBlockingShortcutDialog(mount({ role: "alertdialog", "data-slot": "alert-dialog-content", "data-state": "open" }))).toBe(true);
    expect(hasBlockingShortcutDialog(mount({ role: "dialog", "aria-modal": "true" }))).toBe(true);
  });

  it("detects raw Radix dialog content without shadcn slots (the image gallery)", () => {
    expect(hasBlockingShortcutDialog(mount({ role: "dialog", "data-state": "open" }))).toBe(true);
  });

  it("ignores closing dialogs, and does not treat popovers as modal", () => {
    expect(hasBlockingShortcutDialog(mount({ role: "dialog", "data-slot": "dialog-content", "data-state": "closed" }))).toBe(false);
    // A closing dialog stays mounted for its exit animation, even with aria-modal.
    expect(hasBlockingShortcutDialog(mount({ role: "dialog", "aria-modal": "true", "data-state": "closed" }))).toBe(false);
    expect(hasBlockingShortcutDialog(mount({ role: "alertdialog", "aria-modal": "true", "data-state": "closed" }))).toBe(false);
    expect(hasBlockingShortcutDialog(mount({ role: "alertdialog", "aria-modal": "true" }))).toBe(true);
    // Radix renders popover content (also role=dialog) inside a popper wrapper.
    const root = document.createElement("div");
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    const popover = document.createElement("div");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("data-state", "open");
    wrapper.appendChild(popover);
    root.appendChild(wrapper);
    // A popover is not modal, but it still owns the keyboard while open.
    expect(hasBlockingShortcutDialog(root)).toBe(true);
    expect(isInsideOpenModalDialog(popover)).toBe(false);
  });

  it("blocks shortcuts while a menu or select is open, but not for a tooltip or a closing popover", () => {
    function popup(attributes: Record<string, string>) {
      const root = document.createElement("div");
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-radix-popper-content-wrapper", "");
      const content = document.createElement("div");
      for (const [name, value] of Object.entries(attributes)) content.setAttribute(name, value);
      wrapper.appendChild(content);
      root.appendChild(wrapper);
      return root;
    }
    expect(hasBlockingShortcutDialog(popup({ role: "menu", "data-state": "open" }))).toBe(true);
    expect(hasBlockingShortcutDialog(popup({ role: "listbox", "data-state": "open" }))).toBe(true);
    expect(hasBlockingShortcutDialog(popup({ role: "tooltip", "data-state": "delayed-open" }))).toBe(false);
    expect(hasBlockingShortcutDialog(popup({ role: "dialog", "data-state": "closed" }))).toBe(false);
  });

  it("ignores popper content that is hidden or aria-hidden, on itself or on an ancestor", () => {
    function popup(contentAttributes: Record<string, string>, wrapperAttributes: Record<string, string> = {}) {
      const root = document.createElement("div");
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-radix-popper-content-wrapper", "");
      for (const [name, value] of Object.entries(wrapperAttributes)) wrapper.setAttribute(name, value);
      const content = document.createElement("div");
      for (const [name, value] of Object.entries(contentAttributes)) content.setAttribute(name, value);
      wrapper.appendChild(content);
      root.appendChild(wrapper);
      return root;
    }
    expect(hasBlockingShortcutDialog(popup({ role: "menu", hidden: "" }))).toBe(false);
    expect(hasBlockingShortcutDialog(popup({ role: "listbox", "aria-hidden": "true" }))).toBe(false);
    expect(hasBlockingShortcutDialog(popup({ role: "menu", "data-state": "open" }, { "aria-hidden": "true" }))).toBe(false);
    expect(hasBlockingShortcutDialog(popup({ role: "dialog", "data-state": "open" }, { hidden: "" }))).toBe(false);
    expect(hasBlockingShortcutDialog(popup({ role: "menu", "data-state": "open" }, { "aria-hidden": "false" }))).toBe(true);
  });

  it("finds the modal around a popover that is open inside it", () => {
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("data-state", "open");
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    const popover = document.createElement("div");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("data-state", "open");
    const input = document.createElement("input");
    popover.appendChild(input);
    wrapper.appendChild(popover);
    modal.appendChild(wrapper);
    expect(isInsideOpenModalDialog(input)).toBe(true);
    expect(isInsideOpenModalDialog(document.createElement("button"))).toBe(false);
  });
});

describe("shouldOpenCommandLauncher", () => {
  const base = {
    key: "k",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    defaultPrevented: false,
    target: document.body as EventTarget | null,
    hasOpenDialog: false,
  };

  it("opens on Cmd+K or Ctrl+K from the page", () => {
    expect(shouldOpenCommandLauncher(base)).toBe(true);
    expect(shouldOpenCommandLauncher({ ...base, metaKey: false, ctrlKey: true, key: "K" })).toBe(true);
  });

  it("ignores other keys and Alt combinations", () => {
    expect(shouldOpenCommandLauncher({ ...base, key: "j" })).toBe(false);
    expect(shouldOpenCommandLauncher({ ...base, metaKey: false })).toBe(false);
    expect(shouldOpenCommandLauncher({ ...base, altKey: true })).toBe(false);
  });

  it("leaves the key to text fields, editors, IME composition, other handlers and open modals", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    expect(shouldOpenCommandLauncher({ ...base, target: document.createElement("input") })).toBe(false);
    expect(shouldOpenCommandLauncher({ ...base, target: editor })).toBe(false);
    expect(shouldOpenCommandLauncher({ ...base, isComposing: true })).toBe(false);
    expect(shouldOpenCommandLauncher({ ...base, defaultPrevented: true })).toBe(false);
    expect(shouldOpenCommandLauncher({ ...base, hasOpenDialog: true })).toBe(false);
  });
});
