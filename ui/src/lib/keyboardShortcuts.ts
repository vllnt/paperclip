export const KEYBOARD_SHORTCUT_TEXT_INPUT_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  "[role='textbox']",
  "[role='combobox']",
].join(", ");

const PAGE_SEARCH_SHORTCUT_SELECTOR = "[data-page-search-target='true']";

// Open dialog content. Radix (shadcn `dialog`, `sheet`, `alert-dialog`, and raw
// `DialogPrimitive.Content` such as the image gallery) marks it with
// `data-state` but not `aria-modal`. A closing dialog keeps
// `data-state="closed"` until its exit animation ends, so it no longer counts.
const OPEN_DIALOG_SELECTOR = [
  "[role='dialog'][aria-modal='true']:not([data-state='closed'])",
  "[role='alertdialog'][aria-modal='true']:not([data-state='closed'])",
  "[role='dialog'][data-state='open']",
  "[role='alertdialog'][data-state='open']",
].join(", ");
// Popover content also has role=dialog, but Radix renders it inside a popper
// wrapper and it is not modal.
const POPPER_CONTENT_SELECTOR = "[data-radix-popper-content-wrapper]";

function isModalDialog(dialog: Element): boolean {
  return dialog.getAttribute("aria-modal") === "true" || !dialog.closest(POPPER_CONTENT_SELECTOR);
}

/** True when `element` sits inside an open modal dialog (a popover inside one counts). */
export function isInsideOpenModalDialog(element: Element): boolean {
  let dialog = element.closest(OPEN_DIALOG_SELECTOR);
  while (dialog) {
    if (isModalDialog(dialog)) return true;
    dialog = dialog.parentElement?.closest(OPEN_DIALOG_SELECTOR) ?? null;
  }
  return false;
}
const MODIFIER_ONLY_KEYS = new Set(["Shift", "Meta", "Control", "Alt"]);

export type InboxQuickArchiveKeyAction = "ignore" | "archive" | "disarm";
export type InboxUndoArchiveKeyAction = "ignore" | "undo_archive";
export type IssueDetailGoKeyAction =
  | "ignore"
  | "arm"
  | "navigate_inbox"
  | "focus_comment"
  | "open_file_viewer"
  | "disarm";
export type AttentionQueueKeyAction = "ignore" | "next" | "previous" | "toggle" | "dismiss";
export type GoChordKeyAction =
  | { type: "ignore" }
  | { type: "arm" }
  | { type: "disarm" }
  | { type: "run"; actionId: string };

export function isKeyboardShortcutTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return !!target.closest(KEYBOARD_SHORTCUT_TEXT_INPUT_SELECTOR);
}

// Open popover, menu or select content, which Radix renders inside a popper
// wrapper. Tooltips also use the wrapper but take no keyboard focus.
const OPEN_POPUP_SELECTOR = [
  "[data-radix-popper-content-wrapper] [role='dialog']:not([data-state='closed'])",
  "[data-radix-popper-content-wrapper] [role='menu']:not([data-state='closed'])",
  "[data-radix-popper-content-wrapper] [role='listbox']:not([data-state='closed'])",
].join(", ");

// Radix can leave popper content mounted after it hides or closes. Content
// counts as open only while it renders and neither it nor an ancestor (such
// as the popper wrapper) is hidden, aria-hidden or closed.
function isShownPopup(popup: Element): boolean {
  if (popup.closest("[hidden], [aria-hidden='true'], [data-state='closed']")) return false;
  if (typeof popup.checkVisibility === "function") return popup.checkVisibility({ checkVisibilityCSS: true });
  return popup.getClientRects().length > 0;
}

// A DOM check that throws counts as "not open": a broken check must never
// trap the keyboard.
function failOpen(check: (element: Element) => boolean): (element: Element) => boolean {
  return (element) => {
    try {
      return check(element);
    } catch {
      return false;
    }
  };
}

