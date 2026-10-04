import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import {
  aiGatewayConfigSchema,
  createAiConnectionSchema,
} from "@paperclipai/shared";
import {
  assertAiGatewayEndpoint,
  discoverAiGatewayModels,
  validateAiGatewayKey,
} from "../services/ai-gateway.js";

let server: Server;
let baseUrl: string;
const received: {
  path: string;
  authorization?: string;
  anthropicVersion?: string;
  body: Record<string, unknown>;
}[] = [];
let mode = "ok";
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let input = "";
    for await (const chunk of req) input += chunk;
    received.push({
      path: req.url!,
      authorization: req.headers.authorization,
      anthropicVersion: req.headers["anthropic-version"] as string | undefined,
      body: input ? JSON.parse(input) : {},
    });
    if (mode === "redirect") {
      res.writeHead(302, { Location: `${baseUrl}/stolen` });
      res.end();
      return;
    }
    if (mode === "rejected") {
      res.writeHead(401);
      res.end("fixture-secret-must-not-escape");
      return;
    }
    res.setHeader("content-type", "application/json");
    if (mode === "malformed") {
      res.end("fixture-secret-must-not-escape");
      return;
    }
    if (mode === "oversized") {
      res.end("x".repeat(1_048_577));
      return;
    }
    if (mode === "chat-completions-only") {
      res.end(
        JSON.stringify({
          object: "chat.completion",
          choices: [{ message: { content: "OK" } }],
        }),
      );
      return;
    }
    if (mode === "client-specific-catalog") {
      // CLIProxyAPI changes model IDs when discovery looks like an Anthropic client.
      res.end(JSON.stringify({ data: [{ id: req.headers["anthropic-version"]
        ? "claude-gateway-alias" : "test-codex" }] }));
      return;
    }
    if (mode === "empty-models") {
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.end(
      JSON.stringify(
        req.url === "/v1/models"
          ? {
              data: [
                { id: "test-codex" },
                { id: "test-claude" },
                { id: "test-codex" },
              ],
            }
          : req.url === "/v1/messages"
            ? { type: "message", content: [{ type: "text", text: "OK" }] }
            : {
                object: "response",
                status: "completed",
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: "OK" }],
                  },
                ],
              },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.stubEnv("PAPERCLIP_AI_GATEWAY_ALLOWED_ORIGINS", baseUrl);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("AI gateway protocols", () => {
  it("discovers and tests both protocols against an isolated HTTP server using the proxy key", async () => {
    expect(
      await discoverAiGatewayModels({ baseUrl }, "fixture-proxy-key"),
    ).toEqual({ models: ["test-claude", "test-codex"] });
    await validateAiGatewayKey(
      "openai",
      { baseUrl },
      "fixture-proxy-key",
      "test-codex",
    );
    await validateAiGatewayKey(
      "anthropic",
      { baseUrl },
      "fixture-proxy-key",
      "test-claude",
    );
    expect(received.slice(-3).map((r) => [r.path, r.authorization])).toEqual([
      ["/v1/models", "Bearer fixture-proxy-key"],
      ["/v1/responses", "Bearer fixture-proxy-key"],
      ["/v1/messages", "Bearer fixture-proxy-key"],
    ]);
    expect(received.slice(-3).map((r) => r.anthropicVersion)).toEqual([
      undefined, undefined, "2023-06-01",
    ]);
    expect(received.at(-2)?.body).toMatchObject({
      model: "test-codex",
      store: false,
    });
    expect(received.at(-1)?.body).toMatchObject({
      model: "test-claude",
      messages: [{ role: "user", content: "Reply OK." }],
    });
  });
  it("discovers canonical model IDs without triggering Anthropic catalog aliases", async () => {
    mode = "client-specific-catalog";
    try {
      await expect(discoverAiGatewayModels({ baseUrl }, "fixture-proxy-key"))
        .resolves.toEqual({ models: ["test-codex"] });
    } finally {
      mode = "ok";
    }
  });
  it.each(["redirect", "rejected", "malformed", "oversized"])(
    "rejects %s without leaking upstream content or following redirects",
    async (failure) => {
      mode = failure;
      const count = received.length;
      try {
        await expect(
          discoverAiGatewayModels({ baseUrl }, "fixture-proxy-key"),
        ).rejects.toThrow(/gateway/i);
        expect(received).toHaveLength(count + 1);
        const probe = validateAiGatewayKey(
          "openai",
          { baseUrl },
          "fixture-proxy-key",
          "test",
        );
        await expect(probe).rejects.toThrow(/gateway/i);
        await expect(probe).rejects.not.toThrow("fixture-secret");
      } finally {
        mode = "ok";
      }
    },
  );
  it.each(["openai", "anthropic"] as const)(
    "rejects a successful Chat Completions response for %s",
    async (provider) => {
      mode = "chat-completions-only";
      try {
        await expect(
          validateAiGatewayKey(
            provider,
            { baseUrl },
            "fixture-proxy-key",
            "test",
          ),
        ).rejects.toThrow("compatible");
      } finally {
        mode = "ok";
      }
    },
  );
  it("reports an empty model catalog clearly", async () => {
    mode = "empty-models";
    try {
      await expect(
        discoverAiGatewayModels({ baseUrl }, "fixture-proxy-key"),
      ).rejects.toThrow("no available models");
    } finally {
      mode = "ok";
    }
  });
  it("requires the exact operator-approved origin, including the port", async () => {
    await expect(
      assertAiGatewayEndpoint({ baseUrl: "http://127.0.0.1:1" }),
    ).rejects.toThrow("PAPERCLIP_AI_GATEWAY_ALLOWED_ORIGINS");
  });
  it("denies link-local metadata even when explicitly listed", async () => {
    vi.stubEnv(
      "PAPERCLIP_AI_GATEWAY_ALLOWED_ORIGINS",
      "http://169.254.169.254",
    );
    try {
      await expect(
        assertAiGatewayEndpoint({ baseUrl: "http://169.254.169.254" }),
      ).rejects.toThrow("unsafe");
    } finally {
      vi.stubEnv("PAPERCLIP_AI_GATEWAY_ALLOWED_ORIGINS", baseUrl);
    }
  });
});

