import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeWebhookTimestampMs,
  verifyBearerAuthorization,
  verifyGithubHmacSignature,
  verifyHmacSha256Signature,
} from "../services/webhook-auth.js";

const SECRET = "whsec_test_secret";
const BODY = Buffer.from('{"schema":"paperclip.event.v1","title":"Disk almost full"}');
const TIMESTAMP_SECONDS = "1767225600"; // 2026-01-01T00:00:00Z
const NOW_MS = 1_767_225_600_000;

function sign(timestamp: string, body: Buffer = BODY, secret: string = SECRET): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
}

function verify(overrides: Partial<Parameters<typeof verifyHmacSha256Signature>[0]> = {}) {
  return verifyHmacSha256Signature({
    secret: SECRET,
    rawBody: BODY,
    signatureHeader: sign(TIMESTAMP_SECONDS),
    timestampHeader: TIMESTAMP_SECONDS,
    replayWindowSec: 300,
    now: NOW_MS,
    ...overrides,
  });
}

describe("normalizeWebhookTimestampMs", () => {
  it("treats small numbers as seconds and large numbers as milliseconds", () => {
    expect(normalizeWebhookTimestampMs("1767225600")).toBe(1_767_225_600_000);
    expect(normalizeWebhookTimestampMs("1767225600000")).toBe(1_767_225_600_000);
    expect(normalizeWebhookTimestampMs("1767225600.5")).toBe(1_767_225_600_500);
  });

  it("returns null for values that are not finite numbers", () => {
    expect(normalizeWebhookTimestampMs("abc")).toBeNull();
    expect(normalizeWebhookTimestampMs("NaN")).toBeNull();
    expect(normalizeWebhookTimestampMs("Infinity")).toBeNull();
    expect(normalizeWebhookTimestampMs("12abc")).toBeNull();
  });
});

describe("verifyBearerAuthorization", () => {
  const secret = "s3cret-token";

  it("accepts the exact bearer header", () => {
    expect(verifyBearerAuthorization({ secret, authorizationHeader: `Bearer ${secret}` })).toBe(true);
  });

  it("trims whitespace around the header value", () => {
    expect(verifyBearerAuthorization({ secret, authorizationHeader: `  Bearer ${secret} \n` })).toBe(true);
  });

  it("rejects a wrong token of the same length", () => {
    expect(verifyBearerAuthorization({ secret, authorizationHeader: "Bearer s3cret-tokeX" })).toBe(false);
  });

  it("rejects a token that is longer or shorter than the secret", () => {
    expect(verifyBearerAuthorization({ secret, authorizationHeader: `Bearer ${secret}extra` })).toBe(false);
    expect(verifyBearerAuthorization({ secret, authorizationHeader: `Bearer ${secret.slice(0, -1)}` })).toBe(false);
    expect(verifyBearerAuthorization({ secret, authorizationHeader: "Bearer " })).toBe(false);
  });

  it.each([null, undefined, "", "   "])("rejects a missing header %j", (authorizationHeader) => {
    expect(verifyBearerAuthorization({ secret, authorizationHeader })).toBe(false);
  });

  it("rejects the bare secret, another scheme and a different scheme casing", () => {
    expect(verifyBearerAuthorization({ secret, authorizationHeader: secret })).toBe(false);
    expect(verifyBearerAuthorization({ secret, authorizationHeader: `Basic ${secret}` })).toBe(false);
    expect(verifyBearerAuthorization({ secret, authorizationHeader: `bearer ${secret}` })).toBe(false);
  });

  it("never authenticates against an empty secret", () => {
    expect(verifyBearerAuthorization({ secret: "", authorizationHeader: "Bearer " })).toBe(false);
    expect(verifyBearerAuthorization({ secret: "", authorizationHeader: "Bearer" })).toBe(false);
  });

  it("compares secrets that contain non-ASCII characters", () => {
    expect(verifyBearerAuthorization({ secret: "sécret", authorizationHeader: "Bearer sécret" })).toBe(true);
    expect(verifyBearerAuthorization({ secret: "sécret", authorizationHeader: "Bearer sécreX" })).toBe(false);
    // Same number of characters, more bytes: must be rejected without throwing.
    expect(verifyBearerAuthorization({ secret: "sécret", authorizationHeader: "Bearer s€cret" })).toBe(false);
  });
});

