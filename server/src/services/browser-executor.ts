import { isIP } from "node:net";
import type { Browser, BrowserContext, Locator, Page, Request } from "playwright-core";
import type { BrowserKey } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { isPrivateOrReservedIp } from "./remote-http-endpoint-guard.js";
import { isAgentNavigationAllowed } from "./browser-profile-policy.js";

const VIEWPORT = { width: 1280, height: 800 } as const;
const ACTION_TIMEOUT_MS = 8_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const SETTLE_TIMEOUT_MS = 3_000;
const LIVE_PAGE_LIMIT = 4;
const EXECUTABLE_ENV = "PAPERCLIP_BROWSER_EXECUTABLE_PATH";
const MAX_FIELD_CHECKS = 60;
const TEXTBOX_WITH_VALUE = /^(\s*- (?:textbox|searchbox)\b[^\n]*?\[ref=(e\d+)\])(: .*)$/;

export interface BrowserTabPolicy {
  /** When set, top-level navigations must match these host patterns. */
  agentAllowedDomains: readonly string[] | null;
}

export interface BrowserPageState {
  url: string;
  title: string;
}

/** One page of a live browser. Nothing here can read or export cookies or storage. */
export interface BrowserTab {
  navigate(url: string): Promise<BrowserPageState>;
  snapshot(): Promise<string>;
  state(): Promise<BrowserPageState>;
  click(ref: string): Promise<void>;
  fill(ref: string, value: string): Promise<void>;
  press(key: BrowserKey): Promise<void>;
  scroll(deltaY: number): Promise<void>;
  wait(ms: number): Promise<void>;
  pointerClick(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

/** A running browser for one profile. */
export interface BrowserRuntime {
  openTab(key: string, policy: BrowserTabPolicy): Promise<BrowserTab>;
  closeTab(key: string): Promise<void>;
  tabCount(): number;
  /** Serialized session for sealing. Only the server-side store may call this. */
  exportSession(): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserExecutor {
  readonly available: boolean;
  readonly unavailableReason: string | null;
  launch(session: string | null): Promise<BrowserRuntime>;
}

export class BrowserActionError extends Error {
  constructor(
    readonly code:
      | "element_not_found"
      | "sensitive_field"
      | "navigation_blocked"
      | "too_many_tabs"
      | "action_failed",
    message: string,
  ) {
    super(message);
    this.name = "BrowserActionError";
  }
}

function literalHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isInternalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isIP(host) !== 0 && isPrivateOrReservedIp(host);
}

async function resolvePolicy(
  page: Page,
  policies: WeakMap<Page, BrowserTabPolicy>,
): Promise<BrowserTabPolicy> {
  const own = policies.get(page);
  if (own) return own;
  const opener = await page.opener();
  if (opener) return resolvePolicy(opener, policies);
  return { agentAllowedDomains: [] };
}

async function shouldAbort(request: Request, policies: WeakMap<Page, BrowserTabPolicy>): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(request.url());
  } catch {
    return true;
  }
  const web = url.protocol === "https:" || url.protocol === "http:";
  if (web && isInternalHost(literalHost(url))) return true;
  if (request.isNavigationRequest() && !request.frame().parentFrame()) {
    const policy = await resolvePolicy(request.frame().page(), policies);
    if (policy.agentAllowedDomains !== null) {
      return url.href !== "about:blank" && !isAgentNavigationAllowed(request.url(), policy.agentAllowedDomains);
    }
  }
  if (web) return false;
  return url.protocol !== "data:" && url.protocol !== "blob:" && url.protocol !== "about:";
}

class PlaywrightTab implements BrowserTab {
  constructor(private readonly page: Page) {}

  private target(ref: string): Locator {
    return this.page.locator(`aria-ref=${ref}`);
  }

