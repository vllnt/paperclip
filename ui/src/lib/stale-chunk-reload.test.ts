import { describe, expect, it, vi } from "vitest";
import {
  STALE_CHUNK_RELOAD_COOLDOWN_MS,
  STALE_CHUNK_RELOAD_KEY,
  canReloadForStaleChunk,
  installStaleChunkReload,
} from "./stale-chunk-reload";

function createTarget(initialStored: string | null = null) {
  let listener: ((event: Event) => void) | null = null;
  const store = new Map<string, string>();
  if (initialStored !== null) store.set(STALE_CHUNK_RELOAD_KEY, initialStored);
  const reload = vi.fn();
  const target = {
    addEventListener: (_type: "vite:preloadError", handler: (event: Event) => void) => {
      listener = handler;
    },
    removeEventListener: () => {
      listener = null;
    },
    location: { reload },
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
  };
  const fire = () => {
    const event = new Event("vite:preloadError", { cancelable: true });
    listener?.(event);
    return event;
  };
  return { target, reload, store, fire, isListening: () => listener !== null };
}

describe("canReloadForStaleChunk", () => {
  it("allows the first reload", () => {
    expect(canReloadForStaleChunk(null, 1_000)).toBe(true);
  });

  it("blocks a second reload inside the cooldown", () => {
    expect(canReloadForStaleChunk("1000", 1_000 + STALE_CHUNK_RELOAD_COOLDOWN_MS - 1)).toBe(false);
  });

  it("allows a reload after the cooldown", () => {
    expect(canReloadForStaleChunk("1000", 1_000 + STALE_CHUNK_RELOAD_COOLDOWN_MS)).toBe(true);
  });

  it("ignores a stored value that is not a number", () => {
    expect(canReloadForStaleChunk("garbage", 5)).toBe(true);
  });
});

describe("installStaleChunkReload", () => {
  it("reloads once, cancels the error, and remembers the time", () => {
    const { target, reload, store, fire } = createTarget();
    installStaleChunkReload(target, () => 50_000);

    const event = fire();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(store.get(STALE_CHUNK_RELOAD_KEY)).toBe("50000");
  });

  it("does not reload again inside the cooldown and lets the error through", () => {
    const { target, reload, fire } = createTarget("50000");
    installStaleChunkReload(target, () => 50_000 + 1_000);

    const event = fire();

    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("reloads again after the cooldown", () => {
    const { target, reload, fire } = createTarget("50000");
    installStaleChunkReload(target, () => 50_000 + STALE_CHUNK_RELOAD_COOLDOWN_MS + 1);

    fire();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("lets the error through when session storage is unavailable", () => {
    const { target, reload, fire } = createTarget();
    target.sessionStorage.getItem = () => {
      throw new Error("blocked");
    };
    installStaleChunkReload(target);

    const event = fire();

    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not reload while the browser is offline", () => {
    const { target, reload, fire } = createTarget();
    installStaleChunkReload({ ...target, navigator: { onLine: false } });

    const event = fire();

    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("reloads while the browser reports it is online", () => {
    const { target, reload, fire } = createTarget();
    installStaleChunkReload({ ...target, navigator: { onLine: true } });

    fire();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("stops listening after the returned function runs", () => {
    const { target, isListening } = createTarget();
    const remove = installStaleChunkReload(target);
    expect(isListening()).toBe(true);

    remove();

    expect(isListening()).toBe(false);
  });
});
