import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@vllnt/paperclip-plugin-cliproxyapi",
    include: ["tests/**/*.spec.{ts,tsx}"],
    environment: "node",
  },
});
