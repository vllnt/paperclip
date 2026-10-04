import {
  aiGatewayConfigSchema,
  type AiGatewayConfig,
  type AiProvider,
} from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";
import { assertPublicRemoteHttpEndpoint } from "./remote-http-endpoint-guard.js";

const ALLOWED_ORIGINS_ENV = "PAPERCLIP_AI_GATEWAY_ALLOWED_ORIGINS";
const error = () =>
  unprocessable(
    "The AI gateway endpoint is unavailable or unsafe. Check the server URL and network configuration.",
  );

/** Native clients also contact this server. Only operator-approved origins may receive credentials. */
export async function assertAiGatewayEndpoint(
  gateway: AiGatewayConfig,
): Promise<AiGatewayConfig> {
  const parsed = aiGatewayConfigSchema.safeParse(gateway);
  if (!parsed.success)
    throw unprocessable(
      "Invalid AI gateway configuration. Reconnect this gateway.",
    );
  const endpoint = new URL(parsed.data.baseUrl);
  const approved = (process.env[ALLOWED_ORIGINS_ENV] ?? "")
    .split(/[\s,]+/)
    .some((entry) => {
      try {
        const url = new URL(entry);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/" &&
          url.origin === endpoint.origin
        );
      } catch {
        return false;
      }
    });
  if (!approved)
    throw unprocessable(
      `Ask the instance administrator to approve the gateway origin in ${ALLOWED_ORIGINS_ENV}.`,
    );
  await assertPublicRemoteHttpEndpoint(
    endpoint,
    { allowPrivateNetwork: true },
    error,
  );
  return parsed.data;
}

async function requestGateway(
  gateway: AiGatewayConfig,
  key: string,
  suffix: string,
  body?: unknown,
): Promise<unknown> {
  const approved = await assertAiGatewayEndpoint(gateway);
  let response: Response | undefined;
  try {
    response = await guardedRemoteHttpFetch(
      `${approved.baseUrl}/v1/${suffix}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          // CLIProxyAPI rewrites catalog IDs when discovery carries Anthropic headers.
          ...(suffix === "messages" ? { "anthropic-version": "2023-06-01" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      },
      { allowPrivateNetwork: true, error },
    );
    if (!response.ok) {
      throw unprocessable(
        response.status === 401 || response.status === 403
          ? "The gateway rejected this API key."
          : "The gateway could not complete the request. Check the model and API compatibility.",
      );
    }
    // Bound untrusted model lists and probe responses. Never expose upstream error bodies.
    if (!response.body) throw error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1_048_576) throw error();
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    // Only locally constructed HTTP errors are safe to expose. Transport and
    // JSON errors may contain credentials or untrusted upstream content.
    if (cause instanceof HttpError) throw cause;
    throw error();
  } finally {
    if (response?.body && !response.body.locked)
      await response.body.cancel().catch(() => {});
  }
}

export async function discoverAiGatewayModels(
  gateway: AiGatewayConfig,
  key: string,
): Promise<{ models: string[] }> {
  const result = (await requestGateway(gateway, key, "models")) as {
    data?: Array<{ id?: unknown }>;
  } | null;
  if (!Array.isArray(result?.data))
    throw unprocessable(
      "The gateway did not return an OpenAI-compatible model list.",
    );
  const models = [
    ...new Set(
      result.data.flatMap((entry) =>
        typeof entry?.id === "string" &&
        entry.id.length > 0 &&
        entry.id.length <= 256 &&
        !/[\r\n]/.test(entry.id)
          ? [entry.id]
          : [],
      ),
    ),
  ].sort();
  if (!models.length)
    throw unprocessable(
      "The gateway has no available models. Configure its upstream providers first.",
    );
  return { models };
}

export async function validateAiGatewayKey(
  provider: AiProvider,
  gateway: AiGatewayConfig,
  key: string,
  model: string,
): Promise<void> {
  if (provider !== "anthropic" && provider !== "openai")
    throw unprocessable("This harness does not support AI gateways.");
  const anthropic = provider === "anthropic";
  const result = (await requestGateway(
    gateway,
    key,
    anthropic ? "messages" : "responses",
    anthropic
      ? {
          model,
          max_tokens: 16,
          messages: [{ role: "user", content: "Reply OK." }],
        }
      : { model, max_output_tokens: 128, input: "Reply OK.", store: false },
  )) as Record<string, unknown> | null;
  if (
    !result ||
    (anthropic
      ? result.type !== "message" || !Array.isArray(result.content)
      : result.object !== "response" ||
        !Array.isArray(result.output) ||
        !["completed", "incomplete"].includes(String(result.status)))
  ) {
    throw unprocessable(
      `The gateway did not return a compatible ${anthropic ? "Anthropic Messages" : "OpenAI Responses"} response.`,
    );
  }
}
