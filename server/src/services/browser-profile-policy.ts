import { isIP } from "node:net";

const MAX_SNAPSHOT_CHARS = 20_000;

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

/**
 * Tests a host against one allowlist pattern.
 * @param host - Lowercase host without port.
 * @param pattern - `app.example.com`, or `*.example.com` for subdomains only.
 * @returns True when the host matches.
 */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return host === pattern;
}

/**
 * Decides whether an agent may navigate a top-level page to a URL.
 * Only https on the default port, no credentials in the URL, no IP literals
 * and no hosts outside the profile's allowed domains. An empty list allows nothing.
 * @param rawUrl - Requested URL.
 * @param allowedDomains - The profile's host patterns.
 * @returns True when the navigation is permitted.
 */
export function isAgentNavigationAllowed(rawUrl: string, allowedDomains: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port !== "" && url.port !== "443") return false;
  const host = normalizeHost(url.hostname.replace(/^\[|\]$/g, ""));
  if (!host || isIP(host) !== 0 || host === "localhost" || host.endsWith(".localhost")) return false;
  return allowedDomains.some((pattern) => hostMatchesPattern(host, pattern));
}

/**
 * Validates a URL a board user types during sign-in. Identity providers need
 * hosts outside the agent allowlist, so only the scheme and credentials are checked.
 * @param rawUrl - Requested URL.
 * @returns True for an https URL without embedded credentials.
 */
export function isSignInNavigationAllowed(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Reduces a URL to host and path for audit records and tool results.
 * Query strings and fragments are dropped because OAuth callbacks carry tokens there.
 * @param rawUrl - Any URL.
 * @returns `host/path`, or `invalid` when the URL does not parse.
 */
export function auditUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    return "invalid";
  }
}

/**
 * Prepares a page snapshot for an agent: strips query strings and fragments
 * from link targets and bounds the length.
 * @param snapshot - Accessibility snapshot text.
 * @returns Text safe to return to an agent.
 */
export function redactSnapshot(snapshot: string): string {
  const stripped = snapshot.replace(/(\/url:\s*"?https?:\/\/[^\s"?#]+)[?#][^\s"]*/g, "$1");
  if (stripped.length <= MAX_SNAPSHOT_CHARS) return stripped;
  return `${stripped.slice(0, MAX_SNAPSHOT_CHARS)}\n[snapshot truncated]`;
}
