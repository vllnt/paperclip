import { stringify } from "smol-toml";

/** The control plane authorizes the destination before supplying this launch value. */
export function codexGatewayConfig(baseUrl: string | undefined): string {
  if (!baseUrl?.trim()) return "";
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new Error("Invalid Codex gateway URL");
  }
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Invalid Codex gateway URL");
  }
  return stringify({
    model_provider: "paperclip_gateway",
    model_providers: {
      paperclip_gateway: {
        name: "AI gateway",
        base_url: endpoint.toString().replace(/\/$/, ""),
        wire_api: "responses",
        env_key: "OPENAI_API_KEY",
        requires_openai_auth: false,
      },
    },
  });
}
