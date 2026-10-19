import {
  BROWSER_PROFILE_MAX_DOMAINS,
  BROWSER_PROFILE_NAME_MAX,
  browserAllowedDomainSchema,
  browserProfileNameSchema,
  type BrowserProfile,
} from "@paperclipai/shared";

export const BROWSER_DOMAIN_HINT =
  "Use a host such as app.example.com or *.example.com";

export interface BrowserProfileFormValue {
  name: string;
  allowedDomains: string[];
}

export type BrowserProfileFormResult =
  | { ok: true; value: BrowserProfileFormValue }
  | { ok: false; error: string };

export interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PageSize {
  width: number;
  height: number;
}

/**
 * Splits a one-host-per-line list into unique, lowercase host patterns.
 * Commas and spaces also separate entries so a pasted list still works.
 */
export function parseDomainLines(text: string): string[] {
  const hosts = text
    .split(/[\s,]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  return [...new Set(hosts)];
}

/**
 * Validates the create/edit form with the same schemas the server uses, so a
 * bad value is caught before the request and reads as plain language.
 */
export function validateBrowserProfileForm(
  name: string,
  domainText: string,
): BrowserProfileFormResult {
  const parsedName = browserProfileNameSchema.safeParse(name);
  if (!parsedName.success) {
    return {
      ok: false,
      error:
        name.trim().length === 0
          ? "Enter a name for this profile."
          : `Use a name of ${BROWSER_PROFILE_NAME_MAX} characters or fewer.`,
    };
  }
  const allowedDomains = parseDomainLines(domainText);
  if (allowedDomains.length > BROWSER_PROFILE_MAX_DOMAINS) {
    return {
      ok: false,
      error: `Allow at most ${BROWSER_PROFILE_MAX_DOMAINS} domains per profile.`,
    };
  }
  for (const domain of allowedDomains) {
    if (!browserAllowedDomainSchema.safeParse(domain).success) {
      return {
        ok: false,
        error: `"${domain}" is not a valid host. ${BROWSER_DOMAIN_HINT}.`,
      };
    }
  }
  return { ok: true, value: { name: parsedName.data, allowedDomains } };
}

/**
 * Maps a pointer position on the displayed frame to page CSS pixels. The frame
 * is shown at an arbitrary size, so each axis is scaled by page size over
 * displayed size. Returns null while the image has no layout box yet.
 */
export function scaleFrameClick(
  point: { clientX: number; clientY: number },
  rect: FrameRect,
  page: PageSize,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = Math.round((point.clientX - rect.left) * (page.width / rect.width));
  const y = Math.round((point.clientY - rect.top) * (page.height / rect.height));
  return {
    x: Math.min(Math.max(x, 0), Math.max(page.width - 1, 0)),
    y: Math.min(Math.max(y, 0), Math.max(page.height - 1, 0)),
  };
}

/**
 * Turns what a person typed into an address the server accepts: adds https://
 * when no scheme is present and only allows http(s). Returns null if unusable.
 */
export function normalizeNavigateUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** First concrete allowed host as a start address; wildcard entries name no single host. */
export function defaultSignInUrl(
  profile: Pick<BrowserProfile, "allowedDomains">,
): string {
  const host = profile.allowedDomains.find((domain) => !domain.startsWith("*."));
  return host ? `https://${host}/` : "";
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
