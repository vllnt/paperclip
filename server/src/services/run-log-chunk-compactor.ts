import {
  createPemStreamRedactor,
  createStreamTailCarry,
  type PemStreamRedactor,
} from "@paperclipai/adapter-utils/log-value-redaction";
import { redactSensitiveText } from "../redaction.js";

const MAX_PERSISTED_LOG_CHUNK_CHARS = 64 * 1024;
const INLINE_BASE64_IMAGE_DATA_RE =
  /("type":"image","source":\{"type":"base64","data":")([A-Za-z0-9+/=]{1024,})(")/g;

function redactInlineBase64ImageData(chunk: string) {
  return chunk.replace(
    INLINE_BASE64_IMAGE_DATA_RE,
    (_match, prefix: string, data: string, suffix: string) =>
      `${prefix}[omitted base64 image data: ${data.length} chars]${suffix}`,
  );
}

export function compactRunLogChunk(
  chunk: string,
  maxChars = MAX_PERSISTED_LOG_CHUNK_CHARS,
  pemStream?: PemStreamRedactor,
) {
  const withoutImages = redactInlineBase64ImageData(chunk);
  const normalized = redactSensitiveText(
    pemStream ? pemStream.redact(withoutImages) : withoutImages,
  );
  if (normalized.length <= maxChars) return normalized;

  const headChars = Math.max(0, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(0, Math.floor(maxChars * 0.25));
  const omittedChars = Math.max(0, normalized.length - headChars - tailChars);
  const marker = `\n[paperclip truncated run log chunk: omitted ${omittedChars} chars]\n`;
  return `${normalized.slice(0, headChars)}${marker}${normalized.slice(normalized.length - tailChars)}`;
}

/** The chunk compactor of one run. See {@link createRunLogChunkCompactor}. */
export interface RunLogChunkCompactor {
  /**
   * @param stream - The stream that the chunk belongs to.
   * @param chunk - The next chunk of that stream.
   * @returns The redacted text that is ready to be written. It can be empty, because the end of a
   * chunk is held back until its token is whole, and it can hold text from earlier chunks.
   */
  compact(stream: "stdout" | "stderr", chunk: string): string;
  /**
   * @param stream - The stream that ended.
   * @returns The redacted text that the stream still held back. Call it once for each stream
   * before the run log is finalized.
   */
  flush(stream: "stdout" | "stderr"): string;
}

/**
 * Creates the chunk compactor of one run. For each stream it keeps a tail carry, so a token that
 * is split between two chunks (a URL with a password) is whole when it is redacted, and a PEM
 * redactor, so a PEM block that spans any number of chunks is dropped from its BEGIN marker to its
 * END marker and shows as one marker. Text that is held back is never written raw: it is released
 * through the same redaction, in the next chunk, at the bound, or at `flush`.
 *
 * @returns A compactor that holds the state of the two streams of one run.
 */
export function createRunLogChunkCompactor(): RunLogChunkCompactor {
  const streams = {
    stdout: { carry: createStreamTailCarry(), pem: createPemStreamRedactor() },
    stderr: { carry: createStreamTailCarry(), pem: createPemStreamRedactor() },
  };
  const compactReady = (stream: "stdout" | "stderr", ready: string): string =>
    ready === "" ? "" : compactRunLogChunk(ready, MAX_PERSISTED_LOG_CHUNK_CHARS, streams[stream].pem);
  return {
    compact: (stream, chunk) => compactReady(stream, streams[stream].carry.push(chunk)),
    flush: (stream) => compactReady(stream, streams[stream].carry.flush()),
  };
}