/**
 * True while a modal dialog or a popover, menu or select is open. Those own
 * the keyboard until they close, so page shortcuts stay quiet meanwhile.
 */
export function hasBlockingShortcutDialog(root: ParentNode = document): boolean {
  if (Array.from(root.querySelectorAll(OPEN_POPUP_SELECTOR)).some(failOpen(isShownPopup))) return true;
  return Array.from(root.querySelectorAll(OPEN_DIALOG_SELECTOR)).some(failOpen(isModalDialog));
}

function isVisibleShortcutTarget(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  if ("disabled" in element && typeof element.disabled === "boolean" && element.disabled) return false;
  if (element.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
  if (isInsideOpenModalDialog(element)) return false;

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;

  return element.getClientRects().length > 0 || element === document.activeElement;
}

export function findPageSearchShortcutTarget(root: ParentNode = document): HTMLElement | null {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(PAGE_SEARCH_SHORTCUT_SELECTOR));
  return candidates.find((candidate) => isVisibleShortcutTarget(candidate)) ?? null;
}

export function focusPageSearchShortcutTarget(root: ParentNode = document): boolean {
  const target = findPageSearchShortcutTarget(root);
  if (!target) return false;

  target.focus();
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.select();
  }
  return true;
}

export function shouldBlurPageSearchOnEnter({
  key,
  isComposing,
}: {
  key: string;
  isComposing: boolean;
}): boolean {
  return key === "Enter" && !isComposing;
}

export function shouldBlurPageSearchOnEscape({
  key,
  isComposing,
  currentValue,
}: {
  key: string;
  isComposing: boolean;
  currentValue: string;
}): boolean {
  return key === "Escape" && !isComposing && currentValue.length === 0;
}

export function isModifierOnlyKey(key: string): boolean {
  return MODIFIER_ONLY_KEYS.has(key);
}

export function resolveAttentionQueueKeyAction({
  defaultPrevented,
  key,
  metaKey,
  ctrlKey,
  altKey,
  target,
  hasOpenDialog,
  hasSelection,
}: {
  defaultPrevented: boolean;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  hasOpenDialog: boolean;
  hasSelection: boolean;
}): AttentionQueueKeyAction {
  if (defaultPrevented || metaKey || ctrlKey || altKey || isModifierOnlyKey(key)) return "ignore";
  if (hasOpenDialog || isKeyboardShortcutTextInputTarget(target)) return "ignore";

  switch (key) {
    case "j":
    case "ArrowDown":
      return "next";
    case "k":
    case "ArrowUp":
      return "previous";
    case "Enter":
      return hasSelection ? "toggle" : "ignore";
    case "x":
      return hasSelection ? "dismiss" : "ignore";
    default:
      return "ignore";
  }
}

export function resolveInboxQuickArchiveKeyAction({
  armed,
  defaultPrevented,
  key,
  metaKey,
  ctrlKey,
  altKey,
  target,
  hasOpenDialog,
}: {
  armed: boolean;
  defaultPrevented: boolean;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  hasOpenDialog: boolean;
}): InboxQuickArchiveKeyAction {
  if (!armed) return "ignore";
  if (defaultPrevented) return "ignore";
  if (metaKey || ctrlKey || altKey || isModifierOnlyKey(key)) return "ignore";
  if (hasOpenDialog || isKeyboardShortcutTextInputTarget(target)) return "ignore";
  if (key.toLowerCase() === "y") return "archive";
  return "ignore";
}

export function resolveInboxUndoArchiveKeyAction({
  hasUndoableArchive,
  defaultPrevented,
  key,
  metaKey,
  ctrlKey,
  altKey,
  target,
  hasOpenDialog,
}: {
  hasUndoableArchive: boolean;
  defaultPrevented: boolean;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  hasOpenDialog: boolean;
}): InboxUndoArchiveKeyAction {
  if (!hasUndoableArchive) return "ignore";
  if (defaultPrevented) return "ignore";
  if (metaKey || ctrlKey || altKey || isModifierOnlyKey(key)) return "ignore";
  if (hasOpenDialog || isKeyboardShortcutTextInputTarget(target)) return "ignore";
  if (key === "u") return "undo_archive";
  return "ignore";
}

