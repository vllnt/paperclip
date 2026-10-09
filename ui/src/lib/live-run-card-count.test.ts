// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { readLiveRunCardCount, writeLiveRunCardCount } from "./live-run-card-count";

const realStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

function installStorage(overrides: Partial<Pick<Storage, "getItem" | "setItem">> = {}) {
  const items = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => items.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      items.set(key, value);
    }),
    ...overrides,
  };
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
  return { items, storage };
}

describe("live-run card count", () => {
  afterEach(() => {
    if (realStorage) Object.defineProperty(window, "localStorage", realStorage);
    window.localStorage.clear();
  });

  it("is unknown until a load has been recorded", () => {
    expect(readLiveRunCardCount("company-1", "dashboard")).toBeNull();
  });

  it("returns what was written, per company and scope", () => {
    writeLiveRunCardCount("company-1", "dashboard", 3);
    writeLiveRunCardCount("company-1", "dashboard-live", 12);
    writeLiveRunCardCount("company-2", "dashboard", 0);

    expect(readLiveRunCardCount("company-1", "dashboard")).toBe(3);
    expect(readLiveRunCardCount("company-1", "dashboard-live")).toBe(12);
    expect(readLiveRunCardCount("company-2", "dashboard")).toBe(0);
    expect(readLiveRunCardCount("company-2", "dashboard-live")).toBeNull();
  });

  it.each(["abc", "-1", "1.5", "", "1234", " 2"])("ignores a stored value that is not a card count: %j", (raw) => {
    const { items } = installStorage();
    items.set("paperclip:live-run-cards:company-1:dashboard", raw);
    expect(readLiveRunCardCount("company-1", "dashboard")).toBeNull();
  });

  it("does not rewrite an unchanged count", () => {
    const { storage } = installStorage();
    writeLiveRunCardCount("company-1", "dashboard", 4);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    writeLiveRunCardCount("company-1", "dashboard", 4);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    writeLiveRunCardCount("company-1", "dashboard", 1);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(storage.setItem).toHaveBeenLastCalledWith("paperclip:live-run-cards:company-1:dashboard", "1");
  });

  it("treats blocked storage as unknown and never throws", () => {
    const { storage } = installStorage({
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    });
    expect(readLiveRunCardCount("company-1", "dashboard")).toBeNull();
    expect(() => writeLiveRunCardCount("company-1", "dashboard", 2)).not.toThrow();
    expect(storage.getItem).toHaveBeenCalled();
  });

  it("does not throw when the store is full", () => {
    const { storage } = installStorage({
      setItem: vi.fn(() => {
        throw new Error("quota");
      }),
    });
    expect(() => writeLiveRunCardCount("company-1", "dashboard", 2)).not.toThrow();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });
});
