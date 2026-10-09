import { describe, expect, it } from "vitest";
import { redactEnvForLogs } from "./server-utils.js";

describe("redactEnvForLogs", () => {
  const pemMarker = (edge: "BEGIN" | "END", kind: string) => `${"-".repeat(5)}${edge} ${kind}${"-".repeat(5)}`;
  const PEM_BLOCK = `${pemMarker("BEGIN", "PRIVATE KEY")}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nZm9vYmFy\n${pemMarker("END", "PRIVATE KEY")}`;

  it.each([
    "SENTRY_DSN",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "SSH_KEY_PASSPHRASE",
    "GH_PAT",
    "GITHUB_PAT_TOKEN",
    "PAT_READONLY",
    "DATABASE_CONNECTION_STRING",
    "AZURE_STORAGE_CONNECTIONSTRING",
    "SUPABASE_JWT",
    "TLS_CERT_PEM",
    "PEM_BUNDLE",
    "BEARER",
    "AUTH_HEADER",
    "SERVICE_TOKEN",
  ])("hides the value of %s by its key name", (key) => {
    expect(redactEnvForLogs({ [key]: "value" })).toEqual({ [key]: "***REDACTED***" });
  });

  it.each([
    "PATH",
    "PATTERN",
    "PYTHONPATH",
    "PWD",
    "HOME",
    "NODE_OPTIONS",
    "XDG_CONFIG_HOME",
    "PAPERCLIP_RUN_ID",
  ])("keeps the value of %s", (key) => {
    expect(redactEnvForLogs({ [key]: "value" })).toEqual({ [key]: "value" });
  });

  it.each([
    ["masks only the password of a URL", "postgres://u:p@h/db", "postgres://u:***REDACTED***@h/db"],
    ["masks a password that holds an @", "postgres://u:p@ss@h/db", "postgres://u:***REDACTED***@h/db"],
    ["masks user info without a password whole", "https://ghp_example@github.com/o/r.git", "https://***REDACTED***@github.com/o/r.git"],
    [
      "masks every URL in a value",
      "--from https://a:b@one.example/x --to ssh://c:d@two.example/y",
      "--from https://a:***REDACTED***@one.example/x --to ssh://c:***REDACTED***@two.example/y",
    ],
    ["keeps a URL without user info", "https://example.com/a", "https://example.com/a"],
    ["keeps an @ in a query", "https://api.example.com/v1?x=a@b", "https://api.example.com/v1?x=a@b"],
    ["keeps an @ in a path", "https://registry.example.com/@scope/pkg", "https://registry.example.com/@scope/pkg"],
    ["keeps an address without a scheme", "ops@example.com", "ops@example.com"],
    ["redacts a PEM value", PEM_BLOCK, "***REDACTED***"],
    ["redacts the whole value around a PEM block", `before ${PEM_BLOCK} after`, "***REDACTED***"],
    [
      "redacts a PEM block that has no end line",
      `head ${pemMarker("BEGIN", "CERTIFICATE")}\nMIIDdzCCAl+gAwIBAgIE`,
      "***REDACTED***",
    ],
  ])("%s under a key with a neutral name", (_name, value, expected) => {
    expect(redactEnvForLogs({ MIRROR: value })).toEqual({ MIRROR: expected });
  });

  it("handles a long value in linear time", () => {
    const run = "a".repeat(200_000);
    const started = Date.now();
    const redacted = redactEnvForLogs({ BLOB: run, BLOB_SCHEME: `${run}://x`, BLOB_USER: `${run}://u:p@h` });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(redacted.BLOB).toBe(run);
    expect(redacted.BLOB_SCHEME).toBe(`${run}://x`);
    expect(redacted.BLOB_USER).toBe(`${run}://u:***REDACTED***@h`);
  });

  it("gives the same result when it runs again on its own output", () => {
    const once = redactEnvForLogs({
      DATABASE_URL: "postgres://u:p@h/db",
      MIRROR: "https://ghp_example@github.com/o/r.git",
      SIGNING: PEM_BLOCK,
      GH_PAT: "value",
      PATH: "/usr/bin",
    });
    expect(redactEnvForLogs(once)).toEqual(once);
  });
});
