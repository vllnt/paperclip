import { isInsideOpenModalDialog } from "./keyboardShortcuts";

export function shouldFocusMainContentAfterNavigation(
  mainElement: HTMLElement | null,
  activeElement: Element | null,
): boolean {
  if (!(mainElement instanceof HTMLElement)) return false;
  if (!(activeElement instanceof HTMLElement)) return true;
  if (!document.contains(activeElement)) return true;
  if (activeElement === document.body || activeElement === document.documentElement) return true;
  // An open modal (e.g. the command launcher reopened right after it
  // navigated) owns focus. Taking it would make the dialog's focus trap pull
  // focus back and select the input, so the next keystroke replaces the query.
  if (isInsideOpenModalDialog(activeElement)) return false;
  return !mainElement.contains(activeElement);
}

export function scheduleMainContentFocus(mainElement: HTMLElement | null): () => void {
  if (!(mainElement instanceof HTMLElement)) return () => {};

  const frame = window.requestAnimationFrame(() => {
    if (!shouldFocusMainContentAfterNavigation(mainElement, document.activeElement)) return;
    mainElement.focus({ preventScroll: true });
  });

  return () => window.cancelAnimationFrame(frame);
}
