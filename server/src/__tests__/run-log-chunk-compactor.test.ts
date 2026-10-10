import { describe, expect, it } from "vitest";
import { compactRunLogChunk, createRunLogChunkCompactor } from "../services/run-log-chunk-compactor.js";

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
    const MARKER = "***REDACTED***";
    const stream = (compactor: ReturnType<typeof createRunLogChunkCompactor>, name: "stdout" | "stderr", chunks: string[]) =>
      [...chunks.map((chunk) => compactor.compact(name, chunk)), compactor.flush(name)].join("");

    it("redacts every chunk of a PEM block split across chunks and gives one marker", () => {
      const compactor = createRunLogChunkCompactor();
      const out = stream(compactor, "stdout", [
        `starting\n${BEGIN}\n`,
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n",
        "Zm9vYmFyZm9vYmFy\n",
        `${END}\ndone\n`,
        "later line\n",
      ]);
      expect(out).toBe(`starting\n${MARKER}\ndone\nlater line\n`);
    });

    it("finds a BEGIN marker that is split across two chunks", () => {
      const compactor = createRunLogChunkCompactor();
      const out = stream(compactor, "stdout", [
        `head ${BEGIN.slice(0, 14)}`,
        `${BEGIN.slice(14)}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n${END}\n`,
      ]);
      expect(out).not.toContain("MIIEvQ");
      expect(out.split(MARKER)).toHaveLength(2);
    });

    it("never gives back a PEM key that is longer than 64 KiB, streamed in pieces, and gives one marker", () => {
      const compactor = createRunLogChunkCompactor();
      const lines = Array.from({ length: 3000 }, (_, i) => `KEYLINE${i}${"A".repeat(40)}\n`);
      const chunks = [`${BEGIN}\n`];
      for (let i = 0; i < lines.length; i += 100) chunks.push(lines.slice(i, i + 100).join(""));
      chunks.push(`${END}\nafter\n`);
      const out = stream(compactor, "stdout", chunks);
      expect(out).not.toContain("KEYLINE");
      expect(out).toBe(`${MARKER}\nafter\n`);
    });

    it("gives no key line when the stream ends inside a PEM block", () => {
      const compactor = createRunLogChunkCompactor();
      const out = stream(compactor, "stdout", [`head\n${BEGIN}\n`, "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n", "Zm9vYmFy"]);
      expect(out).toBe(`head\n${MARKER}`);
    });

    it("never gives back a credentialed URL that is split across two chunks, at any offset", () => {
      const line = "retry https://user:FAKE_SECRET_123@host/x now\n";
      for (let i = 1; i < line.length; i += 1) {
        const compactor = createRunLogChunkCompactor();
        const out = stream(compactor, "stdout", [line.slice(0, i), line.slice(i)]);
        expect(out, `split at ${i}`).not.toContain("FAKE_SECRET_123");
        expect(out, `split at ${i}`).toBe("retry https://user:***REDACTED***@host/x now\n");
      }
    });

    it("never gives back a credentialed URL that is split across three chunks, at any two offsets", () => {
      const line = "go postgres://u:FAKE_SECRET_123@h/db\n";
      for (let i = 1; i < line.length; i += 1) {
        for (let j = i + 1; j < line.length; j += 3) {
          const compactor = createRunLogChunkCompactor();
          const out = stream(compactor, "stderr", [line.slice(0, i), line.slice(i, j), line.slice(j)]);
          expect(out, `split at ${i},${j}`).not.toContain("FAKE_SECRET_123");
        }
      }
    });

    it("redacts and gives back a credentialed URL that is held when the stream ends", () => {
      const compactor = createRunLogChunkCompactor();
      expect(compactor.compact("stdout", "last https://u:FAKE_SECRET_123@h/x")).toBe("last ");
      expect(compactor.flush("stdout")).toBe("https://u:***REDACTED***@h/x");
      expect(compactor.flush("stdout")).toBe("");
    });

    it("keeps every character of text that has no secret, in order, across any split", () => {
      const text = "line one\nline  two\twith a tab\nno newline at the end";
      for (let i = 0; i <= text.length; i += 1) {
        const compactor = createRunLogChunkCompactor();
        expect(stream(compactor, "stdout", [text.slice(0, i), text.slice(i)])).toBe(text);
      }
    });

    it("redacts a token longer than the held bound and never gives it back raw", () => {
      const compactor = createRunLogChunkCompactor();
      const long = `https://u:FAKE_SECRET_123@h/${"x".repeat(20_000)}`;
      const out = stream(compactor, "stdout", [`a ${long}`, "tail\n"]);
      expect(out).not.toContain("FAKE_SECRET_123");
      expect(out.startsWith("a https://u:***REDACTED***@h/")).toBe(true);
    });

    it("keeps one state per stream", () => {
      const compactor = createRunLogChunkCompactor();
      compactor.compact("stdout", `${BEGIN}\n`);
      compactor.compact("stdout", "partial https://u:FAKE_SECRET_123@h");
      expect(compactor.compact("stderr", "plain error line\n")).toBe("plain error line\n");
      expect(compactor.compact("stdout", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n")).toBe("");
      expect(compactor.flush("stderr")).toBe("");
    });

    it("keeps one state per run", () => {
      const first = createRunLogChunkCompactor();
      const second = createRunLogChunkCompactor();
      first.compact("stdout", `${BEGIN}\n`);
      first.compact("stdout", "https://u:FAKE_SECRET_123@h");
      expect(second.compact("stdout", "plain line\n")).toBe("plain line\n");
      expect(second.flush("stdout")).toBe("");
    });
  });
});
