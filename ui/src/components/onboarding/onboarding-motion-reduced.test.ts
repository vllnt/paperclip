// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { beatDelay } from "./onboarding-motion";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("plays the beat at its full length when the OS answers that motion is allowed", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  expect(beatDelay(400)).toBe(400);
});

it("skips the beat under reduced motion", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  expect(beatDelay(400)).toBe(0);
});

it("skips the beat, as it does when matchMedia is missing, when matchMedia throws", () => {
  vi.stubGlobal("matchMedia", () => {
    throw new Error("matchMedia failed");
  });
  expect(beatDelay(400)).toBe(0);
});
