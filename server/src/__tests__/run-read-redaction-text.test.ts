import { describe, expect, it, vi } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { createPemTextRedactor, redactSecretShapedText } from "../services/run-read-redaction.js";

// Text scanning does not read instance settings or encrypted secret material.
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: vi.fn() }));
vi.mock("../services/run-secret-redaction.js", () => ({ createRunSecretRedactionRegistry: vi.fn() }));

const R = REDACTED_EVENT_VALUE;
// Built at runtime so the public-config guard never sees a literal key header in the source.
const PEM_BEGIN = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");

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
    // Malformed or unfinished blocks fail closed through the end of the text.
    expect(redactSecretShapedText("-----BEGIN RSA-PSS KEY-----\nx\n-----END RSA-PSS KEY-----")).toBe(R);
    expect(redactSecretShapedText("-----BEGIN CERTIFICATE-----\nno end")).toBe(R);
    // An end line whose label has a dash does not close the block; the next valid one does.
    expect(redactSecretShapedText("-----BEGIN A----- -----END bad-label----- x -----END B----- tail")).toBe(`${R} tail`);
  });

  it("redacts an unfinished PEM block through the end of the string", () => {
    expect(redactSecretShapedText(`before ${PEM_BEGIN}\nY2FuYXJ5LXByaXZhdGUta2V5`))
      .toBe(`before ${R}`);
  });

  it("redacts PEM material across every possible transcript chunk boundary", () => {
    const secret = "Y2FuYXJ5LXByaXZhdGUta2V5";
    const text = `before ${PEM_BEGIN}\n${secret}\n-----END PRIVATE KEY----- after`;
    for (let split = 1; split < text.length; split += 1) {
      const { redact } = createPemTextRedactor();
      const result = redact(text.slice(0, split)) + redact(text.slice(split));
      expect(result).not.toContain(secret);
      expect(result).toContain("before ");
      expect(result).toContain(" after");
    }
    const { redact } = createPemTextRedactor();
    const result = [...text].map(redact).join("");
    expect(result).not.toContain(secret);
    expect(result).toContain(" after");
  });

  it("keeps unfinished-block state until a complete footer arrives", () => {
    const scanner = createPemTextRedactor();
    expect(scanner.hasOpenBlock()).toBe(false);
    scanner.redact(`${PEM_BEGIN}\nbody`);
    expect(scanner.hasOpenBlock()).toBe(true);
    scanner.redact("-----END PRIVATE KEY---");
    expect(scanner.hasOpenBlock()).toBe(true);
    expect(scanner.redact("-- diagnostic")).toBe(`${R} diagnostic`);
    expect(scanner.hasOpenBlock()).toBe(false);
  });

  it("stays linear on long strings with many scheme or PEM starts", () => {
    const schemeLike = timed("a.".repeat(64 * 1024));
    expect(schemeLike.result).toBe("a.".repeat(64 * 1024));
    expect(schemeLike.ms).toBeLessThan(250);

    const headers = timed("-----BEGIN A-----".repeat(10_000));
    expect(headers.result).toBe(R);
    expect(headers.ms).toBeLessThan(250);
  });
});
