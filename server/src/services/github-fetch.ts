import { HttpError, unprocessable } from "../errors.js";
import { parseRemoteHttpEndpoint } from "./remote-http-endpoint-guard.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";

/** Exact origins (for example a GitHub Enterprise Server on an internal network) the operator allows over private ranges. */
const PRIVATE_ORIGINS_ENV = "PAPERCLIP_GITHUB_PRIVATE_ORIGINS";

/** Hosts GitHub serves itself: fetched directly, because they are fixed and public. */
const GITHUB_DOT_COM_FETCH_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "www.github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
]);

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

export function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

export function gitHubApiBase(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  const p = filePath.replace(/^\/+/, "");
  return isGitHubDotCom(hostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

function privateOriginAllowlist(): ReadonlySet<string> {
  return new Set(
    (process.env[PRIVATE_ORIGINS_ENV] ?? "").split(",").flatMap((entry) => {
      try {
        return [new URL(entry.trim()).origin];
      } catch {
        return [];
      }
    }),
  );
}

function unreachable(target: URL) {
  return unprocessable(
    `Could not connect to ${target.hostname} — ensure the URL points to a public GitHub or GitHub Enterprise instance`,
  );
}

function withoutCredentials(init: RequestInit | undefined): RequestInit | undefined {
  if (!init?.headers) return init;
  const headers = new Headers(init.headers);
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  return { ...init, headers };
}

/**
 * Fetch a user-influenced GitHub URL. The hostnames GitHub serves itself go
 * straight to `fetch`; every other host (GitHub Enterprise, a pasted skill URL)
 * goes through the remote-endpoint guard, which refuses loopback, private and
 * link-local targets, pins the DNS answer it checked and never follows a
 * redirect on its own. Redirects are followed here, up to a small limit, and
 * each hop passes the same guard again.
 */
export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  let target: URL;
  try {
    target = parseRemoteHttpEndpoint(url, (message) => new Error(message));
  } catch {
    throw unprocessable("Invalid URL — ensure it is an http(s) URL of a GitHub or GitHub Enterprise instance");
  }
  if (target.protocol === "https:" && !target.port && GITHUB_DOT_COM_FETCH_HOSTS.has(target.hostname.toLowerCase())) {
    try {
      return await fetch(target.href, init);
    } catch {
      throw unreachable(target);
    }
  }

  const privateOrigins = privateOriginAllowlist();
  let request = init;
  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await guardedRemoteHttpFetch(target, { ...request, redirect: "manual" }, {
        allowPrivateNetwork: privateOrigins.has(target.origin),
        error: () => unreachable(target),
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw unreachable(target);
    }
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (!location) return response;
    await response.body?.cancel().catch(() => {});
    if (redirects >= MAX_REDIRECTS) {
      throw unprocessable(`Too many redirects from ${target.hostname}`);
    }
    let next: URL;
    try {
      next = parseRemoteHttpEndpoint(new URL(location, target).href, (message) => new Error(message));
    } catch {
      throw unprocessable(`Invalid redirect from ${target.hostname}`);
    }
    if (next.origin !== target.origin) request = withoutCredentials(request);
    target = next;
  }
}
