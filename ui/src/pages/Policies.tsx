import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyPolicy } from "@paperclipai/shared";
import { Plus, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { policiesApi } from "../api/policies";
import { projectsApi } from "../api/projects";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { PolicyEditorDialog } from "../components/PolicyEditorDialog";
import { PolicyList } from "../components/PolicyList";
import { queryKeys } from "../lib/queryKeys";

/** The company's policies: written rules and guardrails, company-wide ones first, then each project's. */
export function Policies() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; policy: CompanyPolicy | null }>({ open: false, policy: null });

  useEffect(() => {
    setBreadcrumbs([{ label: "Policies" }]);
  }, [setBreadcrumbs]);

  const policiesQuery = useQuery({
    queryKey: queryKeys.policies.list(selectedCompanyId!),
    queryFn: () => policiesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });

  const projectNames = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project.name])),
    [projects],
  );
  const policies = policiesQuery.data ?? [];
  const archivedCount = policies.filter((policy) => policy.status === "archived").length;
  const visible = showArchived ? policies : policies.filter((policy) => policy.status !== "archived");
  const companyPolicies = visible.filter((policy) => !policy.projectId);
  const projectPolicies = visible.filter((policy) => policy.projectId);

  if (!selectedCompanyId) {
    return <EmptyState icon={ScrollText} message="Select an organization to view policies." />;
  }
  if (policiesQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const openNew = () => setEditor({ open: true, policy: null });
  const openPolicy = (policy: CompanyPolicy) => setEditor({ open: true, policy });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-sm text-muted-foreground">
          Written rules and guardrails for agents. Active company policies apply to all work; a project policy applies to
          that project&apos;s tasks. Approvals, tool policies, the skill policy and budgets enforce limits.
        </p>
        <div className="flex items-center gap-2">
          {archivedCount > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setShowArchived((current) => !current)}>
              {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={openNew}>
            <Plus className="h-3.5 w-3.5" />
            New policy
          </Button>
        </div>
      </div>

      {policiesQuery.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          <span>Failed to load policies: {policiesQuery.error.message}</span>
          <Button size="sm" variant="outline" onClick={() => void policiesQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}

      {policiesQuery.data && visible.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          message={archivedCount > 0 ? "Only archived policies." : "No policies yet. Write the first rule agents should follow."}
          action="New policy"
          onAction={openNew}
        />
      ) : null}

      {companyPolicies.length > 0 ? (
        <section className="flex flex-col gap-2" aria-labelledby="company-policies-heading">
          <h2 id="company-policies-heading" className="text-xs text-muted-foreground">Company</h2>
          <PolicyList policies={companyPolicies} onOpen={openPolicy} label="Company policies" />
        </section>
      ) : null}

      {projectPolicies.length > 0 ? (
        <section className="flex flex-col gap-2" aria-labelledby="project-policies-heading">
          <h2 id="project-policies-heading" className="text-xs text-muted-foreground">Projects</h2>
          <PolicyList policies={projectPolicies} onOpen={openPolicy} label="Project policies" projectNames={projectNames} />
        </section>
      ) : null}

      <PolicyEditorDialog
        companyId={selectedCompanyId}
        open={editor.open}
        policy={editor.policy}
        onOpenChange={(open) => setEditor((current) => ({ ...current, open }))}
      />
    </div>
  );
}
