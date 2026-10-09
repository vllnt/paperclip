import { describe, expect, it } from "vitest";
import { compactRunLogChunk, createRunLogChunkCompactor } from "../services/heartbeat.js";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[paperclip truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `auth {"refresh_token":"refresh-token-fixture-secret"}`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("refresh-token-fixture-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });

  it("masks the password of a URL in a streamed chunk", () => {
    expect(compactRunLogChunk("MATERIAL=postgres://u:FAKE_SECRET_123@h/db\n")).toBe(
      "MATERIAL=postgres://u:***REDACTED***@h/db\n",
    );
  });

  describe("createRunLogChunkCompactor", () => {
    const pemMarker = (edge: "BEGIN" | "END", kind: string) => `${"-".repeat(5)}${edge} ${kind}${"-".repeat(5)}`;
    const BEGIN = pemMarker("BEGIN", "PRIVATE KEY");
    const END = pemMarker("END", "PRIVATE KEY");

    it("redacts every chunk of a PEM block split across chunks", () => {
      const compact = createRunLogChunkCompactor();
      const out = [
        compact("stdout", `starting\n${BEGIN}\n`),
        compact("stdout", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n"),
        compact("stdout", "Zm9vYmFyZm9vYmFy\n"),
        compact("stdout", `${END}\ndone\n`),
        compact("stdout", "later line\n"),
      ];
      expect(out.join("")).not.toContain("MIIEvQ");
      expect(out.join("")).not.toContain("Zm9vYmFy");
      expect(out[0]).toContain("starting");
      expect(out[3]).toContain("done");
      expect(out[4]).toBe("later line\n");
    });

    it("finds a BEGIN marker that is split across two chunks", () => {
      const compact = createRunLogChunkCompactor();
      const out = [
        compact("stdout", `head ${BEGIN.slice(0, 14)}`),
        compact("stdout", `${BEGIN.slice(14)}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n${END}\n`),
      ];
      expect(out.join("")).not.toContain("MIIEvQ");
      expect(out[1]).toBe("***REDACTED***\n");
    });

    it("keeps one state per stream", () => {
      const compact = createRunLogChunkCompactor();
      compact("stdout", `${BEGIN}\n`);
      expect(compact("stderr", "plain error line\n")).toBe("plain error line\n");
      expect(compact("stdout", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n")).toBe("***REDACTED***");
    });

    it("keeps one state per run", () => {
      const first = createRunLogChunkCompactor();
      const second = createRunLogChunkCompactor();
      first("stdout", `${BEGIN}\n`);
      expect(second("stdout", "plain line\n")).toBe("plain line\n");
    });

    it("masks a URL password in a chunk", () => {
      const compact = createRunLogChunkCompactor();
      expect(compact("stderr", "retry https://u:FAKE_SECRET_123@h/x\n")).toBe("retry https://u:***REDACTED***@h/x\n");
    });
  });
});
