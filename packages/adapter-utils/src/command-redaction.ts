export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***";

// Public Executor helper addresses retained for callers of this predicate.
// Dotted addresses alone do not meet the JWT credential heuristic.
const PUBLIC_EXECUTOR_TOOL_SELECTORS = new Set([
  "executor.coreTools.integrations.list",
  "executor.coreTools.connections.list",
  "executor.coreTools.policies.list",
]);
export function isPublicExecutorToolSelector(value: string): boolean {
  return PUBLIC_EXECUTOR_TOOL_SELECTORS.has(value);
}

const SECRET_NAME_PATTERN = String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization(?:[-_]?code)?|bearer|secrets?|passwd|passwords?|credentials?|jwt|private[-_]?key|cookie|connectionstring)(?:[-_]?(?:value|header|prod(?:uction)?|dev(?:elopment)?|test|staging|primary|secondary))*`;

const COMMAND_CLI_SECRET_OPTION_RE = new RegExp(
  String.raw`(\B-{1,2}${SECRET_NAME_PATTERN}(?:\s+|=)(["']?))[^\s"'` +
    "`" +
    String.raw`]+(\2)`,
  "gi",
);
const COMMAND_ENV_SECRET_ASSIGNMENT_RE = new RegExp(
  String.raw`(\b${SECRET_NAME_PATTERN}\s*=\s*)(?:(\\["'])([\s\S]*?)\2|(["'])([^"'` +
    "`" +
    String.raw`\r\n]*)\4|([^\s"'` +
    "`" +
    String.raw`]+))`,
  "gi",
);
const COMMAND_AUTHORIZATION_BEARER_RE =
  /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi;
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const COMMAND_JWT_RE =
  /\b[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){2}(?:\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})?\b/g;
/** Recognize encoded JSON headers, without treating dotted identifiers as tokens. */
export function looksLikeCredentialJwt(value: string): boolean {
  const segments = value.split(".");
  if (![3, 5].includes(segments.length) || segments.some((part) => !/^[A-Za-z0-9_-]{8,}$/.test(part))) return false;
  if (segments[0].startsWith("eyJ")) return true;
  try {
    const header = JSON.parse(atob(segments[0].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof header === "object" && header !== null && typeof header.alg === "string";
  } catch {
    return false;
  }
}

const COMMAND_SECRET_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
] as const;

function maybeContainsSecretText(command: string) {
  const lower = command.toLowerCase();
  return (
    COMMAND_SECRET_HINTS.some((hint) => lower.includes(hint)) ||
    command.includes(".")
  );
}

export function redactCommandText(
  command: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  if (!maybeContainsSecretText(command)) return command;
  return command
    .replace(COMMAND_AUTHORIZATION_BEARER_RE, `$1${redactedValue}`)
    .replace(COMMAND_CLI_SECRET_OPTION_RE, `$1${redactedValue}$3`)
    .replace(
      COMMAND_ENV_SECRET_ASSIGNMENT_RE,
      (
        _match,
        prefix: string,
        escapedQuote: string | undefined,
        _escapedValue: string | undefined,
        rawQuote: string | undefined,
      ) => {
        const quote = escapedQuote ?? rawQuote;
        return quote
          ? `${prefix}${quote}${redactedValue}${quote}`
          : `${prefix}${redactedValue}`;
      },
    )
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    .replace(COMMAND_JWT_RE, (match) => looksLikeCredentialJwt(match) ? redactedValue : match);
}

// A JSON secret field is a key/value pair such as `"token":"opaque-value"`. The
// command redaction handles shell `KEY=value` syntax only. A sandbox diagnostic
// can also carry a serialized JSON error, so the sanitizer must redact the JSON
// form too. The value body consumes JSON escape sequences. An escaped quote
// (`\"`) inside the value does not end the match early.
const JSON_SECRET_FIELD_RE = new RegExp(
  String.raw`("(?:${SECRET_NAME_PATTERN})"\s*:\s*")(?:\\[\s\S]|[^"\\])*(")`,
  "gi",
);
// An escaped JSON secret field is the same pair inside a JSON string. The double
// quote appears as `\"` and a backslash appears as `\\`. The value body
// consumes the doubled escape sequences. An escaped quote inside the value does
// not end the match early. The value ends at the next unescaped `\"`.
const JSON_ESCAPED_SECRET_FIELD_RE = new RegExp(
  String.raw`(\\"(?:${SECRET_NAME_PATTERN})\\"\s*:\s*\\")(?:\\\\\\\\|\\\\\\"|\\\\[\s\S]|[^\\"])*(\\")`,
  "gi",
);

// An HTTP-header-style secret with an unquoted value, as a CLI prints it to
// stderr: `x-api-key: <value>`, `x-auth-key=<value>`, `Authorization: token
// <value>`. The name must start a word and either be an `x-…-key` header or
// end in a secret word; it is narrower than the field-name pattern, so
// plain-text labels such as `Login URL:` stay visible. An optional auth scheme
// word is redacted with the value, so `token <value>` never keeps the value
// visible.
const HEADER_SECRET_NAME_PATTERN = String.raw`(?:x-[A-Za-z0-9-]+-key|[A-Za-z0-9_-]*(?:api[-_]?key|token|secrets?|password|passwd|credentials?|authorization|private[-_]?key|jwt))`;
const HEADER_AUTH_SCHEME_PATTERN = String.raw`(?:basic|bearer|digest|token)[ \t]+`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface HeaderSecretRules {
  header: RegExp;
  cookie: RegExp;
}

// One pair of rules per marker. The marker is part of the rules: a value that
// an earlier rule already masked, with or without its auth scheme word, is left
// alone, so the rules are idempotent whatever marker the caller picks.
const headerSecretRulesByMarker = new Map<string, HeaderSecretRules>();

function headerSecretRules(redactedValue: string): HeaderSecretRules {
  const cached = headerSecretRulesByMarker.get(redactedValue);
  if (cached) return cached;
  const marker = escapeRegExp(redactedValue);
  const rules: HeaderSecretRules = {
    header: new RegExp(
      String.raw`((?:^|[\s{,;(])${HEADER_SECRET_NAME_PATTERN}[ \t]*[:=][ \t]*)` +
        String.raw`(?!["'\\]|(?:${HEADER_AUTH_SCHEME_PATTERN})?${marker})(?:${HEADER_AUTH_SCHEME_PATTERN})?[^\s"'` +
        "`" +
        String.raw`,;}\])]+`,
      "gim",
    ),
    // A cookie header holds several `name=value` pairs split by `;` and spaces
    // (`Cookie: a=S1; b=S2`, `Set-Cookie: id=S1; Path=/`), so the rule above would
    // stop after the first pair. A cookie value is redacted to the end of the
    // line. It also matches a value an earlier rule already masked, so a masked
    // first pair never hides the pairs after it. The replacement equals the match
    // for an already redacted line, so the rule is idempotent.
    cookie: new RegExp(
      String.raw`((?:^|[\s{,;(])[A-Za-z0-9_-]*cookie[ \t]*[:=][ \t]*)(?!["'\\])[^\r\n]+`,
      "gim",
    ),
  };
  headerSecretRulesByMarker.set(redactedValue, rules);
  return rules;
}

/**
 * Redact the secrets that HTTP headers carry in plain text: `x-api-key: <value>`,
 * `x-auth-key=<value>`, `Authorization: Basic <value>`, and the whole value of a `Cookie` or
 * `Set-Cookie` header. A diagnostic that quotes a CLI's stderr can hold these forms, and no
 * shell-style rule recognizes them. Redaction needs the header name next to its value, so a caller
 * that cuts a text must run this before the cut.
 *
 * @param text - A diagnostic text.
 * @param redactedValue - The marker that replaces each secret value.
 * @returns The text with each header secret replaced by the marker.
 * @example
 * redactHeaderSecretText("x-api-key: abc123"); // "x-api-key: ***REDACTED***"
 */
export function redactHeaderSecretText(
  text: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  const rules = headerSecretRules(redactedValue);
  return text
    .replace(rules.cookie, `$1${redactedValue}`)
    .replace(rules.header, `$1${redactedValue}`);
}

/**
 * Redact secrets from an untrusted diagnostic string.
 *
 * The function first runs the command redaction. The command redaction handles
 * shell `KEY=value` assignments, CLI secret options, bearer headers, and common
 * token shapes. The function then redacts JSON and escaped-JSON secret fields,
 * because a sandbox diagnostic can carry a serialized JSON error such as
 * `{"token":"opaque-value"}`. The function last redacts header forms such as
 * `x-api-key: <value>` and `Cookie: <pairs>` (see {@link redactHeaderSecretText}). The caller must
 * still bound the length after this step, and it must bound it after this function, never before,
 * because a cut can separate a secret's name from its value.
 */
export function redactDiagnosticText(
  text: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  return redactHeaderSecretText(
    redactCommandText(text, redactedValue)
      .replace(JSON_ESCAPED_SECRET_FIELD_RE, `$1${redactedValue}$2`)
      .replace(JSON_SECRET_FIELD_RE, `$1${redactedValue}$2`),
    redactedValue,
  );
}
