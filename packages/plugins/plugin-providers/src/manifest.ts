import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
const manifest: PaperclipPluginManifestV1 = {
  id: "vllnt.paperclip-plugin-cliproxyapi",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Providers",
  description:
    "Connect Claude and Codex agents to an existing compatible API, including CLIProxyAPI.",
  author: "VLLNT",
  categories: ["connector"],
  capabilities: [
    "ui.page.register",
    "ui.sidebar.register",
    "ui.action.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  ui: {
    slots: [
      {
        type: "page",
        id: "gateway",
        displayName: "Providers",
        exportName: "ProvidersPage",
        routePath: "providers",
      },
      {
        type: "sidebar",
        sidebarSection: "org",
        id: "providers-sidebar",
        displayName: "Providers",
        exportName: "ProvidersSidebar",
      },
      {
        type: "toolbarButton",
        id: "agent-providers",
        displayName: "Manage providers",
        exportName: "AgentProvidersLink",
        entityTypes: ["agent"],
      },
    ],
  },
};
export default manifest;