export function resolveIssueDetailGoKeyAction({
  armed,
  defaultPrevented,
  key,
  metaKey,
  ctrlKey,
  altKey,
  target,
  hasOpenDialog,
}: {
  armed: boolean;
  defaultPrevented: boolean;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  hasOpenDialog: boolean;
}): IssueDetailGoKeyAction {
  if (defaultPrevented) return armed ? "disarm" : "ignore";
  if (metaKey || ctrlKey || altKey || isModifierOnlyKey(key)) return "ignore";
  if (hasOpenDialog || isKeyboardShortcutTextInputTarget(target)) {
    return armed ? "disarm" : "ignore";
  }

  const normalizedKey = key.toLowerCase();
  if (!armed) return normalizedKey === "g" ? "arm" : "ignore";
  if (normalizedKey === "i") return "navigate_inbox";
  if (normalizedKey === "c") return "focus_comment";
  if (normalizedKey === "f") return "open_file_viewer";
  if (normalizedKey === "g") return "arm";
  return "disarm";
}

/**
 * The global `g` chord: `g` arms it, and the next key runs the action that
 * `chords` maps it to (see `commandActionGoChords`). Page handlers that claim
 * a chord first (issue detail's `g c`) prevent the default, which disarms.
 */
export function resolveGoChordKeyAction({
  armed,
  chords,
  defaultPrevented,
  key,
  metaKey,
  ctrlKey,
  altKey,
  target,
  hasOpenDialog,
}: {
  armed: boolean;
  chords: ReadonlyMap<string, string>;
  defaultPrevented: boolean;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  hasOpenDialog: boolean;
}): GoChordKeyAction {
  if (defaultPrevented) return { type: armed ? "disarm" : "ignore" };
  if (metaKey || ctrlKey || altKey || isModifierOnlyKey(key)) return { type: "ignore" };
  if (hasOpenDialog || isKeyboardShortcutTextInputTarget(target)) {
    return { type: armed ? "disarm" : "ignore" };
  }

  const normalizedKey = key.toLowerCase();
  if (!armed) return { type: normalizedKey === "g" ? "arm" : "ignore" };
  const actionId = chords.get(normalizedKey);
  if (actionId) return { type: "run", actionId };
  if (normalizedKey === "g") return { type: "arm" };
  return { type: "disarm" };
}

/**
 * Cmd/Ctrl+K opens the command launcher, but only from the page itself: a
 * text field or editor keeps its own Cmd/Ctrl+K (for example "insert link"),
 * IME composition and keys another handler claimed are left alone, and the
 * launcher never opens on top of another modal dialog.
 */
export function shouldOpenCommandLauncher({
  key,
  metaKey,
  ctrlKey,
  altKey,
  isComposing,
  defaultPrevented,
  target,
  hasOpenDialog,
}: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
  hasOpenDialog: boolean;
}): boolean {
  if (key.toLowerCase() !== "k" || !(metaKey || ctrlKey) || altKey) return false;
  if (isComposing || defaultPrevented || hasOpenDialog) return false;
  return !isKeyboardShortcutTextInputTarget(target);
}

/** The launcher's key hint for a platform string: "⌘K" on Apple platforms, else "Ctrl K". */
export function commandLauncherKeyHint(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘K" : "Ctrl K";
}

/** The launcher's key hint for the current browser. */
export function currentCommandLauncherKeyHint(): string {
  if (typeof navigator === "undefined") return "Ctrl K";
  const withData = navigator as Navigator & { userAgentData?: { platform?: string } };
  return commandLauncherKeyHint(withData.userAgentData?.platform || navigator.platform || "");
}
