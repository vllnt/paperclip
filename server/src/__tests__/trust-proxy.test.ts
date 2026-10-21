import { describe, expect, it } from "vitest";
import express from "express";
import { applyTrustProxy, parseTrustProxyEnv } from "../middleware/trust-proxy.js";

function appWithEnv(raw: string | undefined): express.Express {
  const app = express();
  applyTrustProxy(app, parseTrustProxyEnv(raw));
  return app;
}

describe("parseTrustProxyEnv", () => {
  it("unset leaves Express at its safe default (trust nothing)", () => {
    // Express's default trust-proxy setting is `false`. We verify the
    // setting is unchanged by comparing against a vanilla express()
    // instance that never had `applyTrustProxy` called on it.
    const baseline = express().get("trust proxy");
    const app = appWithEnv(undefined);
    expect(parseTrustProxyEnv(undefined)).toBeUndefined();
    expect(app.get("trust proxy")).toBe(baseline);
  });

  it("empty / false / 0 are treated as unset", () => {
    expect(parseTrustProxyEnv("")).toBeUndefined();
    expect(parseTrustProxyEnv("false")).toBeUndefined();
    expect(parseTrustProxyEnv("0")).toBeUndefined();
    const baseline = express().get("trust proxy");
    expect(appWithEnv("0").get("trust proxy")).toBe(baseline);
  });

  it("'true' yields boolean true and sets app accordingly", () => {
    expect(parseTrustProxyEnv("true")).toBe(true);
    expect(appWithEnv("true").get("trust proxy")).toBe(true);
  });

  it("positive integer is parsed as a number", () => {
    expect(parseTrustProxyEnv("2")).toBe(2);
    expect(appWithEnv("2").get("trust proxy")).toBe(2);
  });

  it("'01' throws (strict integer, no leading zeros)", () => {
    expect(() => parseTrustProxyEnv("01")).toThrow(/invalid integer/);
  });

  it("integer with internal whitespace throws", () => {
    // A value like "1 2" (digits + whitespace + digits) is clearly not
    // a single int and not a subnet list either — must be rejected.
    // This is distinct from " 2 " (surrounding whitespace), which the
    // outer `raw.trim()` accepts; see the next test for that contract.
    // The parser happens to reach the subnet-token path for "1 2"
    // (the inner-whitespace integer guard only fires when the whole
    // string is `^\s*\d+\s*$`), so we match the unrecognized-token
    // error rather than the "invalid integer" branch.
    expect(() => parseTrustProxyEnv("1 2")).toThrow(/unrecognized token "1 2"/);
  });

  it("integer with surrounding whitespace is accepted (trimmed)", () => {
    // The parser intentionally trims the *outer* value before matching,
    // so " 2 " is equivalent to "2". Locking this in so the contract
    // doesn't drift relative to the "internal whitespace throws" case.
    expect(parseTrustProxyEnv(" 2 ")).toBe(2);
    expect(appWithEnv(" 2 ").get("trust proxy")).toBe(2);
  });

  it("'loopback' yields a single-element array", () => {
    const v = parseTrustProxyEnv("loopback");
    expect(v).toEqual(["loopback"]);
    const app = appWithEnv("loopback");
    expect(app.get("trust proxy")).toEqual(["loopback"]);
  });

  it("'loopback,uniquelocal' yields a 2-element array", () => {
    expect(parseTrustProxyEnv("loopback,uniquelocal")).toEqual([
      "loopback",
      "uniquelocal",
    ]);
  });

  it("IPv4 CIDR is accepted", () => {
    expect(parseTrustProxyEnv("10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
  });

  it("mixed IPv4 + IPv6 CIDR list is accepted with whitespace tolerance", () => {
    expect(parseTrustProxyEnv(" 10.0.0.0/8 , fd00::/8 ")).toEqual([
      "10.0.0.0/8",
      "fd00::/8",
    ]);
  });

  it("'bogus' throws with a helpful message naming the bad token", () => {
    expect(() => parseTrustProxyEnv("bogus")).toThrow(/bogus/);
    expect(() => parseTrustProxyEnv("bogus")).toThrow(/loopback/);
  });

  it("partial-garbage list throws on the bad token, not silently dropped", () => {
    expect(() => parseTrustProxyEnv("loopback,not-a-cidr")).toThrow(
      /not-a-cidr/,
    );
  });
});

// `req.ip` is what the invite and login rate limits read. Express resolves it
// with proxy-addr: the peer address is the client unless it falls inside the
// trusted subnets, and only then is X-Forwarded-For believed. proxy-addr
// before 2.0.8 matched IPv4 clients (plain or IPv4-mapped IPv6) against any
// IPv6 trust entry whose leading bits are zero, so an untrusted client could
// pick its own `req.ip`.
describe("req.ip under a subnet TRUST_PROXY", () => {
  const SPOOFED = "198.51.100.9";

  function ipFor(raw: string, peer: string): string {
    const app = appWithEnv(raw);
    // Build the request as Express does, minus the socket: `req.ip` reads the
    // peer address and the X-Forwarded-For header through the app's trust setting.
    const req: express.Request = Object.create(app.request, {
      socket: { value: { remoteAddress: peer } },
      headers: { value: { "x-forwarded-for": SPOOFED } },
    });
    return req.ip ?? "";
  }

  it("ignores X-Forwarded-For from an IPv4-mapped IPv6 client outside the trusted IPv4 subnet", () => {
    expect(ipFor("10.0.0.0/8", "::ffff:203.0.113.5")).toBe("::ffff:203.0.113.5");
  });

  it("still believes X-Forwarded-For from an IPv4-mapped IPv6 proxy inside the trusted IPv4 subnet", () => {
    expect(ipFor("10.0.0.0/8", "::ffff:10.1.2.3")).toBe(SPOOFED);
  });

  it.each(["::/1", "::/64", "::ffff:a00:0/8"])(
    "IPv6 trust entry %s does not trust an IPv4 or IPv4-mapped client",
    (raw) => {
      expect(ipFor(raw, "::ffff:203.0.113.5")).toBe("::ffff:203.0.113.5");
      expect(ipFor(raw, "203.0.113.5")).toBe("203.0.113.5");
    },
  );

  it("trusts a full-length IPv4-mapped subnet only for addresses inside it", () => {
    const raw = "::ffff:a00:0/104";
    expect(ipFor(raw, "10.1.2.3")).toBe(SPOOFED);
    expect(ipFor(raw, "::ffff:10.1.2.3")).toBe(SPOOFED);
    expect(ipFor(raw, "::ffff:203.0.113.5")).toBe("::ffff:203.0.113.5");
    expect(ipFor(raw, "203.0.113.5")).toBe("203.0.113.5");
  });
});
