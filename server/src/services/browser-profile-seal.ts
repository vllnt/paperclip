import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Raised for any seal failure. The message never includes key, state or AAD material. */
export class BrowserSealError extends Error {
  constructor() {
    super("Saved browser session could not be opened");
    this.name = "BrowserSealError";
  }
}

function decodeKey(key: string): Buffer {
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== KEY_BYTES) throw new BrowserSealError();
  return bytes;
}

/**
 * Creates a random per-profile data key.
 * @returns A base64 string holding 32 random bytes.
 */
export function generateProfileKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/**
 * Builds the authenticated data a sealed session is bound to, so a blob cannot
 * be moved to another company, another profile or an older generation.
 * @param companyId - Owning company.
 * @param profileId - Owning profile.
 * @param generation - Monotonic save counter of the profile.
 * @returns The AAD string.
 */
export function profileStateAad(companyId: string, profileId: string, generation: number): string {
  return `paperclip.browser-profile.${VERSION}|${companyId}|${profileId}|${generation}`;
}

/**
 * Encrypts a serialized browser session with AES-256-GCM.
 * @param key - Base64 data key from {@link generateProfileKey}.
 * @param aad - Value from {@link profileStateAad}.
 * @param plaintext - Serialized session.
 * @returns `v1.` followed by base64url of nonce, ciphertext and tag.
 */
export function sealProfileState(key: string, aad: string, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(key), nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const sealed = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
  return `${VERSION}.${sealed.toString("base64url")}`;
}

/**
 * Decrypts a value produced by {@link sealProfileState}.
 * @param key - Base64 data key.
 * @param aad - The AAD the blob must have been sealed with.
 * @param sealed - Stored value.
 * @returns The serialized session.
 * @throws {BrowserSealError} On a wrong key, wrong AAD, tampering or a malformed value.
 */
export function openProfileState(key: string, aad: string, sealed: string): string {
  try {
    const [version, body] = sealed.split(".");
    if (version !== VERSION || !body) throw new BrowserSealError();
    const bytes = Buffer.from(body, "base64url");
    if (bytes.length < NONCE_BYTES + TAG_BYTES) throw new BrowserSealError();
    const decipher = createDecipheriv("aes-256-gcm", decodeKey(key), bytes.subarray(0, NONCE_BYTES));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new BrowserSealError();
  }
}
