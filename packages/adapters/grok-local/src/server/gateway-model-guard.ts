import { classifyModelVendor } from "@paperclipai/shared";
import { DEFAULT_GROK_LOCAL_MODEL } from "../index.js";

/** Error code shared by the environment test check and the failed run. */
export const GROK_GATEWAY_MODEL_REQUIRED = "grok_gateway_model_required";

/** Example model the hint points the operator to. */
const EXAMPLE_GROK_MODEL = "grok-4.7";

export interface GrokGatewayModelProblem {
  message: string;
  hint: string;
}

function describeModel(model: string): string {
  if (!model) return "not set";
  if (model === DEFAULT_GROK_LOCAL_MODEL) return `"${model}", the placeholder that sends no model`;
  return `"${model}", which is not a Grok model`;
}

/**
 * Finds a model setting that would run the wrong model through a gateway.
 *
 * Behind a gateway the Grok CLI's own default model is whatever the gateway
 * serves, not a Grok model. An empty model, or the placeholder default, makes
 * the adapter send no `--model` flag, so the gateway default would run. A
 * non-Grok model would run on the wrong vendor. Without a gateway base URL the
 * CLI default is a Grok model, so nothing is checked.
 *
 * @param input.model The agent's configured model, trimmed or not.
 * @param input.env The environment the CLI will see (host env plus agent env).
 * @returns The problem with a message and a fix hint, or `null` when the model
 * is pinned to a Grok model or no gateway base URL is set.
 * @example
 * findGrokGatewayModelProblem({ model: "", env: { GROK_XAI_API_BASE_URL: "https://gateway.example/v1" } });
 */
export function findGrokGatewayModelProblem(input: {
  model: string;
  env: Readonly<Record<string, string | undefined>>;
}): GrokGatewayModelProblem | null {
  const baseUrl = input.env.GROK_XAI_API_BASE_URL?.trim() ?? "";
  if (!baseUrl) return null;
  const model = input.model.trim();
  const pinned = model !== DEFAULT_GROK_LOCAL_MODEL && classifyModelVendor(model) === "xai";
  if (pinned) return null;
  return {
    message:
      `GROK_XAI_API_BASE_URL is set, so Grok Build runs through a gateway, but the agent's model is ${describeModel(model)}. ` +
      "The gateway's default model is not a Grok model.",
    hint:
      `Set the agent's model to a Grok model such as ${EXAMPLE_GROK_MODEL} (adapterConfig.model, or the Model field on the agent page), ` +
      "or remove GROK_XAI_API_BASE_URL to use the CLI's own default. See doc/workers/grok-build.md.",
  };
}
