import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
// Credentials and grants belong to Paperclip AI Connections. The plugin keeps no private copy.
const plugin = definePlugin({
  async setup() {},
  async onHealth() {
    return {
      status: "ok",
      message:
        "Providers setup is available. Gateway health is tested when connecting.",
    };
  },
});
export default plugin;
runWorker(plugin, import.meta.url);
