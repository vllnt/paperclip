import { describe, expect, it } from "vitest";
import {
  BrowserSealError,
  generateProfileKey,
  openProfileState,
  profileStateAad,
  sealProfileState,
} from "../services/browser-profile-seal.js";
import {
  auditUrl,
  hostMatchesPattern,
  isAgentNavigationAllowed,
  isSignInNavigationAllowed,
  redactSnapshot,
} from "../services/browser-profile-policy.js";

describe("browser profile sealing", () => {
  const session = JSON.stringify({ cookies: [{ name: "sid", value: "COOKIE-VALUE-123" }] });
  const aad = profileStateAad("company-a", "profile-1", 1);

  it("round-trips and never stores the plaintext", () => {
    const key = generateProfileKey();
    const sealed = sealProfileState(key, aad, session);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("COOKIE-VALUE-123");
    expect(Buffer.from(sealed.slice(3), "base64url").toString("utf8")).not.toContain("COOKIE-VALUE-123");
    expect(openProfileState(key, aad, sealed)).toBe(session);
  });

  it("uses a fresh nonce for every seal", () => {
    const key = generateProfileKey();
    expect(sealProfileState(key, aad, session)).not.toBe(sealProfileState(key, aad, session));
  });

  it("refuses a blob moved to another company, profile or generation", () => {
    const key = generateProfileKey();
    const sealed = sealProfileState(key, aad, session);
    for (const other of [
      profileStateAad("company-b", "profile-1", 1),
      profileStateAad("company-a", "profile-2", 1),
      profileStateAad("company-a", "profile-1", 2),
    ]) {
      expect(() => openProfileState(key, other, sealed)).toThrow(BrowserSealError);
    }
  });

  it("refuses the wrong key and tampered or malformed values without leaking material", () => {
    const key = generateProfileKey();
    const sealed = sealProfileState(key, aad, session);
    const bytes = Buffer.from(sealed.slice(3), "base64url");
    bytes[20] = bytes[20]! ^ 0xff;
    for (const bad of [`v1.${bytes.toString("base64url")}`, "v1.", "v2.abc", "garbage", ""]) {
      expect(() => openProfileState(key, aad, bad)).toThrow(BrowserSealError);
    }
    expect(() => openProfileState(generateProfileKey(), aad, sealed)).toThrow(BrowserSealError);
    try {
      openProfileState(generateProfileKey(), aad, sealed);
    } catch (error) {
      expect(String(error)).not.toContain(key);
      expect(String(error)).not.toContain("company-a");
    }
  });
});

describe("agent navigation policy", () => {
  const domains = ["app.example.com", "*.posthog.com"];

  it("matches exact hosts and subdomain wildcards only", () => {
    expect(hostMatchesPattern("app.example.com", "app.example.com")).toBe(true);
    expect(hostMatchesPattern("evil.app.example.com", "app.example.com")).toBe(false);
    expect(hostMatchesPattern("eu.posthog.com", "*.posthog.com")).toBe(true);
    expect(hostMatchesPattern("posthog.com", "*.posthog.com")).toBe(false);
    expect(hostMatchesPattern("evilposthog.com", "*.posthog.com")).toBe(false);
  });

  it("allows https navigation inside the allowlist", () => {
    expect(isAgentNavigationAllowed("https://app.example.com/dash?x=1", domains)).toBe(true);
    expect(isAgentNavigationAllowed("https://eu.posthog.com/", domains)).toBe(true);
    expect(isAgentNavigationAllowed("https://APP.EXAMPLE.COM./", domains)).toBe(true);
  });

  it("refuses everything else", () => {
    for (const url of [
      "http://app.example.com/",
      "https://other.example.com/",
      "https://app.example.com.evil.test/",
      "https://app.example.com@evil.test/",
      "https://user:pw@app.example.com/",
      "https://app.example.com:8443/",
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "chrome://settings/cookies",
      "view-source:https://app.example.com/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://localhost/",
      "not a url",
    ]) {
      expect(isAgentNavigationAllowed(url, domains), url).toBe(false);
    }
  });

  it("allows nothing when the list is empty", () => {
    expect(isAgentNavigationAllowed("https://app.example.com/", [])).toBe(false);
  });

  it("sign-in navigation needs https and no credentials but not an allowlist", () => {
    expect(isSignInNavigationAllowed("https://accounts.identity.test/login")).toBe(true);
    expect(isSignInNavigationAllowed("http://accounts.identity.test/")).toBe(false);
    expect(isSignInNavigationAllowed("https://u:p@accounts.identity.test/")).toBe(false);
  });
});

describe("audit and snapshot redaction", () => {
  it("drops query strings and fragments from audit URLs", () => {
    expect(auditUrl("https://app.example.com/cb?code=SECRET&state=x#token=Y")).toBe("app.example.com/cb");
    expect(auditUrl("nonsense")).toBe("invalid");
  });

  it("strips query strings from link targets in snapshots and bounds length", () => {
    const out = redactSnapshot('- link "Go":\n  - /url: https://app.example.com/cb?code=SECRET#frag\n  - /url: /relative?x=1');
    expect(out).toContain("/url: https://app.example.com/cb");
    expect(out).not.toContain("SECRET");
    expect(redactSnapshot("a".repeat(30_000)).length).toBeLessThan(20_100);
  });
});
