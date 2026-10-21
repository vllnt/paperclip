import type { CompanyPolicy } from "@paperclipai/shared";
import { StatusBadge } from "./StatusBadge";

export interface PolicyListProps {
  policies: CompanyPolicy[];
  onOpen: (policy: CompanyPolicy) => void;
  /** The accessible name of the list. */
  label: string;
  /** Project names by ID; when given, a project policy shows which project it applies to. */
  projectNames?: Map<string, string>;
}

/** Rows of policies: title, `policy://` key, status, scope and summary. Selecting a row opens it. */
export function PolicyList({ policies, onOpen, label, projectNames }: PolicyListProps) {
  return (
    <ul className="rounded-lg border border-border" aria-label={label}>
      {policies.map((policy) => {
        const scopeLabel = policy.projectId
          ? projectNames?.get(policy.projectId) ?? null
          : projectNames
            ? "Company"
            : null;
        return (
          <li key={policy.id} className="border-b border-border last:border-b-0">
            <button
              type="button"
              className="flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
              onClick={() => onOpen(policy)}
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 truncate text-sm font-medium">{policy.title}</span>
                <StatusBadge status={policy.status} />
                {scopeLabel ? <span className="text-xs text-muted-foreground">{scopeLabel}</span> : null}
                <span className="ml-auto font-mono text-xs text-muted-foreground">policy://{policy.key}</span>
              </span>
              {policy.summary ? (
                <span className="truncate text-sm text-muted-foreground">{policy.summary}</span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
