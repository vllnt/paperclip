import { describe, expect, it } from "vitest";
import {
  defaultSignInUrl,
  normalizeNavigateUrl,
  parseDomainLines,
  scaleFrameClick,
  validateBrowserProfileForm,
} from "./browser-profile-helpers";

describe("parseDomainLines", () => {
  it("splits on lines, commas and spaces, lowercases and removes duplicates", () => {
    expect(parseDomainLines("App.Example.com\n*.example.com, app.example.com  \n\n")).toEqual([
      "app.example.com",
      "*.example.com",
    ]);
  });
});

describe("validateBrowserProfileForm", () => {
  it("returns the trimmed name and parsed domains", () => {
    expect(validateBrowserProfileForm("  Billing  ", "billing.example.com")).toEqual({
      ok: true,
      value: { name: "Billing", allowedDomains: ["billing.example.com"] },
    });
  });

  it("asks for a name when it is blank", () => {
    expect(validateBrowserProfileForm("   ", "")).toEqual({
      ok: false,
      error: "Enter a name for this profile.",
    });
  });

  it("names the host that is not valid", () => {
    const result = validateBrowserProfileForm("Billing", "billing.example.com\nnot a host");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"not" is not a valid host');
  });

  it("rejects a bare wildcard", () => {
    expect(validateBrowserProfileForm("Billing", "*").ok).toBe(false);
  });
});

describe("scaleFrameClick", () => {
  const page = { width: 1280, height: 800 };

  it("maps the centre of a 400px wide image to the centre of a 1280x800 page", () => {
    expect(
      scaleFrameClick(
        { clientX: 210, clientY: 145 },
        { left: 10, top: 20, width: 400, height: 250 },
        page,
      ),
    ).toEqual({ x: 640, y: 400 });
  });

  it("stays inside the page", () => {
    expect(
      scaleFrameClick(
        { clientX: 9999, clientY: -50 },
        { left: 0, top: 0, width: 400, height: 250 },
        page,
      ),
    ).toEqual({ x: 1279, y: 0 });
  });

  it("returns null before the image has a layout box", () => {
    expect(
      scaleFrameClick({ clientX: 1, clientY: 1 }, { left: 0, top: 0, width: 0, height: 0 }, page),
    ).toBeNull();
  });
});

describe("normalizeNavigateUrl", () => {
  it("adds https when the scheme is missing", () => {
    expect(normalizeNavigateUrl("example.com/login")).toBe("https://example.com/login");
  });

  it("keeps an explicit http(s) address", () => {
    expect(normalizeNavigateUrl(" http://localhost:3000/ ")).toBe("http://localhost:3000/");
  });

  it("rejects other schemes and blanks", () => {
    expect(normalizeNavigateUrl("javascript://example.com")).toBeNull();
    expect(normalizeNavigateUrl("file:///etc/hosts")).toBeNull();
    expect(normalizeNavigateUrl("   ")).toBeNull();
  });
});

describe("defaultSignInUrl", () => {
  it("uses the first concrete host and skips wildcards", () => {
    expect(defaultSignInUrl({ allowedDomains: ["*.example.com", "app.example.com"] })).toBe(
      "https://app.example.com/",
    );
  });

  it("is empty when only wildcards are allowed", () => {
    expect(defaultSignInUrl({ allowedDomains: ["*.example.com"] })).toBe("");
  });
});
