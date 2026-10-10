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

/**
 * `auth` matches only as a whole segment, so `AUTH_HEADER` and `BASIC_AUTH` are hidden and
 * `AUTHORITY`, `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` stay visible. The full words
 * `authorization` and `authentication` match anywhere.
 */
const ENV_KEY_WORDS_RE =
  /key|token|secret|password|passwd|authorization|authentication|(?:^|[_-])auth(?:[_-]|$)|cookie|bearer|credential|jwt/i;
const CREDENTIAL_KEY_NAME_RE = /dsn|passphrase|connection[-_]?string|(?:^|[_-])(?:pat|pem)(?:[_-]|$)/i;
const URL_USER_INFO_RE = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^\s/?#"']*)@/gi;
const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]+-----/g;
const PEM_END_RE = /-----END [A-Z0-9 ]+-----/g;
const MARKER_CARRY_CHARS = 64;
/** The most that a stream holds back, so a token that spans two chunks is redacted whole. */
export const DEFAULT_STREAM_TAIL_CHARS = 8 * 1024;

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
   * @returns The chunk with each PEM block replaced by one marker. A block that spans chunks gives
   * the marker once, in the chunk that holds its BEGIN marker, and nothing in the chunks after it.
   */
  redact(chunk: string): string;
}

/**
 * Creates a redactor for one stream. It replaces a PEM block, from its BEGIN marker to its END
 * marker, with one marker. A block can span any number of chunks and any size: after a BEGIN marker
 * the redactor drops everything until the END marker. It holds a state flag and the last 64
 * characters of the stream (to find a marker that is split between two chunks), never the block,
 * so its memory is bounded. The first half of a split BEGIN marker is not secret and stays in the
 * earlier chunk. If the stream ends inside a block, the marker was already given and the rest is
 * dropped. The cost is that a stray BEGIN marker with no END hides the rest of that stream. Use one
 * redactor for each stream of a run.
 *
 * @returns A redactor that holds the state of one stream.
 * @example
 * const redactor = createPemStreamRedactor();
 * redactor.redact("-----BEGIN CERTIFICATE-----\n"); // "***REDACTED***"
 * redactor.redact("MIIEvQ...\n"); // ""
 * redactor.redact("-----END CERTIFICATE-----\ndone\n"); // "\ndone\n"
 */
export function createPemStreamRedactor(): PemStreamRedactor {
  let open = false;
  let carry = "";

  const redact = (chunk: string): string => {
    const text = carry + chunk;
    const handled = carry.length;
    if (!open && !text.includes("-----")) {
      carry = text.slice(-MARKER_CARRY_CHARS);
      return chunk;
    }

    const parts: string[] = [];
    let pos = 0;
    let consumedThrough = 0;
    while (pos < text.length) {
      if (open) {
        PEM_END_RE.lastIndex = pos;
        const end = PEM_END_RE.exec(text);
        if (end === null) {
          pos = text.length;
        } else {
          open = false;
          pos = end.index + end[0].length;
          consumedThrough = pos;
        }
      } else {
        PEM_BEGIN_RE.lastIndex = pos;
        const begin = PEM_BEGIN_RE.exec(text);
        const rawEnd = begin === null ? text.length : begin.index;
        if (rawEnd > Math.max(pos, handled)) parts.push(text.slice(Math.max(pos, handled), rawEnd));
        if (begin === null) {
          pos = text.length;
        } else {
          parts.push(REDACTED_LOG_VALUE);
          open = true;
          pos = begin.index + begin[0].length;
          consumedThrough = pos;
        }
      }
    }
    carry = text.slice(Math.max(text.length - MARKER_CARRY_CHARS, consumedThrough));
    return parts.join("");
  };

  return { redact };
}

/** Holds back the end of each chunk of a stream. See {@link createStreamTailCarry}. */
export interface StreamTailCarry {
  /**
   * @param chunk - The next piece of the stream.
   * @returns The text that is ready to be redacted and written: the held tail and the chunk, up to
   * the last whitespace. The rest is held for the next call. If the held part would pass the
   * bound, nothing is held and all the text is returned, so the caller redacts it before it
   * writes it.
   */
  push(chunk: string): string;
  /** @returns The held tail, at the end of the stream. The caller redacts it before it writes it. */
  flush(): string;
}

/**
 * Creates the carry of one stream. A secret in a token (a URL with a password, for example) can
 * be split between two chunks. If the redactor saw each chunk alone, it would find neither half.
 * The carry holds back everything after the last whitespace of a chunk, joins it to the next chunk
 * and releases text only up to a whitespace, so each token is whole when the caller redacts it.
 * The hold is bounded: a token longer than the bound is released whole, and the caller redacts it
 * like any other text, so the bound never turns into raw output. Use one carry for each stream of
 * a run, and call `flush` when the stream ends.
 *
 * @param maxTailChars - The most that the carry holds back.
 * @returns A carry that holds the tail of one stream.
 * @example
 * const carry = createStreamTailCarry();
 * carry.push("go https://u:pw@h"); // "go "
 * carry.push("/x now\n"); // "https://u:pw@h/x now\n"
 */
export function createStreamTailCarry(maxTailChars: number = DEFAULT_STREAM_TAIL_CHARS): StreamTailCarry {
  let tail = "";

  const push = (chunk: string): string => {
    const text = tail + chunk;
    const floor = Math.max(0, text.length - maxTailChars - 1);
    let split = -1;
    for (let i = text.length - 1; i >= floor; i -= 1) {
      if (/\s/.test(text[i] ?? "")) {
        split = i + 1;
        break;
      }
    }
    if (split === -1) {
      if (text.length <= maxTailChars) {
        tail = text;
        return "";
      }
      tail = "";
      return text;
    }
    tail = text.slice(split);
    return text.slice(0, split);
  };

  const flush = (): string => {
    const rest = tail;
    tail = "";
    return rest;
  };

  return { push, flush };
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
