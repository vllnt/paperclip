import { createHmac, timingSafeEqual } from "node:crypto";

export function header(headers: Record<string, string | string[]>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
  return Array.isArray(entry) ? entry[0] : entry;
}

/** Verify GitHub's X-Hub-Signature-256 against the exact raw request body. */
export function verifyGitHubSignature(rawBody: string, signature: string | undefined, secret: string | undefined): boolean {
  if (!secret) return false;
  if (!signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
