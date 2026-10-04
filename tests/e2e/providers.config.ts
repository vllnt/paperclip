import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const gatewayPort = process.env.PAPERCLIP_E2E_GATEWAY_PORT ?? "18318";
process.env.PAPERCLIP_E2E_GATEWAY_PORT = gatewayPort;
export default defineConfig({
  ...base,
  testMatch: "providers.spec.ts",
  testIgnore: [],
  use: { ...base.use, trace: "retain-on-failure", actionTimeout: 15_000 },
  webServer: {
    ...(base.webServer as Exclude<typeof base.webServer, unknown[]>),
    cwd: path.resolve(import.meta.dirname, "../.."),
    command: "node --import ./cli/node_modules/tsx/dist/loader.mjs cli/src/index.ts onboard --yes --run",
    env: {
      ...(base.webServer as { env: Record<string, string> }).env,
      PAPERCLIP_AI_GATEWAY_ALLOWED_ORIGINS: `http://127.0.0.1:${gatewayPort}`,
      PAPERCLIP_BUNDLED_PLUGIN_ROOT: path.resolve(import.meta.dirname, "../../packages/plugins"),
    },
  },
});
