import { useEffect, useLayoutEffect, useRef } from "react";
import { commandActionGoChords } from "@paperclipai/shared/command-actions";
import {
  focusPageSearchShortcutTarget,
  hasBlockingShortcutDialog,
  isKeyboardShortcutTextInputTarget,
  resolveGoChordKeyAction,
} from "../lib/keyboardShortcuts";

const GO_CHORDS = commandActionGoChords();

interface ShortcutHandlers {
  onNewIssue?: () => void;
  onSearch?: () => void;
  onToggleSidebar?: () => void;
  onTogglePanel?: () => void;
  onShowShortcuts?: () => void;
  /** Runs the launcher action of a `g` chord, e.g. `nav.dashboard` for `g d`. */
  onRunChord?: (actionId: string) => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  // The layout passes inline handlers, so their identities change on every
  // render. Read them through a ref and subscribe once: re-subscribing would
  // run the cleanup and drop a half-typed chord (g, re-render, d).
  const handlersRef = useRef(handlers);
  useLayoutEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    // g chord state. IssueDetail runs its own capture-phase handler for its
    // chords (g i, g c, g f) and stops propagation when it handles one, so a
    // chord it claims never reaches this bubble-phase handler.
    let goChordArmed = false;
    let goChordTimeout: number | null = null;
    const clearGoChordTimeout = () => {
      if (goChordTimeout !== null) {
        window.clearTimeout(goChordTimeout);
        goChordTimeout = null;
      }
    };
    const disarmGoChord = () => {
      goChordArmed = false;
      clearGoChordTimeout();
    };
    const armGoChord = () => {
      goChordArmed = true;
      clearGoChordTimeout();
      goChordTimeout = window.setTimeout(() => {
        goChordArmed = false;
        goChordTimeout = null;
      }, 1200);
    };

    function handleKeyDown(e: KeyboardEvent) {
      const { onNewIssue, onSearch, onToggleSidebar, onTogglePanel, onShowShortcuts, onRunChord } = handlersRef.current;
      if (e.defaultPrevented) {
        disarmGoChord();
        return;
      }

      if (onRunChord) {
        const chordAction = resolveGoChordKeyAction({
          armed: goChordArmed,
          chords: GO_CHORDS,
          defaultPrevented: e.defaultPrevented,
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          target: e.target,
          hasOpenDialog: hasBlockingShortcutDialog(),
        });
        if (chordAction.type === "arm") {
          armGoChord();
          return;
        }
        if (chordAction.type === "run") {
          // Swallow the key even when the action has no handler here (g c
          // outside issue detail), so it can't trigger a bare shortcut (c).
          disarmGoChord();
          e.preventDefault();
          onRunChord(chordAction.actionId);
          return;
        }
        if (chordAction.type === "disarm") disarmGoChord();
      }

      // Don't fire shortcuts when typing in inputs
      if (isKeyboardShortcutTextInputTarget(e.target)) {
        return;
      }

      // Don't fire shortcuts over a modal dialog. The dialog owns the
      // keyboard until it closes (Escape or its own controls).
      if (hasBlockingShortcutDialog()) {
        return;
      }

      // / → Page search when available, otherwise quick search
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (!focusPageSearchShortcutTarget()) {
          onSearch?.();
        }
        return;
      }

      // ? → Show keyboard shortcuts cheatsheet
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onShowShortcuts?.();
        return;
      }

      // C → New Issue
      if (e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onNewIssue?.();
      }

      // [ → Toggle Sidebar
      if (e.key === "[" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onToggleSidebar?.();
      }

      // ] → Toggle Panel
      if (e.key === "]" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onTogglePanel?.();
      }
    }

    const handlePointerDown = () => disarmGoChord();
    const handleFocusIn = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement && e.target !== document.body) disarmGoChord();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      disarmGoChord();
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
}
