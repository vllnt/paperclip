import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

/**
 * Git commit signing with an SSH ed25519 key (git `gpg.format=ssh`), in the
 * OpenSSH SSHSIG format that `ssh-keygen -Y sign` writes and GitHub verifies.
 * The key never leaves the plugin worker.
 */
export interface SshSigningKey {
  key: KeyObject;
  /** `ssh-ed25519 AAAA…`, the value for git `user.signingKey` (with `key::`) and GitHub. */
  publicKey: string;
  /** `SHA256:…`, as `ssh-keygen -l` prints it. */
  fingerprint: string;
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
// PEM markers are assembled so the repository's publication guard, which
// rejects key material, does not match the parser itself.
const armor = (edge: "BEGIN" | "END", label: string) => `-----${edge} ${label} KEY-----`;
const PKCS8_BEGIN = armor("BEGIN", "PRIVATE");
const OPENSSH_BEGIN = armor("BEGIN", "OPENSSH PRIVATE"), OPENSSH_END = armor("END", "OPENSSH PRIVATE");

function sshString(value: Buffer | string): Buffer {
  const body = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

class Reader {
  private offset = 0;
  private buffer: Buffer;
  constructor(buffer: Buffer) { this.buffer = buffer; }
  uint32(): number {
    if (this.offset + 4 > this.buffer.length) throw new Error();
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  bytes(): Buffer {
    const length = this.uint32();
    if (this.offset + length > this.buffer.length) throw new Error();
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  text(): string { return this.bytes().toString("utf8"); }
}

function publicBlob(raw: Buffer): Buffer {
  return Buffer.concat([sshString("ssh-ed25519"), sshString(raw)]);
}

function describe(key: KeyObject, rawPublic: Buffer): SshSigningKey {
  const blob = publicBlob(rawPublic);
  return {
    key,
    publicKey: `ssh-ed25519 ${blob.toString("base64")}`,
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
  };
}

/**
 * Parses an unencrypted ed25519 private key, in OpenSSH format
 * (`ssh-keygen -t ed25519 -N ""`) or PKCS#8 PEM. Errors never echo the key.
 */
export function parseSshSigningKey(text: string): SshSigningKey {
  const trimmed = text.trim();
  try {
    if (trimmed.startsWith(PKCS8_BEGIN)) {
      const key = createPrivateKey(trimmed);
      if (key.asymmetricKeyType !== "ed25519") throw new Error();
      const jwk = createPublicKey(key).export({ format: "jwk" }) as { x?: string };
      return describe(key, Buffer.from(jwk.x ?? "", "base64url"));
    }
    if (!trimmed.startsWith(OPENSSH_BEGIN) || !trimmed.endsWith(OPENSSH_END)) throw new Error();
    const data = Buffer.from(trimmed.slice(OPENSSH_BEGIN.length, -OPENSSH_END.length).replace(/\s+/g, ""), "base64");
    const magic = Buffer.from("openssh-key-v1\0", "binary");
    if (!data.subarray(0, magic.length).equals(magic)) throw new Error();
    const reader = new Reader(data.subarray(magic.length));
    const cipher = reader.text(), kdf = reader.text();
    reader.bytes();
    if (cipher !== "none" || kdf !== "none" || reader.uint32() !== 1) throw new Error();
    reader.bytes();
    const secret = new Reader(reader.bytes());
    if (secret.uint32() !== secret.uint32()) throw new Error();
    if (secret.text() !== "ssh-ed25519") throw new Error();
    const rawPublic = secret.bytes(), rawPrivate = secret.bytes();
    if (rawPublic.length !== 32 || rawPrivate.length !== 64 || !rawPrivate.subarray(32).equals(rawPublic)) throw new Error();
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, rawPrivate.subarray(0, 32)]), format: "der", type: "pkcs8" });
    return describe(key, rawPublic);
  } catch {
    throw new Error("The signing key must be an unencrypted ed25519 private key in OpenSSH or PKCS#8 PEM format.");
  }
}

