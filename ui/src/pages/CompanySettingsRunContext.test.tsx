// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Company } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BreadcrumbProvider } from "../context/BreadcrumbContext";
import { CompanyProvider } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { CompanySettings } from "./CompanySettings";

// Real CompanyProvider, companiesApi and company routes over HTTP, backed by an
// embedded Postgres started by the server-side fixture; only the transport is
// adapted (relative URLs, and holding or failing the save response).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Resolved from this module so the test runs from the repo root or from ui/.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(MODULE_DIR, "../../../server");
const TSX_CLI = path.resolve(MODULE_DIR, "../../../cli/node_modules/tsx/dist/cli.mjs");
const SAVE_TEST_ID = "company-settings-run-context-save";
const MAX_COMMENTS_TEST_ID = "company-settings-run-context-base-maxComments";
const SETTER = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

const nativeFetch = globalThis.fetch;
let fixtureProcess: ChildProcess;
let origin = "";
let companyId = "";

function startFixture(): Promise<void> {
  return new Promise((resolve, reject) => {
    fixtureProcess = spawn(
      process.execPath,
      [TSX_CLI, "src/__tests__/helpers/company-api-fixture.ts"],
      { cwd: FIXTURE_DIR, stdio: ["ignore", "pipe", "inherit"] },
    );
    let buffered = "";
    fixtureProcess.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const line = buffered.split("\n").find((entry) => entry.startsWith("{"));
      if (!line) return;
      ({ origin, companyId } = JSON.parse(line) as { origin: string; companyId: string });
      resolve();
    });
    fixtureProcess.once("exit", (code) => reject(new Error(`fixture exited early (${code})`)));
  });
}

async function persistedPolicy(): Promise<Company["runContextPolicy"]> {
  const response = await nativeFetch(`${origin}/api/companies/${companyId}`);
  return ((await response.json()) as Company).runContextPolicy;
}

