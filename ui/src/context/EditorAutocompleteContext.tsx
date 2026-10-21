import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildPolicyMentionHref, buildRoutineMentionHref, buildSkillMentionHref } from "@paperclipai/shared";
import { companySkillsApi } from "../api/companySkills";
import { policiesApi } from "../api/policies";
import { routinesApi } from "../api/routines";
import { useCompany } from "./CompanyContext";
import { queryKeys } from "../lib/queryKeys";

export interface SkillCommandOption {
  id: string;
  kind: "skill";
  skillId: string;
  key: string;
  name: string;
  slug: string;
  description: string | null;
  href: string;
  aliases: string[];
}

export interface RoutineCommandOption {
  id: string;
  kind: "routine";
  routineId: string;
  name: string;
  status: string;
  href: string;
  aliases: string[];
}

export interface PolicyCommandOption {
  id: string;
  kind: "policy";
  policyKey: string;
  name: string;
  summary: string | null;
  href: string;
  aliases: string[];
}

export interface ActionCommandOption {
  id: string;
  kind: "action";
  command: string;
  name: string;
  description: string;
  aliases: string[];
  disabled?: boolean;
  disabledReason?: string | null;
}

export type SlashCommandOption =
  | SkillCommandOption
  | RoutineCommandOption
  | PolicyCommandOption
  | ActionCommandOption;

interface EditorAutocompleteContextValue {
  slashCommands: SlashCommandOption[];
}

const EditorAutocompleteContext = createContext<EditorAutocompleteContextValue>({
  slashCommands: [],
});

export function EditorAutocompleteProvider({ children }: { children: ReactNode }) {
  const { selectedCompanyId } = useCompany();
  const { data: companySkills = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.companySkills.list(selectedCompanyId)
      : ["company-skills", "__none__"],
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const { data: routines = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.routines.list(selectedCompanyId)
      : ["routines", "__none__", "__all-projects__"],
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  // Same key and fetch as the Policies page, so the two share one cache entry and one invalidation.
  const { data: policies = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.policies.list(selectedCompanyId)
      : ["policies", "__none__"],
    queryFn: () => policiesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const value = useMemo<EditorAutocompleteContextValue>(() => ({
    slashCommands: [
      ...companySkills.map((skill) => ({
        id: `skill:${skill.id}`,
        kind: "skill" as const,
        skillId: skill.id,
        key: skill.key,
        name: skill.name,
        slug: skill.slug,
        description: skill.description ?? null,
        href: buildSkillMentionHref(skill.id, skill.slug),
        aliases: [skill.slug, skill.name, skill.key],
      })),
      ...routines
        .filter((routine) => routine.status !== "archived")
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((routine) => ({
          id: `routine:${routine.id}`,
          kind: "routine" as const,
          routineId: routine.id,
          name: routine.title,
          status: routine.status,
          href: buildRoutineMentionHref(routine.id),
          aliases: [`routine:${routine.title}`, routine.title, routine.id],
        })),
      ...policies
        .filter((policy) => policy.status === "active")
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((policy) => ({
          id: `policy:${policy.key}`,
          kind: "policy" as const,
          policyKey: policy.key,
          name: policy.title,
          summary: policy.summary,
          href: buildPolicyMentionHref(policy.key),
          aliases: [`policy:${policy.title}`, `policy:${policy.key}`, policy.title, policy.key],
        })),
    ],
  }), [companySkills, routines, policies]);

  return (
    <EditorAutocompleteContext.Provider value={value}>
      {children}
    </EditorAutocompleteContext.Provider>
  );
}

export function useEditorAutocomplete() {
  return useContext(EditorAutocompleteContext);
}
