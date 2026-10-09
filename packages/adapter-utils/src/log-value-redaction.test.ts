import { describe, expect, it } from "vitest";
import {
  createPemStreamRedactor,
  hasCredentialKeyName,
  isSensitiveEnvKey,
  maskPemBlocks,
  maskUrlUserInfo,
  redactSecretShapedText,
  REDACTED_LOG_VALUE,
} from "./log-value-redaction.js";

const pemMarker = (edge: "BEGIN" | "END", kind: string) => `${"-".repeat(5)}${edge} ${kind}${"-".repeat(5)}`;
const BEGIN = pemMarker("BEGIN", "PRIVATE KEY");
const END = pemMarker("END", "PRIVATE KEY");
const BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";

describe("hasCredentialKeyName", () => {
  it.each(["DSN", "SENTRY_DSN", "ssh_passphrase", "connectionString", "connection-string", "CONNECTION_STRING", "GH_PAT", "pat", "PAT_READONLY", "PEM", "tls-cert-pem"])(
    "matches %s",
    (key) => expect(hasCredentialKeyName(key)).toBe(true),
  );

  it.each(["path", "PATH", "PYTHONPATH", "pattern", "pemission", "key", "issueKey", "token", "HOME"])(
    "does not match %s",
    (key) => expect(hasCredentialKeyName(key)).toBe(false),
  );
});

describe("isSensitiveEnvKey", () => {
  it("is the env word list plus the credential key names", () => {
    expect(isSensitiveEnvKey("API_KEY")).toBe(true);
    expect(isSensitiveEnvKey("SERVICE_TOKEN")).toBe(true);
    expect(isSensitiveEnvKey("GH_PAT")).toBe(true);
    expect(isSensitiveEnvKey("PATH")).toBe(false);
  });
});

