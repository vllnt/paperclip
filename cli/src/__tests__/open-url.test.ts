import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// Lets each test decide what the next spawned child does, while the
// node:child_process mock below is hoisted above the board-auth import.
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: mocks.spawn };
});

import { openUrl } from "../client/board-auth.js";

function fakeChild(): EventEmitter & { unref: () => void } {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = () => {};
  return child;
}

describe("openUrl", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves true when the browser opener launches", async () => {
    mocks.spawn.mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    await expect(openUrl("https://example.com")).resolves.toBe(true);
  });

  it("resolves false instead of crashing when the opener is missing", async () => {
    // Headless container case: e.g. no `xdg-open`. spawn reports this via an
    // async 'error' event, not a thrown exception — openUrl must swallow it and
    // resolve false rather than letting an unhandled 'error' abort the process.
    mocks.spawn.mockImplementation(() => {
      const child = fakeChild();
      const error = Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" });
      queueMicrotask(() => child.emit("error", error));
      return child;
    });

    await expect(openUrl("https://example.com")).resolves.toBe(false);
  });

  it("refuses a URL that is not http or https without spawning anything", async () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "-a Calculator", "not a url", ""]) {
      await expect(openUrl(url)).resolves.toBe(false);
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("opens on Windows without a shell, passing the URL as one literal argument", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      mocks.spawn.mockImplementation(() => {
        const child = fakeChild();
        queueMicrotask(() => child.emit("spawn"));
        return child;
      });

      await expect(openUrl("https://example.com/approve?a=1&calc.exe|x")).resolves.toBe(true);

      const [command, args] = mocks.spawn.mock.calls[0] as [string, string[]];
      expect(command).not.toMatch(/^cmd(\.exe)?$/i);
      expect(args).toEqual(["url.dll,FileProtocolHandler", "https://example.com/approve?a=1&calc.exe|x"]);
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
  });

  it("resolves false when spawn throws synchronously", async () => {
    mocks.spawn.mockImplementation(() => {
      throw new Error("synchronous spawn failure");
    });

    await expect(openUrl("https://example.com")).resolves.toBe(false);
  });
});
