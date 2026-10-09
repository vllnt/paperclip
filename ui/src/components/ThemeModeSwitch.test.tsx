// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { ThemeModeSwitch } from "./ThemeModeSwitch";

const THEME_STORAGE_KEY = "paperclip.theme";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function radio(container: HTMLElement, label: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[type="radio"][aria-label="${label}"]`);
  if (!input) throw new Error(`no ${label} radio`);
  return input;
}

describe("ThemeModeSwitch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <ThemeModeSwitch />
        </ThemeProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("offers System, Light and Dark as one radio group with System selected by default", () => {
    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-label")).toBe("Appearance");

    const labels = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).map((input) =>
      input.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["System", "Light", "Dark"]);
    expect(radio(container, "System").checked).toBe(true);
    expect(radio(container, "Light").checked).toBe(false);
    expect(radio(container, "Dark").checked).toBe(false);
  });

  it("applies and persists Dark, then Light", () => {
    act(() => radio(container, "Dark").click());
    expect(radio(container, "Dark").checked).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    act(() => radio(container, "Light").click());
    expect(radio(container, "Light").checked).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("still mounts, and lets System be chosen again, when matchMedia throws", () => {
    act(() => root.unmount());
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error("matchMedia failed");
      },
    });
    root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <ThemeModeSwitch />
        </ThemeProvider>,
      );
    });
    expect(radio(container, "System").checked).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    act(() => radio(container, "Dark").click());
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    act(() => radio(container, "System").click());
    expect(radio(container, "System").checked).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("returns to System and forgets the stored choice", () => {
    act(() => radio(container, "Dark").click());
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    act(() => radio(container, "System").click());
    expect(radio(container, "System").checked).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});
