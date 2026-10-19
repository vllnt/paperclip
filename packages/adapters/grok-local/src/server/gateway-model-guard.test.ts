import { describe, expect, it } from "vitest";
import { findGrokGatewayModelProblem, GROK_GATEWAY_MODEL_REQUIRED } from "./gateway-model-guard.js";

const GATEWAY_ENV = { GROK_XAI_API_BASE_URL: "https://gateway.example/v1" };

describe("findGrokGatewayModelProblem", () => {
  it("uses a stable error code", () => {
    expect(GROK_GATEWAY_MODEL_REQUIRED).toBe("grok_gateway_model_required");
  });

  it.each(["", "   ", "grok-build", "claude-3-5-haiku", "gpt-5"])(
    "rejects model %j when a gateway base URL is set",
    (model) => {
      const problem = findGrokGatewayModelProblem({ model, env: GATEWAY_ENV });
      expect(problem).not.toBeNull();
      expect(problem?.hint).toContain("grok-4.7");
      expect(problem?.hint).toContain("model");
    },
  );

  it.each(["grok-4.7", "grok-4.6", " grok-4.5 ", "xai/grok-4.7"])(
    "accepts the pinned model %j when a gateway base URL is set",
    (model) => {
      expect(findGrokGatewayModelProblem({ model, env: GATEWAY_ENV })).toBeNull();
    },
  );

  it.each([{}, { GROK_XAI_API_BASE_URL: "" }, { GROK_XAI_API_BASE_URL: "  " }, { GROK_XAI_API_BASE_URL: undefined }])(
    "allows any model when no gateway base URL is set (%j)",
    (env) => {
      expect(findGrokGatewayModelProblem({ model: "", env })).toBeNull();
      expect(findGrokGatewayModelProblem({ model: "grok-build", env })).toBeNull();
    },
  );

  it("names the offending model and the base URL variable in the message", () => {
    const problem = findGrokGatewayModelProblem({ model: "grok-build", env: GATEWAY_ENV });
    expect(problem?.message).toContain("grok-build");
    expect(problem?.message).toContain("GROK_XAI_API_BASE_URL");
  });

  it("does not echo the gateway URL", () => {
    const problem = findGrokGatewayModelProblem({ model: "", env: GATEWAY_ENV });
    expect(`${problem?.message} ${problem?.hint}`).not.toContain("gateway.example");
  });
});