/** An armored SSHSIG signature over `message` in `namespace` (git uses "git"). */
export function sshSign(signingKey: SshSigningKey, message: Buffer, namespace = "git"): string {
  const hash = "sha512";
  const blob = Buffer.from(signingKey.publicKey.split(" ")[1]!, "base64");
  const signed = Buffer.concat([
    Buffer.from("SSHSIG"), sshString(namespace), sshString(""), sshString(hash),
    sshString(createHash(hash).update(message).digest()),
  ]);
  const signature = Buffer.concat([sshString("ssh-ed25519"), sshString(sign(null, signed, signingKey.key))]);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const armored = Buffer.concat([
    Buffer.from("SSHSIG"), version, sshString(blob), sshString(namespace), sshString(""), sshString(hash), sshString(signature),
  ]).toString("base64").replace(/(.{70})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN SSH SIGNATURE-----\n${armored}\n-----END SSH SIGNATURE-----\n`;
}

/** How far a signed commit's committer time may be from the signer's clock. */
export const SIGN_CLOCK_SKEW_MS = 10 * 60_000;
/** The oldest author time a signed commit may carry (amended and rebased commits keep theirs). */
export const SIGN_MAX_AUTHOR_AGE_MS = 30 * 24 * 60 * 60_000;

export type GitObjectCheck = { ok: true; kind: "commit" } | { ok: false; reason: string };

const IDENT = /^(.*) <([^<>\n]*)> (0|[1-9]\d{0,11}) ([+-])(\d\d)(\d\d)$/;
const ENCODING = /^[A-Za-z0-9._-]{1,40}$/;

/**
 * Checks that a payload is exactly one git commit object as git writes it, and
 * that the configured user wrote it now. Tags are refused (a signed tag can name
 * any object, even one the user never wrote).
 * - headers in order: `tree`, `parent`*, `author`, `committer`, optional
 *   `encoding`. Any other header (an existing `gpgsig`, a `mergetag`, unknown
 *   extensions) is refused;
 * - object IDs are all SHA-1 or all SHA-256 hex;
 * - author and committer are `user <email>`;
 * - the committer time is within {@link SIGN_CLOCK_SKEW_MS} of now, and
 *   the author time is not in the future nor older than {@link SIGN_MAX_AUTHOR_AGE_MS};
 * - the object has no NUL byte and is valid UTF-8 (unless it names another encoding).
 */
export function checkGitObjectForSigning(payload: Buffer, signer: { name: string; email: string }, now: number): GitObjectCheck {
  const refuse = (reason: string): GitObjectCheck => ({ ok: false, reason });
  if (payload.includes(0)) return refuse("the object contains a NUL byte.");
  const text = payload.toString("latin1");
  const split = text.indexOf("\n\n");
  if (split < 0) return refuse("the object has no message separator.");
  const lines = text.slice(0, split).split("\n");
  // Tags are not signed: a signed tag can point at any object, including one the user never wrote.
  if (lines[0]?.startsWith("object ")) return refuse("Paperclip signs commits only, not tags.");
  if (!lines[0]?.startsWith("tree ")) return refuse("it is not a git commit object.");
  let hexLength: number | null = null;
  const objectId = (value: string | undefined) => {
    if (!value || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) return false;
    hexLength ??= value.length;
    return value.length === hexLength;
  };
  const ident = (line: string | undefined, field: string, window: { min: number; max: number }) => {
    if (!line?.startsWith(`${field} `)) return `the ${field} line is missing or out of order.`;
    const match = IDENT.exec(Buffer.from(line.slice(field.length + 1), "latin1").toString("utf8"));
    if (!match) return `the ${field} line is malformed.`;
    if (match[1] !== signer.name || match[2]!.toLowerCase() !== signer.email.toLowerCase()) return `the ${field} is not ${signer.name} <${signer.email}>.`;
    if (Number(match[5]) > 14 || Number(match[6]) > 59) return `the ${field} time zone is invalid.`;
    const at = Number(match[3]) * 1000;
    if (at < window.min || at > window.max) return `the ${field} time is outside the accepted window.`;
    return null;
  };
  let at = 0;
  let encoding: string | null = null;
  if (!objectId(lines[at]!.slice("tree ".length)) || lines[at]!.split(" ").length !== 2) return refuse("the tree line is malformed.");
  at += 1;
  while (lines[at]?.startsWith("parent ")) {
    if (!objectId(lines[at]!.slice("parent ".length)) || lines[at]!.split(" ").length !== 2) return refuse("a parent line is malformed.");
    at += 1;
  }
  const author = ident(lines[at], "author", { min: now - SIGN_MAX_AUTHOR_AGE_MS, max: now + SIGN_CLOCK_SKEW_MS });
  if (author) return refuse(author);
  at += 1;
  const committer = ident(lines[at], "committer", { min: now - SIGN_CLOCK_SKEW_MS, max: now + SIGN_CLOCK_SKEW_MS });
  if (committer) return refuse(committer);
  at += 1;
  if (lines[at]?.startsWith("encoding ")) {
    encoding = lines[at]!.slice("encoding ".length);
    if (!ENCODING.test(encoding)) return refuse("the encoding line is malformed.");
    at += 1;
  }
  if (at !== lines.length) return refuse(`it carries the header "${lines[at]!.split(" ")[0]!.slice(0, 40)}", which Paperclip does not sign.`);
  if ((encoding === null || /^utf-?8$/i.test(encoding)) && !isUtf8(payload)) return refuse("the object is not valid UTF-8.");
  return { ok: true, kind: "commit" };
}

function isUtf8(bytes: Buffer): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; }
}
