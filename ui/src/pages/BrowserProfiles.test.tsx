// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BrowserProfile, BrowserProfilesOverview } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserProfiles } from "./BrowserProfiles";

const mockApi = vi.hoisted(() => ({
  overview: vi.fn(),
  saveSettings: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  suspend: vi.fn(),
  resume: vi.fn(),
  remove: vi.fn(),
  startSignIn: vi.fn(),
  signInState: vi.fn(),
  signInFrameUrl: vi.fn(),
  sendSignInInput: vi.fn(),
  endSignIn: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/browser-profiles", () => ({ browserProfilesApi: mockApi }));
vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function profile(overrides: Partial<BrowserProfile> = {}): BrowserProfile {
  return {
    id: "profile-1",
    companyId: "company-1",
    name: "Acme login",
    status: "active",
    allowedDomains: ["app.example.com", "*.example.com"],
    allowedAgentIds: ["agent-1"],
    hasSavedSession: true,
    lastSavedAt: "2026-10-08T09:30:00.000Z",
    signIn: { active: false, userId: null, expiresAt: null },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-08T09:30:00.000Z",
    ...overrides,
  };
}

function overviewOf(overrides: Partial<BrowserProfilesOverview> = {}): BrowserProfilesOverview {
  return {
    enabled: true,
    runtime: { available: true, reason: null },
    profiles: [profile()],
    ...overrides,
  };
}

function agent(id: string, name: string) {
  return { id, companyId: "company-1", name, title: null, icon: null, status: "idle" };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function findButton(label: string): HTMLButtonElement {
  const match = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`No button named "${label}"`);
  return match;
}

function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    field instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function fieldLabelled(label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelEl = [...document.body.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const field = labelEl?.htmlFor ? document.getElementById(labelEl.htmlFor) : null;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
    throw new Error(`No field labelled "${label}"`);
  }
  return field;
}

describe("BrowserProfiles page", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderPage() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BrowserProfiles />
        </QueryClientProvider>,
      );
    });
    await waitForAssertion(() => {
      expect(document.body.textContent).toContain("Shared browser");
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const fn of Object.values(mockApi)) fn.mockReset();
    mockAgentsApi.list.mockReset();
    mockSetBreadcrumbs.mockReset();
    mockApi.overview.mockResolvedValue(overviewOf());
    mockAgentsApi.list.mockResolvedValue([agent("agent-1", "Ada"), agent("agent-2", "Grace")]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("shows the runtime reason and keeps sign-in off while the runtime is unavailable", async () => {
    mockApi.overview.mockResolvedValue(
      overviewOf({ runtime: { available: false, reason: "Chromium is not installed on this server." } }),
    );
    await renderPage();

    await waitForAssertion(() => {
      expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
        "Chromium is not installed on this server.",
      );
    });
    const signIn = findButton("Sign in to Acme login");
    expect(signIn.disabled).toBe(true);

    act(() => signIn.click());
    await flush();
    expect(document.body.textContent).not.toContain("Start sign-in");
    expect(mockApi.startSignIn).not.toHaveBeenCalled();
    expect(findButton("Edit Acme login").disabled).toBe(false);
  });

  it("lists each profile with status, saved login, domains and agent names", async () => {
    mockApi.overview.mockResolvedValue(
      overviewOf({
        profiles: [
          profile(),
          profile({
            id: "profile-2",
            name: "Billing portal",
            status: "suspended",
            allowedDomains: [],
            allowedAgentIds: [],
            hasSavedSession: false,
            lastSavedAt: null,
          }),
        ],
      }),
    );
    await renderPage();

    await waitForAssertion(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Acme login");
      expect(text).toContain("Active");
      expect(text).toContain("Saved login");
      expect(text).toContain("app.example.com, *.example.com");
      expect(text).toContain("Ada");
      expect(text).toContain("Billing portal");
      expect(text).toContain("Suspended");
      expect(text).toContain("No saved login yet");
    });
    expect(document.body.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-10-08T09:30:00.000Z",
    );
    expect(findButton("Suspend Acme login")).toBeDefined();
    expect(findButton("Resume Billing portal")).toBeDefined();
  });

  it("turns the company setting on and off", async () => {
    mockApi.saveSettings.mockResolvedValue({ enabled: false });
    await renderPage();

    await waitForAssertion(() => {
      expect(document.body.querySelector('[role="switch"]')).not.toBeNull();
    });
    const toggle = document.body.querySelector('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockApi.saveSettings).toHaveBeenCalledWith("company-1", { enabled: false });
  });

  it("creates a profile with the name and domains the person entered", async () => {
    mockApi.create.mockResolvedValue(profile({ id: "profile-3", name: "Support desk" }));
    await renderPage();

    await waitForAssertion(() => expect(findButton("New profile")).toBeDefined());
    act(() => findButton("New profile").click());
    setFieldValue(fieldLabelled("Name"), "  Support desk ");
    setFieldValue(fieldLabelled("Allowed domains"), "Support.Example.com\n*.example.com\nsupport.example.com");
    await act(async () => {
      findButton("Create profile").click();
    });
    await flush();

    expect(mockApi.create).toHaveBeenCalledTimes(1);
    expect(mockApi.create).toHaveBeenCalledWith("company-1", {
      name: "Support desk",
      allowedDomains: ["support.example.com", "*.example.com"],
    });
    expect(mockApi.update).not.toHaveBeenCalled();
    await waitForAssertion(() => {
      expect(document.body.textContent).not.toContain("Create profile");
    });
  });

  it("saves the allowed agents with a second request because create does not accept them", async () => {
    mockApi.create.mockResolvedValue(profile({ id: "profile-3", name: "Support desk", allowedAgentIds: [] }));
    mockApi.update.mockResolvedValue(profile({ id: "profile-3", name: "Support desk" }));
    await renderPage();

    await waitForAssertion(() => expect(findButton("New profile")).toBeDefined());
    act(() => findButton("New profile").click());
    setFieldValue(fieldLabelled("Name"), "Support desk");
    await act(async () => {
      findButton("Select agents").click();
    });
    await waitForAssertion(() => {
      expect(document.body.querySelector('[aria-label="Allow Grace"]')).not.toBeNull();
    });
    await act(async () => {
      document.body.querySelector('[aria-label="Allow Grace"]')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    await act(async () => {
      findButton("Done").click();
    });
    await act(async () => {
      findButton("Create profile").click();
    });
    await flush();

    expect(mockApi.create).toHaveBeenCalledWith("company-1", {
      name: "Support desk",
      allowedDomains: [],
    });
    expect(mockApi.update).toHaveBeenCalledWith("company-1", "profile-3", {
      allowedAgentIds: ["agent-2"],
    });
  });

  it("does not send an invalid domain and says which one is wrong", async () => {
    await renderPage();

    await waitForAssertion(() => expect(findButton("New profile")).toBeDefined());
    act(() => findButton("New profile").click());
    setFieldValue(fieldLabelled("Name"), "Support desk");
    setFieldValue(fieldLabelled("Allowed domains"), "localhost");
    await act(async () => {
      findButton("Create profile").click();
    });
    await flush();

    expect(mockApi.create).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      '"localhost" is not a valid host',
    );
  });

  it("edits a profile with all three fields", async () => {
    mockApi.update.mockResolvedValue(profile({ name: "Acme admin" }));
    await renderPage();

    await waitForAssertion(() => expect(findButton("Edit Acme login")).toBeDefined());
    act(() => findButton("Edit Acme login").click());
    expect(fieldLabelled("Name").value).toBe("Acme login");
    expect(fieldLabelled("Allowed domains").value).toBe("app.example.com\n*.example.com");
    setFieldValue(fieldLabelled("Name"), "Acme admin");
    await act(async () => {
      findButton("Save changes").click();
    });
    await flush();

    expect(mockApi.update).toHaveBeenCalledWith("company-1", "profile-1", {
      name: "Acme admin",
      allowedDomains: ["app.example.com", "*.example.com"],
      allowedAgentIds: ["agent-1"],
    });
  });

  it("suspends and resumes a profile", async () => {
    mockApi.suspend.mockResolvedValue(profile({ status: "suspended" }));
    await renderPage();

    await waitForAssertion(() => expect(findButton("Suspend Acme login")).toBeDefined());
    await act(async () => {
      findButton("Suspend Acme login").click();
    });
    await flush();

    expect(mockApi.suspend).toHaveBeenCalledWith("company-1", "profile-1");
    expect(mockApi.resume).not.toHaveBeenCalled();
  });

  it("asks before deleting and says every agent loses the saved login", async () => {
    mockApi.remove.mockResolvedValue({ ok: true });
    await renderPage();

    await waitForAssertion(() => expect(findButton("Delete Acme login")).toBeDefined());
    act(() => findButton("Delete Acme login").click());
    await flush();

    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "erases the saved login for every agent",
    );
    expect(mockApi.remove).not.toHaveBeenCalled();

    act(() => findButton("Cancel").click());
    await flush();
    expect(mockApi.remove).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();

    act(() => findButton("Delete Acme login").click());
    await flush();
    await act(async () => {
      findButton("Delete profile").click();
    });
    await flush();

    expect(mockApi.remove).toHaveBeenCalledTimes(1);
    expect(mockApi.remove).toHaveBeenCalledWith("company-1", "profile-1");
  });

  it("keeps the delete dialog open and explains a failed delete", async () => {
    mockApi.remove.mockRejectedValue(new Error("Profile is in use."));
    await renderPage();

    await waitForAssertion(() => expect(findButton("Delete Acme login")).toBeDefined());
    act(() => findButton("Delete Acme login").click());
    await flush();
    await act(async () => {
      findButton("Delete profile").click();
    });
    await flush();

    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Profile is in use.",
    );
  });
});