describe("AI gateway input contract", () => {
  it("normalizes a pasted /v1 suffix and trailing slash", () => {
    expect(
      aiGatewayConfigSchema.parse({
        baseUrl: "https://proxy.example/prefix/v1/",
      }),
    ).toEqual({ baseUrl: "https://proxy.example/prefix" });
  });
  it.each([
    "file:///tmp/key",
    "https://user:secret@proxy.example",
    "https://proxy.example?key=secret",
    "https://proxy.example/#fragment",
    "http://proxy.example/\\bad",
  ])("rejects unsafe URL %s", (baseUrl) => {
    expect(aiGatewayConfigSchema.safeParse({ baseUrl }).success).toBe(false);
  });
  it("requires a test model and supported API-key provider", () => {
    const input = {
      name: "Gateway",
      provider: "openai",
      method: "api_key",
      ownership: "shared",
      apiKey: "fixture",
      gateway: { baseUrl: "https://proxy.example" },
    };
    expect(createAiConnectionSchema.safeParse(input).success).toBe(false);
    expect(
      createAiConnectionSchema.safeParse({ ...input, testModel: "model" })
        .success,
    ).toBe(true);
    expect(
      createAiConnectionSchema.safeParse({
        ...input,
        testModel: "model",
        provider: "xai",
      }).success,
    ).toBe(false);
    expect(
      createAiConnectionSchema.safeParse({
        ...input,
        testModel: "model",
        method: "subscription",
        apiKey: undefined,
        loginSessionId: "id",
      }).success,
    ).toBe(false);
  });
});