describe("maskUrlUserInfo", () => {
  it.each([
    ["postgres://u:p@h/db", "postgres://u:***REDACTED***@h/db"],
    ["postgres://u:p@ss@h/db", "postgres://u:***REDACTED***@h/db"],
    ["https://ghp_example@github.com/o/r.git", "https://***REDACTED***@github.com/o/r.git"],
    ["a https://a:b@one.example/x b ssh://c:d@two.example/y", "a https://a:***REDACTED***@one.example/x b ssh://c:***REDACTED***@two.example/y"],
    ["https://example.com/a?x=a@b", "https://example.com/a?x=a@b"],
    ["https://registry.example.com/@scope/pkg", "https://registry.example.com/@scope/pkg"],
    ["ops@example.com", "ops@example.com"],
    ["plain text", "plain text"],
  ])("%s", (input, expected) => expect(maskUrlUserInfo(input)).toBe(expected));

  it("is stable on its own output", () => {
    const once = maskUrlUserInfo("postgres://u:p@h/db");
    expect(maskUrlUserInfo(once)).toBe(once);
  });

  it("takes linear time on a long value", () => {
    const run = "a".repeat(200_000);
    const started = Date.now();
    expect(maskUrlUserInfo(run)).toBe(run);
    expect(maskUrlUserInfo(`${run}://x`)).toBe(`${run}://x`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("maskPemBlocks", () => {
  it("replaces a block and keeps the text around it", () => {
    expect(maskPemBlocks(`before ${BEGIN}\n${BODY}\n${END} after`)).toBe(`before ${REDACTED_LOG_VALUE} after`);
  });

  it("replaces every block of a value", () => {
    expect(maskPemBlocks(`${BEGIN}\n${BODY}\n${END}\nmid\n${BEGIN}\n${BODY}\n${END}`)).toBe(`${REDACTED_LOG_VALUE}\nmid\n${REDACTED_LOG_VALUE}`);
  });

  it("redacts a block that has no end line to the end of the text", () => {
    expect(maskPemBlocks(`head ${pemMarker("BEGIN", "CERTIFICATE")}\n${BODY}`)).toBe(`head ${REDACTED_LOG_VALUE}`);
  });

  it("leaves text without a marker alone", () => {
    expect(maskPemBlocks("-----just dashes----- and END markers -----END X-----")).toBe(
      "-----just dashes----- and END markers -----END X-----",
    );
  });

  it("takes linear time on repeated and unterminated markers", () => {
    const started = Date.now();
    maskPemBlocks("-----BEGIN ".repeat(20_000));
    maskPemBlocks(`-----BEGIN ${"A".repeat(200_000)}`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("redactSecretShapedText", () => {
  it("masks both kinds in one pass", () => {
    expect(redactSecretShapedText(`u=postgres://u:p@h/db k=${BEGIN}\n${BODY}\n${END}`)).toBe(
      `u=postgres://u:${REDACTED_LOG_VALUE}@h/db k=${REDACTED_LOG_VALUE}`,
    );
  });
});

describe("createPemStreamRedactor", () => {
  it("redacts a block that arrives in several chunks and keeps the text around it", () => {
    const redactor = createPemStreamRedactor();
    expect(redactor.redact(`log\n${BEGIN}\n`)).toBe(`log\n${REDACTED_LOG_VALUE}`);
    expect(redactor.redact(`${BODY}\n`)).toBe(REDACTED_LOG_VALUE);
    expect(redactor.redact(`${BODY}\n`)).toBe(REDACTED_LOG_VALUE);
    expect(redactor.redact(`${END}\nnext\n`)).toBe(`${REDACTED_LOG_VALUE}\nnext\n`);
    expect(redactor.redact("after\n")).toBe("after\n");
  });

  it("passes a chunk with no marker through unchanged", () => {
    expect(createPemStreamRedactor().redact("plain line\n")).toBe("plain line\n");
  });

  it("finds a BEGIN marker split between two chunks", () => {
    const redactor = createPemStreamRedactor();
    expect(redactor.redact(`x ${BEGIN.slice(0, 20)}`)).toBe(`x ${BEGIN.slice(0, 20)}`);
    expect(redactor.redact(`${BEGIN.slice(20)}\n${BODY}\n`)).toBe(REDACTED_LOG_VALUE);
    expect(redactor.redact(`${END}\n`)).toBe(`${REDACTED_LOG_VALUE}\n`);
  });

  it("finds an END marker split between two chunks", () => {
    const redactor = createPemStreamRedactor();
    redactor.redact(`${BEGIN}\n${BODY}\n`);
    expect(redactor.redact(END.slice(0, 12))).toBe(REDACTED_LOG_VALUE);
    expect(redactor.redact(`${END.slice(12)}\nok\n`)).toBe(`${REDACTED_LOG_VALUE}\nok\n`);
    expect(redactor.redact("more\n")).toBe("more\n");
  });

  it("does not match a block it has already closed when the next chunk arrives", () => {
    const redactor = createPemStreamRedactor();
    const tiny = `${pemMarker("BEGIN", "A")}\nx\n${pemMarker("END", "A")}`;
    expect(redactor.redact(tiny)).toBe(REDACTED_LOG_VALUE);
    expect(redactor.redact("next line\n")).toBe("next line\n");
  });

  it("handles a whole block and a second block that opens in the same chunk", () => {
    const redactor = createPemStreamRedactor();
    expect(redactor.redact(`${BEGIN}\n${BODY}\n${END}\nmid\n${BEGIN}\n${BODY}\n`)).toBe(
      `${REDACTED_LOG_VALUE}\nmid\n${REDACTED_LOG_VALUE}`,
    );
    expect(redactor.redact(`${END}\n`)).toBe(`${REDACTED_LOG_VALUE}\n`);
  });

  it("stops redacting when a block stays open for more than 64 KiB", () => {
    const redactor = createPemStreamRedactor();
    redactor.redact(`${BEGIN}\n`);
    const filler = `${"A".repeat(1023)}\n`;
    for (let i = 0; i < 64; i += 1) expect(redactor.redact(filler)).toBe(REDACTED_LOG_VALUE);
    expect(redactor.redact("normal output\n")).toBe("normal output\n");
  });

  it("keeps separate state in separate instances", () => {
    const stdout = createPemStreamRedactor();
    const stderr = createPemStreamRedactor();
    stdout.redact(`${BEGIN}\n`);
    expect(stderr.redact("plain\n")).toBe("plain\n");
  });

  it("takes linear time on a long chunk", () => {
    const redactor = createPemStreamRedactor();
    const started = Date.now();
    redactor.redact(`-----BEGIN ${"A".repeat(200_000)}`);
    redactor.redact("-----BEGIN ".repeat(20_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
