import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@vllnt/paperclip-convex",
    include: ["tests/**/*.spec.{ts,tsx}"],
    environment: "node",
  },
});
