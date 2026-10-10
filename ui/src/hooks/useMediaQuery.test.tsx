// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useMediaQuery } from "./useMediaQuery";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Listener = (event: MediaQueryListEvent) => void;

interface FakeList {
  matches: boolean;
  addEventListener: (type: "change", listener: Listener) => void;
  removeEventListener: (type: "change", listener: Listener) => void;
}

function installMatchMedia(matchesByQuery: Record<string, boolean>) {
  const listeners = new Map<string, Set<Listener>>();
  const lists = new Map<string, FakeList>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): FakeList => {
      const existing = lists.get(query);
      if (existing) return existing;
      const set = new Set<Listener>();
      listeners.set(query, set);
      const list: FakeList = {
        matches: matchesByQuery[query] ?? false,
        addEventListener: (_type, listener) => set.add(listener),
        removeEventListener: (_type, listener) => set.delete(listener),
      };
      lists.set(query, list);
      return list;
    },
  });
  return {
    emit(query: string, matches: boolean): void {
      const list = lists.get(query);
      if (list) list.matches = matches;
      listeners.get(query)?.forEach((listener) => listener({ matches } as MediaQueryListEvent));
    },
    listenerCount: (query: string): number => listeners.get(query)?.size ?? 0,
  };
}

function installThrowingMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => {
      throw new Error("matchMedia failed");
    },
  });
}

describe("useMediaQuery and usePrefersReducedMotion", () => {
  let container: HTMLDivElement;
  let root: Root;
  let observed: { query: boolean; reduced: boolean };
  let query: string;
  let fallback: boolean;
  let crashes: string[];
  // React reports a crash in an effect as a window error event, not as a throw from the render call.
  const recordCrash = (event: ErrorEvent): void => {
    crashes.push(event.message);
    event.preventDefault();
  };

  function Probe() {
    observed = { query: useMediaQuery(query, fallback), reduced: usePrefersReducedMotion() };
    return null;
  }

  function mount(): void {
    act(() => root.render(<Probe />));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    query = "(max-width: 639px)";
    fallback = false;
    crashes = [];
    window.addEventListener("error", recordCrash);
  });

  afterEach(() => {
    window.removeEventListener("error", recordCrash);
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("starts from the browser's answer and follows changes", () => {
    const media = installMatchMedia({ [query]: true });
    mount();
    expect(observed.query).toBe(true);
    expect(media.listenerCount(query)).toBe(1);

    act(() => media.emit(query, false));
    expect(observed.query).toBe(false);
    act(() => media.emit(query, true));
    expect(observed.query).toBe(true);
  });

  it("subscribes to the new query when the query changes, and drops the old one", () => {
    const wide = "(min-width: 1024px)";
    const media = installMatchMedia({ [query]: true, [wide]: false });
    mount();
    expect(observed.query).toBe(true);

    query = wide;
    mount();
    expect(observed.query).toBe(false);
    expect(media.listenerCount("(max-width: 639px)")).toBe(0);
    expect(media.listenerCount(wide)).toBe(1);
  });

  it("stops listening on unmount", () => {
    const media = installMatchMedia({ [query]: true });
    mount();
    act(() => root.unmount());
    expect(media.listenerCount(query)).toBe(0);
    root = createRoot(container);
  });

  it.each([true, false])("renders with the fallback %s when matchMedia is missing", (value) => {
    fallback = value;
    mount();
    expect(observed.query).toBe(value);
    expect(observed.reduced).toBe(false);
  });

  it.each([true, false])("renders with the fallback %s when matchMedia throws", (value) => {
    installThrowingMatchMedia();
    fallback = value;
    mount();
    expect(crashes).toEqual([]);
    expect(observed.query).toBe(value);
    expect(observed.reduced).toBe(false);
  });

  it("reports reduced motion from the OS and follows it", () => {
    const reduced = "(prefers-reduced-motion: reduce)";
    const media = installMatchMedia({ [reduced]: true });
    mount();
    expect(observed.reduced).toBe(true);
    act(() => media.emit(reduced, false));
    expect(observed.reduced).toBe(false);
  });
});
