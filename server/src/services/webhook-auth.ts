import crypto from "node:crypto";

/**
 * Shared verification for Paperclip-signed webhook senders. Routine webhook
 * triggers and event sources both authenticate with these helpers so the
 * comparison rules live in exactly one place. Every function is pure: callers
 * decide how a failure is reported.
 */

/** Seconds or milliseconds since the epoch, as senders put it in `X-Paperclip-Timestamp`. */
export function normalizeWebhookTimestampMs(rawTimestamp: string): number | null {
  const parsed = Number(rawTimestamp);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1e12 ? parsed : parsed * 1000;
}

/** Constant-time compare of `Authorization: Bearer <secret>`. */
export function verifyBearerAuthorization(input: {
  secret: string;
  authorizationHeader: string | null | undefined;
}): boolean {
  const expected = `Bearer ${input.secret}`;
  const provided = input.authorizationHeader?.trim() ?? "";
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.alloc(expectedBuf.length);
  providedBuf.write(provided.slice(0, expectedBuf.length));
  return provided.length === expected.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
}

export type HmacSha256Verification =
  | { valid: false }
  | {
    valid: true;
    /** The timestamp exactly as the sender supplied it (the signed prefix). */
    timestamp: string;
    /** The server-computed signature, hex. Equal to the sender's once the `sha256=` prefix is dropped. */
    expectedHmac: string;
  };

/**
 * `X-Paperclip-Signature` is HMAC-SHA256 over `"{timestamp}.{rawBody}"`, hex,
 * optionally `sha256=`-prefixed, and `X-Paperclip-Timestamp` must be within
 * ±`replayWindowSec` of `now`.
 */
export function verifyHmacSha256Signature(input: {
  secret: string;
  rawBody: Buffer;
  signatureHeader: string | null | undefined;
  timestampHeader: string | null | undefined;
  replayWindowSec: number;
  now?: number;
}): HmacSha256Verification {
  const providedSignature = input.signatureHeader?.trim() ?? "";
  const providedTimestamp = input.timestampHeader?.trim() ?? "";
  if (!providedSignature || !providedTimestamp) return { valid: false };
  const tsMillis = normalizeWebhookTimestampMs(providedTimestamp);
  if (tsMillis == null) return { valid: false };
  if (Math.abs((input.now ?? Date.now()) - tsMillis) > input.replayWindowSec * 1000) return { valid: false };
  const expectedHmac = crypto
    .createHmac("sha256", input.secret)
    .update(`${providedTimestamp}.`)
    .update(input.rawBody)
    .digest("hex");
  const normalizedSignature = providedSignature.replace(/^sha256=/, "");
  const providedBuf = Buffer.from(normalizedSignature);
  const expectedBuf = Buffer.from(expectedHmac);
  const valid = providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
  return valid ? { valid: true, timestamp: providedTimestamp, expectedHmac } : { valid: false };
}

/** GitHub-style `X-Hub-Signature-256`: HMAC-SHA256 over the raw body alone, no timestamp. */
export function verifyGithubHmacSignature(input: {
  secret: string;
  rawBody: Buffer;
  signature: string | null | undefined;
}): boolean {
  const providedSignature = input.signature?.trim() ?? "";
  if (!providedSignature) return false;
  const expectedHmac = crypto.createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  const normalizedBuf = Buffer.from(providedSignature.replace(/^sha256=/, ""));
  const expectedBuf = Buffer.from(expectedHmac);
  return normalizedBuf.length === expectedBuf.length && crypto.timingSafeEqual(normalizedBuf, expectedBuf);
}
