import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { redactSecretShapedText } from "../services/run-read-redaction.js";

const R = REDACTED_EVENT_VALUE;

function timed(text: string): { result: string; ms: number } {
  const started = performance.now();
  const result = redactSecretShapedText(text);
  return { result, ms: performance.now() - started };
}

describe("export text redaction", () => {
  it("removes URL userinfo and PEM blocks", () => {
    expect(redactSecretShapedText("db=postgres://admin:hunter2@db.example.com/app")).toBe(`db=postgres://${R}@db.example.com/app`);
    expect(redactSecretShapedText("clone https://token@git.example.com/repo.git")).toBe(`clone https://${R}@git.example.com/repo.git`);
    expect(redactSecretShapedText("see https://example.com/a@b")).toBe("see https://example.com/a@b");
    const pem = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----";
    expect(redactSecretShapedText(`a ${pem} b ${pem} c`)).toBe(`a ${R} b ${R} c`);
    // A header with a dash in its label, or a block with no end line, is left as it was.
    expect(redactSecretShapedText("-----BEGIN RSA-PSS KEY-----\nx\n-----END RSA-PSS KEY-----")).toBe("-----BEGIN RSA-PSS KEY-----\nx\n-----END RSA-PSS KEY-----");
    expect(redactSecretShapedText("-----BEGIN CERTIFICATE-----\nno end")).toBe("-----BEGIN CERTIFICATE-----\nno end");
    // An end line whose label has a dash does not close the block; the next valid one does.
    expect(redactSecretShapedText("-----BEGIN A----- -----END bad-label----- x -----END B----- tail")).toBe(`${R} tail`);
  });

  it("stays linear on long strings with many scheme or PEM starts", () => {
    const schemeLike = timed("a.".repeat(64 * 1024));
    expect(schemeLike.result).toBe("a.".repeat(64 * 1024));
    expect(schemeLike.ms).toBeLessThan(250);

    const headers = timed("-----BEGIN A-----".repeat(10_000));
    expect(headers.result).toBe("-----BEGIN A-----".repeat(10_000));
    expect(headers.ms).toBeLessThan(250);
  });
});
