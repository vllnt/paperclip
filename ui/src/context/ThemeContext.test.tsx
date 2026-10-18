// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme, type ThemePreference } from "./ThemeContext";

const THEME_STORAGE_KEY = "paperclip.theme";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MediaListener = (event: MediaQueryListEvent) => void;

interface FakeMediaQueryList {
  matches: boolean;
  addEventListener: (type: "change", listener: MediaListener) => void;
  removeEventListener: (type: "change", listener: MediaListener) => void;
  dispatch: (matches: boolean) => void;
  listenerCount: () => number;
}

function installMatchMedia(initialMatches: boolean): FakeMediaQueryList {
  const listeners = new Set<MediaListener>();
  const mql: FakeMediaQueryList = {
    matches: initialMatches,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    dispatch: (matches) => {
      mql.matches = matches;
      const event = { matches } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
    listenerCount: () => listeners.size,
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      if (query !== "(prefers-color-scheme: dark)") {
        throw new Error(`unexpected media query: ${query}`);
      }
      return mql as unknown as MediaQueryList;
    },
  });
  return mql;
}

/** A webview where `matchMedia` exists but throws, as the boot script in index.html already tolerates. */
function installThrowingMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => {
      throw new Error("matchMedia failed");
    },
  });
}

interface LegacyMediaQueryList {
  matches: boolean;
  addListener: (listener: MediaListener) => void;
  removeListener: (listener: MediaListener) => void;
  dispatch: (matches: boolean) => void;
  listenerCount: () => number;
}

/** An older `MediaQueryList` that only has `addListener` and `removeListener`. */
function installLegacyMatchMedia(initialMatches: boolean): LegacyMediaQueryList {
  const listeners = new Set<MediaListener>();
  const mql: LegacyMediaQueryList = {
    matches: initialMatches,
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    dispatch: (matches) => {
      mql.matches = matches;
      listeners.forEach((listener) => listener({ matches } as MediaQueryListEvent));
    },
    listenerCount: () => listeners.size,
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => mql as unknown as MediaQueryList,
  });
  return mql;
}

/** A `MediaQueryList` whose subscribe and unsubscribe both throw. */
function installUnsubscribableMatchMedia(initialMatches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () =>
      ({
        matches: initialMatches,
        addEventListener: () => {
          throw new Error("addEventListener failed");
        },
        removeEventListener: () => {
          throw new Error("removeEventListener failed");
        },
      }) as unknown as MediaQueryList,
  });
}

