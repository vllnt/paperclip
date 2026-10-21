import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyPolicy } from "@paperclipai/shared";
import { Plus } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { policiesApi } from "../api/policies";
import { queryKeys } from "../lib/queryKeys";
import { PolicyEditorDialog } from "./PolicyEditorDialog";
import { PolicyList } from "./PolicyList";

export interface ProjectPoliciesSectionProps {
  companyId: string;
  projectId: string;
  /** False for an archived project: its policies stay readable and editable, but no new one starts there. */
  canCreate?: boolean;
}

/** The project Configuration tab's policies: rules for this project's tasks, on top of the company policies. */
export function ProjectPoliciesSection({ companyId, projectId, canCreate = true }: ProjectPoliciesSectionProps) {
  const [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; policy: CompanyPolicy | null }>({ open: false, policy: null });

  const policiesQuery = useQuery({
    queryKey: queryKeys.policies.list(companyId, { projectId }),
    queryFn: () => policiesApi.list(companyId, { projectId }),
  });

  const policies = policiesQuery.data ?? [];
  const archivedCount = policies.filter((policy) => policy.status === "archived").length;
  const visible = showArchived ? policies : policies.filter((policy) => policy.status !== "archived");
  const openNew = () => setEditor({ open: true, policy: null });

  return (
    <section className="flex flex-col gap-3" aria-labelledby="project-policies-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="project-policies-heading" className="text-xs text-muted-foreground">Policies</h3>
        <div className="flex items-center gap-2">
          {archivedCount > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setShowArchived((current) => !current)}>
              {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
            </Button>
          ) : null}
          {canCreate ? (
            <Button size="sm" variant="outline" onClick={openNew}>
              <Plus className="h-3.5 w-3.5" />
              New policy
            </Button>
          ) : null}
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

      {policiesQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading policies…</p>
      ) : !policiesQuery.data ? null : visible.length === 0 ? (
        <p className="rounded-lg border border-border px-3 py-4 text-sm text-muted-foreground">
          {archivedCount > 0 ? "Only archived policies in this project." : "No project policies yet."}
        </p>
      ) : (
        <PolicyList policies={visible} onOpen={(policy) => setEditor({ open: true, policy })} label="Project policies" />
      )}

      <p className="text-xs text-muted-foreground">
        Active <Link to="/policies" className="text-link">company policies</Link> apply to this project too.
      </p>

      <PolicyEditorDialog
        companyId={companyId}
        open={editor.open}
        policy={editor.policy}
        defaultProjectId={projectId}
        onOpenChange={(open) => setEditor((current) => ({ ...current, open }))}
      />
    </section>
  );
}
