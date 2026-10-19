// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BrowserProfile, BrowserSignInState } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { BrowserSignInDialog, SIGN_IN_REFRESH_MS } from "./BrowserSignInDialog";

const mockApi = vi.hoisted(() => ({
  startSignIn: vi.fn(),
  signInState: vi.fn(),
  sendSignInInput: vi.fn(),
  endSignIn: vi.fn(),
  signInFrameUrl: vi.fn(),
}));

vi.mock("@/api/browser-profiles", () => ({ browserProfilesApi: mockApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const profile: BrowserProfile = {
  id: "profile-1",
  companyId: "company-1",
  name: "Acme login",
  status: "active",
  allowedDomains: ["app.example.com"],
  allowedAgentIds: [],
  hasSavedSession: false,
  lastSavedAt: null,
  signIn: { active: false, userId: null, expiresAt: null },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const liveState: BrowserSignInState = {
  url: "https://app.example.com/login",
  title: "Acme sign in",
  width: 1280,
  height: 800,
  expiresAt: "2026-10-09T12:15:00.000Z",
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function findButton(label: string): HTMLButtonElement {
  const match = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`No button named "${label}"`);
  return match;
}

function setInputValue(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findInput(label: string): HTMLInputElement {
  const field = [...document.body.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const input = field?.htmlFor ? document.getElementById(field.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`No input labelled "${label}"`);
  return input;
}

describe("BrowserSignInDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();
  const onSaved = vi.fn();

  function renderDialog() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BrowserSignInDialog
            companyId="company-1"
            profile={profile}
            onClose={onClose}
            onSaved={onSaved}
          />
        </QueryClientProvider>,
      );
    });
  }

  async function startSession() {
    renderDialog();
    await act(async () => {
      findButton("Start sign-in").click();
    });
    await flush();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onClose.mockReset();
    onSaved.mockReset();
    for (const fn of Object.values(mockApi)) fn.mockReset();
    mockApi.startSignIn.mockResolvedValue(liveState);
    mockApi.signInState.mockResolvedValue(liveState);
    mockApi.sendSignInInput.mockResolvedValue(liveState);
    mockApi.endSignIn.mockResolvedValue({ ...profile, hasSavedSession: true });
    mockApi.signInFrameUrl.mockImplementation(
      (_companyId: string, _profileId: string, bust: number) => `/frame.jpg?t=${bust}`,
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("starts at the first allowed host and shows the page title, address and expiry", async () => {
    await startSession();

    expect(mockApi.startSignIn).toHaveBeenCalledWith(
      "company-1",
      "profile-1",
      "https://app.example.com/",
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Acme sign in");
    expect(text).toContain("https://app.example.com/login");
    expect(text).toContain("Session expires");
    expect(document.body.querySelector("time")?.getAttribute("datetime")).toBe(liveState.expiresAt);
  });

  it("shows the server's message when the browser cannot start", async () => {
    mockApi.startSignIn.mockRejectedValue(
      new ApiError("Browser runtime is not installed.", 503, null),
    );
    await startSession();

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "Browser runtime is not installed.",
    );
    expect(document.body.querySelector("img")).toBeNull();
  });

  it("sends a click scaled from the displayed image to the page's width and height", async () => {
    await startSession();
    const frame = document.body.querySelector("img");
    if (!frame) throw new Error("The live frame did not render");
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 20,
      width: 400,
      height: 250,
      right: 410,
      bottom: 270,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    });

    await act(async () => {
      frame.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 210, clientY: 145 }),
      );
    });
    await flush();

    expect(mockApi.sendSignInInput).toHaveBeenCalledWith("company-1", "profile-1", {
      type: "click",
      x: 640,
      y: 400,
    });
  });

  it("reloads the frame after an input", async () => {
    await startSession();
    const before = document.body.querySelector("img")?.getAttribute("src");

    await act(async () => {
      findButton("Enter").click();
    });
    await flush();

    expect(mockApi.sendSignInInput).toHaveBeenCalledWith("company-1", "profile-1", {
      type: "key",
      key: "Enter",
    });
    expect(document.body.querySelector("img")?.getAttribute("src")).not.toBe(before);
  });

  it("sends typed text, scroll steps and addresses", async () => {
    await startSession();

    setInputValue(findInput("Type into the selected field"), "hello there");
    await act(async () => {
      findButton("Send").click();
    });
    await flush();
    expect(mockApi.sendSignInInput).toHaveBeenLastCalledWith("company-1", "profile-1", {
      type: "type",
      text: "hello there",
    });
    expect(findInput("Type into the selected field").value).toBe("");

    await act(async () => {
      findButton("Scroll down").click();
    });
    await flush();
    expect(mockApi.sendSignInInput).toHaveBeenLastCalledWith("company-1", "profile-1", {
      type: "scroll",
      deltaY: 480,
    });

    await act(async () => {
      findButton("Scroll up").click();
    });
    await flush();
    expect(mockApi.sendSignInInput).toHaveBeenLastCalledWith("company-1", "profile-1", {
      type: "scroll",
      deltaY: -480,
    });

    setInputValue(findInput("Go to address"), "example.com/login");
    await act(async () => {
      findButton("Go").click();
    });
    await flush();
    expect(mockApi.sendSignInInput).toHaveBeenLastCalledWith("company-1", "profile-1", {
      type: "navigate",
      url: "https://example.com/login",
    });
  });

  it("masks typed text on request", async () => {
    await startSession();
    const field = findInput("Type into the selected field");
    expect(field.type).toBe("text");

    act(() => findButton("Hide typed text").click());

    expect(findInput("Type into the selected field").type).toBe("password");
  });

  it("closes without ending the session, and saves only when asked", async () => {
    await startSession();

    act(() => findButton("Close").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockApi.endSignIn).not.toHaveBeenCalled();

    await act(async () => {
      findButton("End and save").click();
    });
    await flush();
    expect(mockApi.endSignIn).toHaveBeenCalledWith("company-1", "profile-1");
    expect(onSaved).toHaveBeenCalledWith({ ...profile, hasSavedSession: true });
  });

  it("polls about once a second and stops polling when it unmounts", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await startSession();
    const firstFrame = document.body.querySelector("img")?.getAttribute("src");

    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => {
        vi.advanceTimersByTime(SIGN_IN_REFRESH_MS);
      });
      await flush();
    }

    expect(mockApi.signInState).toHaveBeenCalledTimes(3);
    expect(document.body.querySelector("img")?.getAttribute("src")).not.toBe(firstFrame);
    expect(vi.getTimerCount()).toBe(1);

    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      vi.advanceTimersByTime(5 * SIGN_IN_REFRESH_MS);
    });
    await flush();

    expect(vi.getTimerCount()).toBe(0);
    expect(mockApi.signInState).toHaveBeenCalledTimes(3);
  });

  it("stops polling and says so when the session has ended on the server", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    mockApi.signInState.mockRejectedValue(new ApiError("Sign-in lease expired.", 410, null));
    await startSession();

    await act(async () => {
      vi.advanceTimersByTime(SIGN_IN_REFRESH_MS);
    });
    await flush();

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("has ended");
    expect(vi.getTimerCount()).toBe(0);
    expect(findButton("Enter").disabled).toBe(true);
  });
});