describe("ThemeContext", () => {
  let container: HTMLDivElement;
  let observedTheme: "light" | "dark" | null = null;
  let observedPreference: ThemePreference | null = null;
  let setTheme: ((theme: "light" | "dark") => void) | null = null;
  let setPreference: ((preference: ThemePreference) => void) | null = null;
  let toggleTheme: (() => void) | null = null;

  function Probe() {
    const ctx = useTheme();
    observedTheme = ctx.theme;
    observedPreference = ctx.preference;
    setTheme = ctx.setTheme;
    setPreference = ctx.setPreference;
    toggleTheme = ctx.toggleTheme;
    return null;
  }

  function renderProbe(): ReturnType<typeof createRoot> {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });
    return root;
  }

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
    document.head.innerHTML = '<meta name="theme-color" content="">';
    observedTheme = null;
    observedPreference = null;
    setTheme = null;
    setPreference = null;
    toggleTheme = null;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("follows OS prefers-color-scheme changes while no explicit choice has been made", () => {
    document.documentElement.classList.add("dark");
    const mql = installMatchMedia(true);

    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });

    expect(observedTheme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mql.listenerCount()).toBe(1);

    act(() => {
      mql.dispatch(false);
    });
    expect(observedTheme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("stops listening to OS changes after the user makes an explicit choice", () => {
    document.documentElement.classList.add("dark");
    const mql = installMatchMedia(true);

    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });

    expect(mql.listenerCount()).toBe(1);

    act(() => {
      setTheme?.("light");
    });
    expect(observedTheme).toBe("light");
    expect(mql.listenerCount()).toBe(0);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).toBe("light");

    act(() => {
      toggleTheme?.();
    });
    expect(observedTheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    act(() => {
      root.unmount();
    });
  });

  it("does not attach the OS listener when a stored choice already exists", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const mql = installMatchMedia(true);

    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });

    expect(mql.listenerCount()).toBe(0);

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).not.toBe("dark");

    act(() => {
      root.unmount();
    });
  });

  it("defaults the preference to system and resolves the theme from the OS", () => {
    installMatchMedia(false);
    const root = renderProbe();

    expect(observedPreference).toBe("system");
    expect(observedTheme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("restores a stored explicit choice as the preference", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    installMatchMedia(false);
    const root = renderProbe();

    expect(observedPreference).toBe("dark");
    expect(observedTheme).toBe("dark");

    act(() => {
      root.unmount();
    });
  });

  it("returns to system: clears the stored choice and follows the OS again", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const mql = installMatchMedia(true);
    const root = renderProbe();
    expect(observedTheme).toBe("light");
    expect(mql.listenerCount()).toBe(0);

    act(() => {
      setPreference?.("system");
    });
    expect(observedPreference).toBe("system");
    expect(observedTheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(mql.listenerCount()).toBe(1);

    act(() => {
      mql.dispatch(false);
    });
    expect(observedTheme).toBe("light");

    act(() => {
      root.unmount();
    });
  });

  it("applies an explicit preference even when the OS disagrees", () => {
    installMatchMedia(true);
    const root = renderProbe();
    expect(observedTheme).toBe("dark");

    act(() => {
      setPreference?.("light");
    });
    expect(observedTheme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    act(() => {
      root.unmount();
    });
  });

  it("follows a preference change made in another tab", () => {
    installMatchMedia(false);
    const root = renderProbe();
    expect(observedPreference).toBe("system");

    act(() => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "dark" }));
    });
    expect(observedPreference).toBe("dark");
    expect(observedTheme).toBe("dark");

    act(() => {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: null }));
    });
    expect(observedPreference).toBe("system");
    expect(observedTheme).toBe("light");

    act(() => {
      root.unmount();
    });
  });

  describe("when the OS preference cannot be read", () => {
    let windowErrors: string[];
    const recordWindowError = (event: ErrorEvent): void => {
      windowErrors.push(event.message);
      event.preventDefault();
    };

    beforeEach(() => {
      windowErrors = [];
      window.addEventListener("error", recordWindowError);
    });

    afterEach(() => {
      window.removeEventListener("error", recordWindowError);
      Reflect.deleteProperty(window, "matchMedia");
    });

    it("mounts and falls back to light, the same as the boot script, when matchMedia throws", () => {
      installThrowingMatchMedia();
      const root = renderProbe();

      expect(observedPreference).toBe("system");
      expect(observedTheme).toBe("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      expect(document.documentElement.style.colorScheme).toBe("light");

      act(() => {
        root.unmount();
      });
    });

    it("lets System be selected again without throwing, and resolves it to the fallback", () => {
      installThrowingMatchMedia();
      const root = renderProbe();

      act(() => {
        setPreference?.("dark");
      });
      expect(observedTheme).toBe("dark");
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

      act(() => {
        setPreference?.("system");
      });
      expect(observedPreference).toBe("system");
      expect(observedTheme).toBe("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

      act(() => {
        root.unmount();
      });
    });

    it("keeps selecting System working when matchMedia starts throwing after mount", () => {
      installMatchMedia(true);
      const root = renderProbe();
      act(() => {
        setPreference?.("light");
      });
      expect(observedTheme).toBe("light");

      installThrowingMatchMedia();
      act(() => {
        setPreference?.("system");
      });
      expect(windowErrors).toEqual([]);
      expect(observedPreference).toBe("system");
      expect(observedTheme).toBe("light");

      act(() => {
        root.unmount();
      });
    });

    it("keeps following another tab's choice when matchMedia starts throwing after mount", () => {
      installMatchMedia(true);
      window.localStorage.setItem(THEME_STORAGE_KEY, "light");
      const root = renderProbe();
      expect(observedPreference).toBe("light");

      installThrowingMatchMedia();
      act(() => {
        window.localStorage.removeItem(THEME_STORAGE_KEY);
        window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: null }));
      });
      expect(windowErrors).toEqual([]);
      expect(observedPreference).toBe("system");
      expect(observedTheme).toBe("light");

      act(() => {
        root.unmount();
      });
    });

    it("follows OS changes through addListener on a MediaQueryList without addEventListener", () => {
      const mql = installLegacyMatchMedia(true);
      const root = renderProbe();

      expect(observedTheme).toBe("dark");
      expect(mql.listenerCount()).toBe(1);

      act(() => {
        mql.dispatch(false);
      });
      expect(observedTheme).toBe("light");

      act(() => {
        setPreference?.("dark");
      });
      expect(mql.listenerCount()).toBe(0);

      act(() => {
        root.unmount();
      });
    });

    it("mounts, reads the OS value and unmounts when subscribing and unsubscribing both throw", () => {
      installUnsubscribableMatchMedia(true);
      const root = renderProbe();
      expect(observedTheme).toBe("dark");

      act(() => {
        root.unmount();
      });
      expect(windowErrors).toEqual([]);
    });
  });

  it("paints the browser chrome pure black in dark and pure white in light", () => {
    installMatchMedia(false);
    const root = renderProbe();
    const meta = document.querySelector('meta[name="theme-color"]');
    expect(meta?.getAttribute("content")).toBe("#ffffff");

    act(() => {
      setPreference?.("dark");
    });
    expect(meta?.getAttribute("content")).toBe("#000000");

    act(() => {
      root.unmount();
    });
  });
});
