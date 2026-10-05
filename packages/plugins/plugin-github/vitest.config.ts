import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@vllnt/paperclip-github",
    include: ["tests/**/*.spec.{ts,tsx}"],
    environment: "node",
  },
});
