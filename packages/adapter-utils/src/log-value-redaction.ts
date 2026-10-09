/**
 * One policy for the secrets that a run log must never keep, apart from the secrets that a key
 * name or a command line already give away. The env snapshot (`redactEnvForLogs`), the persisted
 * event payloads (`redactEventPayload`), the free text of events and the streamed stdout and stderr
 * (`redactSensitiveText`) all use these functions, so a rule changes in this file only.
 *
 * The policy regexes in `server/src/services/secrets.ts` and `heartbeat.ts` decide which bindings
 * the server accepts as plain text. They are a different rule and do not use this file.
 */

/** The marker that a log shows in place of a secret. */
export const REDACTED_LOG_VALUE = "***REDACTED***";

/** The start of every PEM block (`-----BEGIN <kind>-----`). */
export const PEM_BEGIN_MARKER = "-----BEGIN ";

const ENV_KEY_WORDS_RE = /key|token|secret|password|passwd|auth|cookie|bearer|credential|jwt/i;
const CREDENTIAL_KEY_NAME_RE = /dsn|passphrase|connection[-_]?string|(?:^|[_-])(?:pat|pem)(?:[_-]|$)/i;
const URL_USER_INFO_RE = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^\s/?#"']*)@/gi;
const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]+-----/g;
const PEM_END_RE = /-----END [A-Z0-9 ]+-----/g;
const MARKER_CARRY_CHARS = 64;
const MAX_OPEN_BLOCK_CHARS = 64 * 1024;

/**
 * Tells whether a name carries a credential without a sensitive word in it. `PAT` and `PEM` match
 * only as a whole `_` or `-` separated segment, so `PATH`, `PATTERN` and `PYTHONPATH` stay visible.
 * Field names in payloads use this test as well, because it holds no word that a payload field can
 * have for another reason, such as `key`.
 *
 * @param name - An env var name or a payload field name.
 * @returns True when the value under this name must be hidden.
 * @example
 * hasCredentialKeyName("SENTRY_DSN"); // true
 * hasCredentialKeyName("PYTHONPATH"); // false
 */
export function hasCredentialKeyName(name: string): boolean {
  return CREDENTIAL_KEY_NAME_RE.test(name);
}

/**
 * Tells whether the value of an env var must be hidden because of its name. This is the union of
 * the words in the two secret detectors in the server and the names in {@link hasCredentialKeyName}.
 *
 * @param name - An env var name.
 * @returns True when the logged value must be hidden.
 * @example
 * isSensitiveEnvKey("DATABASE_CONNECTION_STRING"); // true
 * isSensitiveEnvKey("NODE_OPTIONS"); // false
 */
export function isSensitiveEnvKey(name: string): boolean {
  return ENV_KEY_WORDS_RE.test(name) || hasCredentialKeyName(name);
}

/**
 * Masks the secret in the user info of each URL. A password is masked and its user name is kept.
 * User info without a colon is a token (`https://<token>@host`), so it is masked whole. A password
 * that holds an `@` is masked up to the last `@` of the user info.
 *
 * @param text - A value or a text that may hold URLs.
 * @returns The text with the secret part of each URL user info replaced by a fixed marker.
 * @example
 * maskUrlUserInfo("postgres://app:pw@db/app"); // "postgres://app:***REDACTED***@db/app"
 */
export function maskUrlUserInfo(text: string): string {
  if (!text.includes("://")) return text;
  return text.replace(URL_USER_INFO_RE, (_match: string, scheme: string, userInfo: string) => {
    const colon = userInfo.indexOf(":");
    const user = colon === -1 ? "" : userInfo.slice(0, colon + 1);
    return `${scheme}${user}${REDACTED_LOG_VALUE}@`;
  });
}

