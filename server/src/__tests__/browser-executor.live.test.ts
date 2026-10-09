import { describe, expect, it } from "vitest";
import { createPlaywrightExecutor } from "../services/browser-executor.js";

const live = Boolean(process.env.PAPERCLIP_BROWSER_EXECUTABLE_PATH?.trim());

const FORM = `data:text/html,${encodeURIComponent(
  '<title>Form</title><label>Name <input aria-label="Name" name="n"></label>' +
    '<label>Secret <input aria-label="Secret" type="password" name="p" value="TOP-SECRET-VALUE"></label>' +
    '<input aria-label="Code" autocomplete="one-time-code" value="OTP-654321">' +
    '<input aria-label="Plain" value="visible-value">' +
    '<button onclick="document.title=\'clicked\'">Go</button>',
)}`;

const SESSION = JSON.stringify({
  cookies: [
    {
      name: "sid",
      value: "LIVE-COOKIE-VALUE",
      domain: "example.com",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  origins: [],
});

describe.skipIf(!live)("Playwright executor against a real Chromium", () => {
  it("reports why it is unavailable when no browser is configured", () => {
    const executor = createPlaywrightExecutor({});
    expect(executor.available).toBe(false);
    expect(executor.unavailableReason).toContain("PAPERCLIP_BROWSER_EXECUTABLE_PATH");
  });

  it("snapshots with refs, acts through them, and refuses password fields", async () => {
    const runtime = await createPlaywrightExecutor().launch(null);
    try {
      const tab = await runtime.openTab("human", { agentAllowedDomains: null });
      await tab.navigate(FORM);
      const snapshot = await tab.snapshot();
      expect(snapshot).toMatch(/textbox "Name" \[ref=e\d+\]/);
      const nameRef = /textbox "Name" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
      const secretRef = /textbox "Secret" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
      const buttonRef = /button "Go" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
      expect(nameRef && secretRef && buttonRef).toBeTruthy();

      await tab.fill(nameRef!, "Ada");
      await expect(tab.fill(secretRef!, "hunter2")).rejects.toMatchObject({ code: "sensitive_field" });
      const masked = await tab.snapshot();
      expect(masked).not.toContain("TOP-SECRET-VALUE");
      expect(masked).not.toContain("OTP-654321");
      expect(masked).toContain("visible-value");
      expect(masked).toContain("Ada");
      await tab.click(buttonRef!);
      expect((await tab.state()).title).toBe("clicked");
      await expect(tab.click("e9999")).rejects.toMatchObject({ code: "element_not_found" });
      expect((await tab.screenshot()).subarray(0, 2).toString("hex")).toBe("ffd8");
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it("blocks internal addresses for everyone and off-allowlist navigation for agent tabs", async () => {
    const runtime = await createPlaywrightExecutor().launch(null);
    try {
      const human = await runtime.openTab("human", { agentAllowedDomains: null });
      await expect(human.navigate("http://127.0.0.1:9/")).rejects.toMatchObject({ code: "navigation_blocked" });
      await expect(human.navigate("https://localhost/")).rejects.toMatchObject({ code: "navigation_blocked" });

      const agent = await runtime.openTab("agent", { agentAllowedDomains: ["allowed.example"] });
      await expect(agent.navigate("https://not-allowed.example/")).rejects.toMatchObject({ code: "navigation_blocked" });
      await expect(agent.navigate(FORM)).rejects.toMatchObject({ code: "navigation_blocked" });
      expect((await agent.state()).url).not.toContain("not-allowed");
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it("restores a saved session into a new browser and exports it again", async () => {
    const executor = createPlaywrightExecutor();
    const first = await executor.launch(SESSION);
    const exported = await first.exportSession();
    await first.close();
    expect(JSON.parse(exported).cookies[0]).toMatchObject({ name: "sid", value: "LIVE-COOKIE-VALUE" });

    const second = await executor.launch(exported);
    try {
      expect(await second.exportSession()).toContain("LIVE-COOKIE-VALUE");
    } finally {
      await second.close();
    }
  }, 60_000);

  it("limits the number of open tabs", async () => {
    const runtime = await createPlaywrightExecutor().launch(null);
    try {
      for (const key of ["a", "b", "c", "d"]) await runtime.openTab(key, { agentAllowedDomains: [] });
      await expect(runtime.openTab("e", { agentAllowedDomains: [] })).rejects.toMatchObject({ code: "too_many_tabs" });
    } finally {
      await runtime.close();
    }
  }, 60_000);
});