  private async settle(): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded", { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
  }

  async state(): Promise<BrowserPageState> {
    return { url: this.page.url(), title: await this.page.title().catch(() => "") };
  }

  async navigate(url: string): Promise<BrowserPageState> {
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    } catch {
      throw new BrowserActionError("navigation_blocked", "The page could not be opened");
    }
    return this.state();
  }

  /** True for password, one-time-code and payment fields; unknown means sensitive. */
  private isSensitiveField(target: Locator): Promise<boolean> {
    return target
      .evaluate((element) => {
        const input = element instanceof HTMLInputElement ? element : null;
        const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
        return input?.type === "password" || /one-time-code|current-password|new-password|cc-/.test(autocomplete);
      })
      .catch(() => true);
  }

  /** The AI snapshot prints each textbox value, so sensitive ones are masked before an agent sees it. */
  private async maskSensitiveValues(snapshot: string): Promise<string> {
    const lines = snapshot.split("\n");
    let checked = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const match = TEXTBOX_WITH_VALUE.exec(lines[index] ?? "");
      if (!match) continue;
      checked += 1;
      const sensitive = checked > MAX_FIELD_CHECKS || (await this.isSensitiveField(this.target(match[2] ?? "")));
      if (sensitive) lines[index] = `${match[1]}: [redacted]`;
    }
    return lines.join("\n");
  }

  async snapshot(): Promise<string> {
    return this.maskSensitiveValues(await this.page.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT_MS }));
  }

  async click(ref: string): Promise<void> {
    const target = this.target(ref);
    if ((await target.count()) === 0) throw new BrowserActionError("element_not_found", "No element with that ref");
    await target.click({ timeout: ACTION_TIMEOUT_MS }).catch(() => {
      throw new BrowserActionError("action_failed", "The click did not complete");
    });
    await this.settle();
  }

  async fill(ref: string, value: string): Promise<void> {
    const target = this.target(ref);
    if ((await target.count()) === 0) throw new BrowserActionError("element_not_found", "No element with that ref");
    if (await this.isSensitiveField(target)) {
      throw new BrowserActionError(
        "sensitive_field",
        "Agents cannot type into password or one-time-code fields; ask a board user to sign in",
      );
    }
    await target.fill(value, { timeout: ACTION_TIMEOUT_MS }).catch(() => {
      throw new BrowserActionError("action_failed", "The field could not be filled");
    });
  }

  async press(key: BrowserKey): Promise<void> {
    await this.page.keyboard.press(key);
    await this.settle();
  }

  async scroll(deltaY: number): Promise<void> {
    await this.page.mouse.wheel(0, deltaY);
  }

  async wait(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async pointerClick(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y);
    await this.settle();
  }

  async typeText(text: string): Promise<void> {
    await this.page.keyboard.type(text);
  }

  screenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: "jpeg", quality: 60 });
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
  }
}

class PlaywrightRuntime implements BrowserRuntime {
  private readonly tabs = new Map<string, PlaywrightTab>();
  private readonly pages = new Map<string, Page>();

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly policies: WeakMap<Page, BrowserTabPolicy>,
  ) {}

  tabCount(): number {
    return this.tabs.size;
  }

  async openTab(key: string, policy: BrowserTabPolicy): Promise<BrowserTab> {
    const existing = this.tabs.get(key);
    if (existing) return existing;
    if (this.tabs.size >= LIVE_PAGE_LIMIT) {
      throw new BrowserActionError("too_many_tabs", "This profile already has the maximum number of open tabs");
    }
    const page = await this.context.newPage();
    this.policies.set(page, policy);
    const tab = new PlaywrightTab(page);
    this.tabs.set(key, tab);
    this.pages.set(key, page);
    page.on("close", () => {
      this.tabs.delete(key);
      this.pages.delete(key);
    });
    return tab;
  }

  async closeTab(key: string): Promise<void> {
    const tab = this.tabs.get(key);
    this.tabs.delete(key);
    this.pages.delete(key);
    await tab?.close();
  }

  async exportSession(): Promise<string> {
    return JSON.stringify(await this.context.storageState({ indexedDB: true }));
  }

  async close(): Promise<void> {
    this.tabs.clear();
    this.pages.clear();
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}

/**
 * Chromium driven through Playwright. It only runs when the operator sets
 * `PAPERCLIP_BROWSER_EXECUTABLE_PATH`; the standard image ships no browser.
 * @param env - Environment to read; defaults to `process.env`.
 * @returns An executor, available or reporting why it is not.
 */
export function createPlaywrightExecutor(env: NodeJS.ProcessEnv = process.env): BrowserExecutor {
  const executablePath = env[EXECUTABLE_ENV]?.trim();
  if (!executablePath) {
    return {
      available: false,
      unavailableReason: `No browser is configured. Set ${EXECUTABLE_ENV} on the server to a Chromium executable.`,
      launch: () => Promise.reject(new Error("browser runtime unavailable")),
    };
  }
  return {
    available: true,
    unavailableReason: null,
    async launch(session) {
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({ executablePath, headless: true });
      try {
        const context = await browser.newContext({
          viewport: VIEWPORT,
          acceptDownloads: false,
          serviceWorkers: "block",
          permissions: [],
          ...(session ? { storageState: JSON.parse(session) } : {}),
        });
        const policies = new WeakMap<Page, BrowserTabPolicy>();
        await context.route("**/*", async (route) => {
          if (await shouldAbort(route.request(), policies).catch(() => true)) {
            await route.abort("blockedbyclient").catch(() => undefined);
            return;
          }
          await route.continue().catch(() => undefined);
        });
        return new PlaywrightRuntime(browser, context, policies);
      } catch (error) {
        logger.warn({ errorName: error instanceof Error ? error.name : typeof error }, "browser launch failed");
        await browser.close().catch(() => undefined);
        throw error;
      }
    },
  };
}