async function resetPolicy() {
  await nativeFetch(`${origin}/api/companies/${companyId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runContextPolicy: { maxComments: 8 } }),
  });
}

describe("CompanySettings run context against the real company API", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;
  let releaseSave: (() => void) | null;
  let failNextSave: boolean;
  let listMode: "pass" | "hold" | "fail";
  let releaseList: (() => void) | null;
  let holdNextSave: boolean;
  let saveStarted: Promise<void>;
  let markSaveStarted: () => void;

  beforeAll(async () => {
    await startFixture();
  }, 90_000);

  afterAll(async () => {
    const exited = new Promise((resolve) => fixtureProcess.once("exit", resolve));
    fixtureProcess.kill("SIGTERM");
    await exited;
  }, 30_000);

  beforeEach(async () => {
    await resetPolicy();
    releaseSave = null;
    failNextSave = false;
    holdNextSave = false;
    listMode = "pass";
    releaseList = null;
    saveStarted = new Promise((resolve) => { markSaveStarted = resolve; });
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" && input.startsWith("/") ? origin + input : input;
      if (init?.method !== "PATCH") {
        const isList = new URL(String(url)).pathname === "/api/companies" && listMode !== "pass";
        if (!isList) return nativeFetch(url, init);
        if (listMode === "fail") {
          return new Response(JSON.stringify({ error: "List failed" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        const held = await nativeFetch(url, init);
        await new Promise<void>((resolve) => { releaseList = resolve; });
        return held;
      }
      if (failNextSave) {
        failNextSave = false;
        return new Response(JSON.stringify({ error: "Save failed" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const response = await nativeFetch(url, init);
      if (holdNextSave) {
        holdNextSave = false;
        markSaveStarted();
        await new Promise<void>((resolve) => { releaseSave = resolve; });
      }
      return response;
    };
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(queryKeys.auth.session, null);
    queryClient.setQueryData(queryKeys.health, {});
    queryClient.setQueryData(queryKeys.instance.generalSettings, {});
    localStorage.setItem("paperclip.selectedCompanyId", companyId);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <CompanyProvider>
              <BreadcrumbProvider>
                <TooltipProvider>
                  <CompanySettings />
                </TooltipProvider>
              </BreadcrumbProvider>
            </CompanyProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => maxComments() !== null);
  });

  afterEach(async () => {
    releaseSave?.();
    releaseList?.();
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    localStorage.clear();
    globalThis.fetch = nativeFetch;
  });

  const byTestId = <T extends HTMLElement>(testId: string) =>
    container.querySelector<T>(`[data-testid="${testId}"]`);
  const maxComments = () => byTestId<HTMLInputElement>(MAX_COMMENTS_TEST_ID);
  const saveButton = () => byTestId<HTMLButtonElement>(SAVE_TEST_ID);

  async function waitFor(condition: () => boolean | Promise<boolean>) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      if (await condition()) return;
    }
    throw new Error("Timed out waiting for the expected UI/API state");
  }

  /** Type like a user: focus, change the value, and leave the field focused. */
  async function typeWithoutBlur(value: string) {
    const input = maxComments();
    if (!input) throw new Error("max comments input missing");
    await act(async () => {
      input.focus();
      SETTER?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function blurInput() {
    await act(async () => maxComments()?.blur());
  }

  async function clickSave() {
    await act(async () => saveButton()?.click());
  }

  it("starts from the persisted policy and offers no save until an edit is committed", async () => {
    expect(maxComments()?.value).toBe("8");
    await typeWithoutBlur("30");
    expect(maxComments()?.value).toBe("30");
    expect(saveButton()).toBeNull();
    expect(await persistedPolicy()).toEqual({ maxComments: 8 });
  });

  it("persists an edit that was typed without blurring once the field loses focus", async () => {
    await typeWithoutBlur("30");
    await blurInput();
    await clickSave();
    await waitFor(() => saveButton() === null);
    expect(await persistedPolicy()).toEqual({ maxComments: 30 });
    await waitFor(() => maxComments()?.value === "30");
  });

  it("locks the editor while saving so a focused edit cannot be lost", async () => {
    holdNextSave = true;
    await typeWithoutBlur("30");
    await blurInput();
    await clickSave();
    await saveStarted;

    expect(maxComments()?.matches(":disabled")).toBe(true);
    expect(saveButton()?.disabled).toBe(true);

    await act(async () => releaseSave?.());
    await waitFor(() => saveButton() === null);
    expect(await persistedPolicy()).toEqual({ maxComments: 30 });
    expect(maxComments()?.matches(":disabled")).toBe(false);
    expect(maxComments()?.value).toBe("30");

    // Edits typed after the save finished are kept and saveable.
    await typeWithoutBlur("40");
    await blurInput();
    await clickSave();
    await waitFor(() => saveButton() === null);
    expect(await persistedPolicy()).toEqual({ maxComments: 40 });
  });

  it("keeps the draft and unlocks the editor when the save fails", async () => {
    failNextSave = true;
    await typeWithoutBlur("30");
    await blurInput();
    await clickSave();
    await waitFor(() => Boolean(container.textContent?.includes("Save failed")));

    expect(await persistedPolicy()).toEqual({ maxComments: 8 });
    expect(maxComments()?.matches(":disabled")).toBe(false);
    expect(maxComments()?.value).toBe("30");
    expect(saveButton()?.disabled).toBe(false);

    await clickSave();
    await waitFor(() => saveButton() === null);
    expect(await persistedPolicy()).toEqual({ maxComments: 30 });
  });

  it("keeps a focused edit typed while the post-save list refresh is still pending", async () => {
    await typeWithoutBlur("30");
    await blurInput();
    listMode = "hold";
    await clickSave();
    await waitFor(() => saveButton() === null && releaseList !== null);

    await typeWithoutBlur("40");
    await act(async () => releaseList?.());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });

    expect(maxComments()?.value).toBe("40");
    await blurInput();
    expect(saveButton()).not.toBeNull();
    expect(await persistedPolicy()).toEqual({ maxComments: 30 });
  });

  it("shows the saved policy when the post-save list refresh fails", async () => {
    await typeWithoutBlur("30");
    await blurInput();
    listMode = "fail";
    await clickSave();
    await waitFor(() => saveButton() === null);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });

    expect(await persistedPolicy()).toEqual({ maxComments: 30 });
    expect(maxComments()?.value).toBe("30");
    expect(saveButton()).toBeNull();
  });
});
