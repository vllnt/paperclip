import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactEventPayload, redactSensitiveText } from "../redaction.js";

describe("run-log payloads share one URL, PEM and key policy", () => {
  const pemMarker = (edge: "BEGIN" | "END", kind: string) => `${"-".repeat(5)}${edge} ${kind}${"-".repeat(5)}`;
  const PEM_BLOCK = `${pemMarker("BEGIN", "PRIVATE KEY")}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n${pemMarker("END", "PRIVATE KEY")}`;

  it("masks the password of a URL in adapter.invoke command arguments", () => {
    const payload = redactEventPayload({
      command: "agent",
      commandArgs: ["--gateway", "https://user:FAKE_SECRET_123@host/x", "--token-file", "/tmp/t"],
    });
    expect(payload?.commandArgs).toEqual(["--gateway", "https://user:***REDACTED***@host/x", "--token-file", "/tmp/t"]);
  });

  it("masks a URL password and a PEM block in any string leaf of a payload", () => {
    const payload = redactEventPayload({
      context: { note: `use postgres://u:FAKE_SECRET_123@h/db and ${PEM_BLOCK} then stop` },
      list: ["https://ghp_FAKE_SECRET_123@github.com/o/r.git"],
    });
    expect(JSON.stringify(payload)).not.toContain("FAKE_SECRET_123");
    expect(JSON.stringify(payload)).not.toContain("MIIEvQ");
    expect((payload?.context as { note: string }).note).toBe(
      "use postgres://u:***REDACTED***@h/db and ***REDACTED*** then stop",
    );
  });

  it("hides the new credential key names at any depth", () => {
    expect(
      redactEventPayload({
        nested: { PEM: "FAKE_SECRET_123", GH_PAT: "FAKE_SECRET_123" },
        list: [{ DSN: "FAKE_SECRET_123" }, { ssh_passphrase: "FAKE_SECRET_123" }, { connectionString: "FAKE_SECRET_123" }],
      }),
    ).toEqual({
      nested: { PEM: REDACTED_EVENT_VALUE, GH_PAT: REDACTED_EVENT_VALUE },
      list: [{ DSN: REDACTED_EVENT_VALUE }, { ssh_passphrase: REDACTED_EVENT_VALUE }, { connectionString: REDACTED_EVENT_VALUE }],
    });
  });

  it("keeps payload fields that only look like the new names", () => {
    const payload = { path: "/a", pattern: "x", PYTHONPATH: "/b", key: "plain", issueKey: "PAP-1", pemission: "ok" };
    expect(redactEventPayload(payload)).toEqual(payload);
  });

  it("masks URL and PEM text through redactSensitiveText", () => {
    expect(redactSensitiveText("MATERIAL=postgres://u:FAKE_SECRET_123@h/db")).toBe("MATERIAL=postgres://u:***REDACTED***@h/db");
    expect(redactSensitiveText(`before ${PEM_BLOCK} after`)).toBe("before ***REDACTED*** after");
    expect(redactSensitiveText("see https://example.com/a?x=a@b")).toBe("see https://example.com/a?x=a@b");
  });
});