describe("verifyHmacSha256Signature", () => {
  describe("valid signatures", () => {
    it("accepts a correct signature and returns the signed timestamp and expected hmac", () => {
      const result = verify();
      expect(result).toEqual({ valid: true, timestamp: TIMESTAMP_SECONDS, expectedHmac: sign(TIMESTAMP_SECONDS) });
    });

    it("accepts a sha256= prefixed signature", () => {
      const result = verify({ signatureHeader: `sha256=${sign(TIMESTAMP_SECONDS)}` });
      expect(result.valid).toBe(true);
    });

    it("returns an identical expectedHmac with and without the sha256= prefix, so the replay key is the same", () => {
      const bare = verify({ signatureHeader: sign(TIMESTAMP_SECONDS) });
      const prefixed = verify({ signatureHeader: `sha256=${sign(TIMESTAMP_SECONDS)}` });
      if (!bare.valid || !prefixed.valid) throw new Error("expected both signatures to verify");

      expect(prefixed.expectedHmac).toBe(bare.expectedHmac);
      expect(prefixed.timestamp).toBe(bare.timestamp);
      expect(`${prefixed.timestamp}:${prefixed.expectedHmac}`).toBe(`${bare.timestamp}:${bare.expectedHmac}`);
      expect(prefixed.expectedHmac).not.toContain("sha256=");
    });

    it("trims whitespace around both headers and reports the trimmed timestamp", () => {
      const result = verify({
        signatureHeader: `  ${sign(TIMESTAMP_SECONDS)}\n`,
        timestampHeader: `\t${TIMESTAMP_SECONDS} `,
      });
      expect(result).toMatchObject({ valid: true, timestamp: TIMESTAMP_SECONDS });
    });

    it("signs an empty body", () => {
      const empty = Buffer.alloc(0);
      expect(verify({ rawBody: empty, signatureHeader: sign(TIMESTAMP_SECONDS, empty) }).valid).toBe(true);
    });

    it("signs the raw bytes, not a re-serialized body", () => {
      const spaced = Buffer.from('{ "a" : 1 }');
      expect(verify({ rawBody: spaced, signatureHeader: sign(TIMESTAMP_SECONDS, spaced) }).valid).toBe(true);
      expect(verify({ rawBody: spaced, signatureHeader: sign(TIMESTAMP_SECONDS, Buffer.from('{"a":1}')) }).valid).toBe(false);
    });
  });

  describe("invalid signatures", () => {
    it("rejects a wrong signature of the right length", () => {
      const wrong = "0".repeat(64);
      expect(verify({ signatureHeader: wrong })).toEqual({ valid: false });
      expect(verify({ signatureHeader: `sha256=${wrong}` })).toEqual({ valid: false });
    });

    it("rejects a signature that differs by a single character", () => {
      const good = sign(TIMESTAMP_SECONDS);
      const flipped = `${good.slice(0, -1)}${good.endsWith("0") ? "1" : "0"}`;
      expect(verify({ signatureHeader: flipped }).valid).toBe(false);
    });

    it("rejects signatures of the wrong length", () => {
      const good = sign(TIMESTAMP_SECONDS);
      expect(verify({ signatureHeader: good.slice(0, -2) }).valid).toBe(false);
      expect(verify({ signatureHeader: `${good}00` }).valid).toBe(false);
      expect(verify({ signatureHeader: "sha256=" }).valid).toBe(false);
    });

    it("rejects a signature made with another secret", () => {
      expect(verify({ signatureHeader: sign(TIMESTAMP_SECONDS, BODY, "another-secret") }).valid).toBe(false);
    });

    it("rejects a tampered body", () => {
      const tampered = Buffer.from('{"schema":"paperclip.event.v1","title":"Disk almost fulL"}');
      expect(verify({ rawBody: tampered }).valid).toBe(false);
    });

    it("rejects a timestamp that was not the one signed, even inside the window", () => {
      const replayedLater = String(Number(TIMESTAMP_SECONDS) + 10);
      expect(verify({ timestampHeader: replayedLater }).valid).toBe(false);
    });

    it("rejects a signature over the body alone (the GitHub scheme)", () => {
      const bodyOnly = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");
      expect(verify({ signatureHeader: bodyOnly }).valid).toBe(false);
    });
  });

  describe("missing or malformed headers", () => {
    it.each([null, undefined, "", "   "])("rejects a missing signature header %j", (signatureHeader) => {
      expect(verify({ signatureHeader })).toEqual({ valid: false });
    });

    it.each([null, undefined, "", "   "])("rejects a missing timestamp header %j", (timestampHeader) => {
      expect(verify({ timestampHeader })).toEqual({ valid: false });
    });

    it.each(["abc", "NaN", "Infinity", "2026-01-01T00:00:00Z"])("rejects an unparsable timestamp %j", (timestamp) => {
      expect(verify({ timestampHeader: timestamp, signatureHeader: sign(timestamp) }).valid).toBe(false);
    });
  });

  describe("replay window", () => {
    it("accepts a timestamp up to the window in the past, and no further", () => {
      const atEdge = String(Number(TIMESTAMP_SECONDS) - 300);
      expect(verify({ timestampHeader: atEdge, signatureHeader: sign(atEdge) }).valid).toBe(true);
      const beyond = String(Number(TIMESTAMP_SECONDS) - 301);
      expect(verify({ timestampHeader: beyond, signatureHeader: sign(beyond) }).valid).toBe(false);
    });

    it("rejects a stale but correctly signed request", () => {
      const stale = String(Number(TIMESTAMP_SECONDS) - 3600);
      expect(verify({ timestampHeader: stale, signatureHeader: sign(stale) })).toEqual({ valid: false });
    });

    it("accepts a timestamp up to the window in the future, and no further", () => {
      const atEdge = String(Number(TIMESTAMP_SECONDS) + 300);
      expect(verify({ timestampHeader: atEdge, signatureHeader: sign(atEdge) }).valid).toBe(true);
      const beyond = String(Number(TIMESTAMP_SECONDS) + 301);
      expect(verify({ timestampHeader: beyond, signatureHeader: sign(beyond) }).valid).toBe(false);
    });

    it("rejects a far-future timestamp", () => {
      const future = String(Number(TIMESTAMP_SECONDS) + 86_400);
      expect(verify({ timestampHeader: future, signatureHeader: sign(future) })).toEqual({ valid: false });
    });

    it("honours the configured window", () => {
      const sixtySecondsOld = String(Number(TIMESTAMP_SECONDS) - 60);
      const header = { timestampHeader: sixtySecondsOld, signatureHeader: sign(sixtySecondsOld) };
      expect(verify({ ...header, replayWindowSec: 30 }).valid).toBe(false);
      expect(verify({ ...header, replayWindowSec: 60 }).valid).toBe(true);
      expect(verify({ ...header, replayWindowSec: 86_400 }).valid).toBe(true);
    });

    it("checks the window against the injected clock", () => {
      expect(verify({ now: NOW_MS + 299_000 }).valid).toBe(true);
      expect(verify({ now: NOW_MS + 301_000 }).valid).toBe(false);
      expect(verify({ now: NOW_MS - 299_000 }).valid).toBe(true);
      expect(verify({ now: NOW_MS - 301_000 }).valid).toBe(false);
    });

    describe("default clock", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("uses the current time when none is injected", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(NOW_MS));
        expect(verify({ now: undefined }).valid).toBe(true);
        vi.setSystemTime(new Date(NOW_MS + 600_000));
        expect(verify({ now: undefined }).valid).toBe(false);
      });
    });
  });

  describe("timestamp units", () => {
    it("accepts a millisecond timestamp when the signature covers the millisecond string", () => {
      const ms = String(NOW_MS);
      const result = verify({ timestampHeader: ms, signatureHeader: sign(ms) });
      expect(result).toEqual({ valid: true, timestamp: ms, expectedHmac: sign(ms) });
    });

    it("applies the replay window to millisecond timestamps as well", () => {
      const stale = String(NOW_MS - 301_000);
      expect(verify({ timestampHeader: stale, signatureHeader: sign(stale) }).valid).toBe(false);
      const fresh = String(NOW_MS - 299_000);
      expect(verify({ timestampHeader: fresh, signatureHeader: sign(fresh) }).valid).toBe(true);
    });

    it("signs the header string as sent, so a seconds signature does not validate a millisecond header", () => {
      const ms = String(NOW_MS);
      expect(verify({ timestampHeader: ms, signatureHeader: sign(TIMESTAMP_SECONDS) }).valid).toBe(false);
    });

    it("keeps the replay key distinct for the same instant sent in different units", () => {
      const seconds = verify();
      const ms = String(NOW_MS);
      const millis = verify({ timestampHeader: ms, signatureHeader: sign(ms) });
      if (!seconds.valid || !millis.valid) throw new Error("expected both to verify");
      expect(`${seconds.timestamp}:${seconds.expectedHmac}`).not.toBe(`${millis.timestamp}:${millis.expectedHmac}`);
    });
  });
});

