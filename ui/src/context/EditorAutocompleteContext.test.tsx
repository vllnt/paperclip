// @vitest-environment node

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompanyPolicy } from "@paperclipai/shared";
import { queryKeys } from "../lib/queryKeys";
import {
  EditorAutocompleteProvider,
  useEditorAutocomplete,
  type SlashCommandOption,
} from "./EditorAutocompleteContext";

vi.mock("./CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

function policy(overrides: Partial<CompanyPolicy>): CompanyPolicy {
  return {
    id: `id-${overrides.key}`,
    companyId: "company-1",
    projectId: null,
    key: "policy-key",
    title: "Policy",
    summary: null,
    body: "",
    status: "active",
    ownerAgentId: null,
    ownerUserId: null,
    documentId: "doc-1",
    latestRevisionId: null,
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

type PolicyCommand = Extract<SlashCommandOption, { kind: "policy" }>;

function renderPolicyCommands(policies: CompanyPolicy[]): PolicyCommand[] {
  let captured: SlashCommandOption[] = [];
  function Capture() {
    captured = useEditorAutocomplete().slashCommands;
    return null;
  }

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.policies.list("company-1"), policies);
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <EditorAutocompleteProvider>
        <Capture />
      </EditorAutocompleteProvider>
    </QueryClientProvider>,
  );
  return captured.filter((command): command is PolicyCommand => command.kind === "policy");
}

describe("EditorAutocompleteProvider policy commands", () => {
  it("offers only active policies, sorted by title, linked by policy key", () => {
    const commands = renderPolicyCommands([
      policy({ key: "review-before-merge", title: "Review before merge", status: "active" }),
      policy({ key: "draft-rule", title: "Draft rule", status: "draft" }),
      policy({ key: "old-rule", title: "Old rule", status: "archived" }),
      policy({ key: "never-ship-on-friday", title: "Never ship on Friday", status: "active", projectId: "project-1" }),
    ]);

    expect(commands.map((command) => command.policyKey)).toEqual(["never-ship-on-friday", "review-before-merge"]);
    expect(commands[0]).toMatchObject({
      kind: "policy",
      name: "Never ship on Friday",
      href: "policy://never-ship-on-friday",
    });
    expect(commands[0]?.aliases).toEqual(
      expect.arrayContaining(["policy:Never ship on Friday", "policy:never-ship-on-friday", "never-ship-on-friday"]),
    );
  });

  it("offers nothing when no policy is active", () => {
    expect(renderPolicyCommands([policy({ key: "draft-rule", status: "draft" })])).toEqual([]);
  });
});