/** Redacts PEM blocks in text that arrives in chunks. See {@link createPemStreamRedactor}. */
export interface PemStreamRedactor {
  /**
   * @param chunk - The next piece of the stream.
   * @returns The chunk with each PEM block, or the part of it in this chunk, replaced by a marker.
   */
  redact(chunk: string): string;
}

/**
 * Creates a redactor for one stream. It replaces a PEM block, from its BEGIN marker to its END
 * marker, with one marker per chunk. A block can span chunks: after a BEGIN marker, each chunk is
 * redacted until the END marker. A marker that is split between two chunks is found too, because
 * the redactor keeps the tail of the last chunk. The first half of a split marker is not secret
 * and stays in the earlier chunk. A block that stays open for more than 64 KiB is a stray marker,
 * so the redactor then stops and the text shows again. Use one redactor for each stream of a run.
 *
 * @returns A redactor that holds the state of one stream.
 * @example
 * const redactor = createPemStreamRedactor();
 * redactor.redact("-----BEGIN CERTIFICATE-----\n"); // "***REDACTED***"
 * redactor.redact("MIIEvQ...\n"); // "***REDACTED***"
 * redactor.redact("-----END CERTIFICATE-----\ndone\n"); // "***REDACTED***\ndone\n"
 */
export function createPemStreamRedactor(): PemStreamRedactor {
  let open = false;
  let openChars = 0;
  let carry = "";

  const redact = (chunk: string): string => {
    if (open && openChars >= MAX_OPEN_BLOCK_CHARS) {
      open = false;
      openChars = 0;
      carry = "";
    }
    const text = carry + chunk;
    const emitted = carry.length;
    if (!open && !text.includes("-----")) {
      carry = text.slice(-MARKER_CARRY_CHARS);
      return chunk;
    }

    const parts: string[] = [];
    const pushRaw = (from: number, to: number): void => {
      const start = Math.max(from, emitted);
      if (to > start) parts.push(text.slice(start, to));
    };
    let pos = 0;
    let handledThrough = 0;
    while (pos < text.length) {
      if (open) {
        PEM_END_RE.lastIndex = pos;
        const end = PEM_END_RE.exec(text);
        if (end === null) {
          if (text.length > emitted) parts.push(REDACTED_LOG_VALUE);
          openChars += Math.max(0, text.length - emitted);
          pos = text.length;
        } else {
          const endPos = end.index + end[0].length;
          if (endPos > emitted) parts.push(REDACTED_LOG_VALUE);
          open = false;
          openChars = 0;
          handledThrough = endPos;
          pos = endPos;
        }
      } else {
        PEM_BEGIN_RE.lastIndex = pos;
        const begin = PEM_BEGIN_RE.exec(text);
        if (begin === null) {
          pushRaw(pos, text.length);
          pos = text.length;
        } else {
          pushRaw(pos, begin.index);
          open = true;
          openChars = 0;
          pos = begin.index + begin[0].length;
          handledThrough = pos;
        }
      }
    }
    carry = text.slice(Math.max(text.length - MARKER_CARRY_CHARS, handledThrough));
    return parts.join("");
  };

  return { redact };
}

/**
 * Replaces each PEM block in a text with a marker. A block that has no END marker is redacted to
 * the end of the text.
 *
 * @param text - A value or a text that may hold PEM blocks.
 * @returns The text without PEM blocks.
 * @example
 * maskPemBlocks("x: -----BEGIN CERTIFICATE-----\nMIIE\n-----END CERTIFICATE----- ok"); // "x: ***REDACTED*** ok"
 */
export function maskPemBlocks(text: string): string {
  if (!text.includes("-----")) return text;
  return createPemStreamRedactor().redact(text);
}

/**
 * Masks the secrets that a text carries whatever its field or key is called: PEM blocks and the
 * secret part of URL user info.
 *
 * @param text - A value or a text.
 * @returns The text with these secrets replaced by a fixed marker.
 */
export function redactSecretShapedText(text: string): string {
  return maskUrlUserInfo(maskPemBlocks(text));
}