describe("verifyGithubHmacSignature", () => {
  // Test vector from GitHub's "Validating webhook deliveries" documentation.
  const githubSecret = "It's a Secret to Everybody";
  const githubBody = Buffer.from("Hello, World!");
  const githubSignature = "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  it("accepts the documented GitHub test vector", () => {
    expect(
      verifyGithubHmacSignature({ secret: githubSecret, rawBody: githubBody, signature: `sha256=${githubSignature}` }),
    ).toBe(true);
  });

  it("accepts the signature without the sha256= prefix", () => {
    expect(verifyGithubHmacSignature({ secret: githubSecret, rawBody: githubBody, signature: githubSignature })).toBe(true);
  });

  it("trims whitespace around the header", () => {
    expect(
      verifyGithubHmacSignature({ secret: githubSecret, rawBody: githubBody, signature: ` sha256=${githubSignature}\n` }),
    ).toBe(true);
  });

  it("computes the same signature a sender would for an arbitrary body", () => {
    const signature = `sha256=${crypto.createHmac("sha256", SECRET).update(BODY).digest("hex")}`;
    expect(verifyGithubHmacSignature({ secret: SECRET, rawBody: BODY, signature })).toBe(true);
  });

  it("rejects a wrong signature of the right length", () => {
    expect(verifyGithubHmacSignature({ secret: githubSecret, rawBody: githubBody, signature: `sha256=${"0".repeat(64)}` })).toBe(false);
  });

  it("rejects a signature of the wrong length", () => {
    expect(verifyGithubHmacSignature({ secret: githubSecret, rawBody: githubBody, signature: `sha256=${githubSignature.slice(2)}` })).toBe(false);
    expect(verifyGithubHmacSignature({ secret: githubSecret, rawBody: githubBody, signature: "sha256=" })).toBe(false);
  });

  it("rejects a tampered body and a different secret", () => {
    const signature = `sha256=${githubSignature}`;
    expect(verifyGithubHmacSignature({ secret: githubSecret, rawBody: Buffer.from("Hello, World?"), signature })).toBe(false);
    expect(verifyGithubHmacSignature({ secret: "another secret", rawBody: githubBody, signature })).toBe(false);
  });

  it.each([null, undefined, "", "   "])("rejects a missing signature %j", (signature) => {
    expect(verifyGithubHmacSignature({ secret: githubSecret, rawBody: githubBody, signature })).toBe(false);
  });

  it("does not accept the Paperclip timestamped scheme", () => {
    expect(verifyGithubHmacSignature({ secret: SECRET, rawBody: BODY, signature: sign(TIMESTAMP_SECONDS) })).toBe(false);
  });
});
