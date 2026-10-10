// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesMedia, subscribeToMedia } from "./safe-match-media";

type Listener = (event: MediaQueryListEvent) => void;

function installMatchMedia(value: unknown): void {
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value });
}

function installThrowingMatchMedia(): void {
  installMatchMedia(() => {
    throw new Error("matchMedia failed");
  });
}

function modernList(matches: boolean) {
  const listeners = new Set<Listener>();
  return {
    matches,
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    emit: (next: boolean) => listeners.forEach((listener) => listener({ matches: next } as MediaQueryListEvent)),
    count: () => listeners.size,
  };
}

function legacyList(matches: boolean) {
  const listeners = new Set<Listener>();
  return {
    matches,
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
    emit: (next: boolean) => listeners.forEach((listener) => listener({ matches: next } as MediaQueryListEvent)),
    count: () => listeners.size,
  };
}

afterEach(() => {
  Reflect.deleteProperty(window, "matchMedia");
});

describe("matchesMedia", () => {
  it("returns what the browser answers for the query", () => {
    const seen: string[] = [];
    installMatchMedia((query: string) => {
      seen.push(query);
      return { matches: query === "(max-width: 10px)" };
    });
    expect(matchesMedia("(max-width: 10px)", false)).toBe(true);
    expect(matchesMedia("(max-width: 20px)", true)).toBe(false);
    expect(seen).toEqual(["(max-width: 10px)", "(max-width: 20px)"]);
  });

  it.each([true, false])("returns the fallback %s when matchMedia is missing", (fallback) => {
    expect(matchesMedia("(max-width: 10px)", fallback)).toBe(fallback);
  });

  it.each([true, false])("returns the fallback %s when matchMedia throws", (fallback) => {
    installThrowingMatchMedia();
    expect(matchesMedia("(max-width: 10px)", fallback)).toBe(fallback);
  });

  it("returns the fallback when reading matches throws", () => {
    installMatchMedia(() => ({
      get matches(): boolean {
        throw new Error("matches failed");
      },
    }));
    expect(matchesMedia("(max-width: 10px)", true)).toBe(true);
  });
});

describe("subscribeToMedia", () => {
  it("reports each change through addEventListener and stops after the unsubscribe", () => {
    const list = modernList(false);
    installMatchMedia(() => list);
    const onChange = vi.fn();

    const unsubscribe = subscribeToMedia("(max-width: 10px)", onChange);
    expect(list.count()).toBe(1);
    list.emit(true);
    list.emit(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);

    unsubscribe();
    expect(list.count()).toBe(0);
  });

  it("falls back to addListener on an older MediaQueryList", () => {
    const list = legacyList(false);
    installMatchMedia(() => list);
    const onChange = vi.fn();

    const unsubscribe = subscribeToMedia("(max-width: 10px)", onChange);
    expect(list.count()).toBe(1);
    list.emit(true);
    expect(onChange).toHaveBeenCalledWith(true);

    unsubscribe();
    expect(list.count()).toBe(0);
  });

  it("does nothing, and returns a callable unsubscribe, when matchMedia is missing", () => {
    const unsubscribe = subscribeToMedia("(max-width: 10px)", vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });

  it("does nothing, and returns a callable unsubscribe, when matchMedia throws", () => {
    installThrowingMatchMedia();
    const unsubscribe = subscribeToMedia("(max-width: 10px)", vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });

  it("does nothing when subscribing throws", () => {
    installMatchMedia(() => ({
      matches: false,
      addEventListener: () => {
        throw new Error("addEventListener failed");
      },
    }));
    const unsubscribe = subscribeToMedia("(max-width: 10px)", vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });

  it("does nothing when the list has no way to subscribe", () => {
    installMatchMedia(() => ({ matches: false }));
    const unsubscribe = subscribeToMedia("(max-width: 10px)", vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });

  it("does not throw when unsubscribing throws", () => {
    installMatchMedia(() => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => {
        throw new Error("removeEventListener failed");
      },
    }));
    const unsubscribe = subscribeToMedia("(max-width: 10px)", vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });
});
