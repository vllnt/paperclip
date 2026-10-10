import { useEffect, useRef, useState } from "react";
import { Check, Search, X } from "lucide-react";
import {
  ROUTINE_LIST_QUERY_MAX_LENGTH,
  ROUTINE_LIST_TRIGGER_FILTERS,
  ROUTINE_STATUSES,
  type RoutineListTriggerFilter,
  type RoutineStatus,
} from "@paperclipai/shared";
import type { RoutineListFilters } from "../api/routines";
import { useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** URL parameters the routine filters own; the folder rail keeps its own `folder` parameter. */
export const ROUTINE_FILTER_PARAM_KEYS = ["q", "status", "trigger", "agent"] as const;

/** Routine list filters as they appear in the page URL. */
export interface RoutineUrlFilters {
  q: string;
  status: RoutineStatus | null;
  trigger: RoutineListTriggerFilter | null;
  agentId: string | null;
}

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_LABELS: Record<RoutineStatus, string> = { active: "Active", paused: "Paused", archived: "Archived" };
const TRIGGER_LABELS: Record<RoutineListTriggerFilter, string> = {
  schedule: "Schedule",
  webhook: "Webhook",
  api: "API",
  manual: "No trigger",
};

/**
 * Reads the routine filters from the page URL. Values the list API would refuse are ignored, and `q` loses
 * any NUL character and is cut to the API's limit, so a hand-edited link still shows a list.
 * @param params - The current URL search parameters.
 * @returns The filters, with `null` for each one that is not set.
 */
export function readRoutineUrlFilters(params: URLSearchParams): RoutineUrlFilters {
  const status = params.get("status");
  const trigger = params.get("trigger");
  const agentId = params.get("agent");
  return {
    q: params.get("q")?.split("\u0000").join("").trim().slice(0, ROUTINE_LIST_QUERY_MAX_LENGTH).trim() ?? "",
    status: ROUTINE_STATUSES.find((value) => value === status) ?? null,
    trigger: ROUTINE_LIST_TRIGGER_FILTERS.find((value) => value === trigger) ?? null,
    agentId: agentId && GUID_PATTERN.test(agentId) ? agentId : null,
  };
}

/**
 * Turns the URL filters into the list API query. A fixed agent (the agent page's tab) wins over the
 * agent filter in the URL.
 */
export function routineListQueryFromFilters(filters: RoutineUrlFilters, fixedAssigneeAgentId?: string): RoutineListFilters {
  const assigneeAgentId = fixedAssigneeAgentId ?? filters.agentId;
  return {
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.trigger ? { trigger: filters.trigger } : {}),
    ...(assigneeAgentId ? { assigneeAgentId } : {}),
  };
}

type SetSearchParams = ReturnType<typeof useSearchParams>[1];

/**
 * Changes the page's URL parameters, starting from the browser URL at the time of the call. React Router
 * renders a navigation as a transition, so the parameters it passes to an updater can miss a write made
 * just before (a chip, then the search timer). The browser URL already has that write.
 */
export function changeSearchParams(
  setSearchParams: SetSearchParams,
  change: (params: URLSearchParams) => void,
  options: { replace?: boolean } = { replace: true },
): void {
  setSearchParams(() => {
    const params = new URLSearchParams(window.location.search);
    change(params);
    return params;
  }, options);
}

/**
 * The search box text, kept in step with the `q` URL parameter. Typing writes `q` after `delayMs`.
 * The write starts from the browser URL as it is then, so a filter changed while the timer runs is kept.
 * An outside change of `q` (Clear filters, back or forward) replaces the text; the hook's own write
 * does not, so keys typed while it lands are kept.
 * @returns The current text and its setter.
 */
export function useRoutineSearchDraft(delayMs = 250): [string, (value: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQ = readRoutineUrlFilters(searchParams).q;
  const [draft, setDraft] = useState(urlQ);
  const writtenQ = useRef(urlQ);
  const latestSetSearchParams = useRef(setSearchParams);

  useEffect(() => {
    latestSetSearchParams.current = setSearchParams;
  }, [setSearchParams]);

  useEffect(() => {
    if (urlQ === writtenQ.current) return;
    writtenQ.current = urlQ;
    setDraft(urlQ);
  }, [urlQ]);

  useEffect(() => {
    const next = draft.trim();
    if (next === writtenQ.current) return;
    const timer = window.setTimeout(() => {
      writtenQ.current = next;
      changeSearchParams(latestSetSearchParams.current, (params) => {
        if (next) params.set("q", next);
        else params.delete("q");
      });
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [draft, delayMs]);

  return [draft, setDraft];
}

/** True when any URL-owned routine filter narrows the list. */
export function hasActiveRoutineFilters(filters: RoutineUrlFilters, fixedAssigneeAgentId?: string): boolean {
  return Boolean(filters.q || filters.status || filters.trigger || (!fixedAssigneeAgentId && filters.agentId));
}

interface FilterChipProps<T extends string> {
  label: string;
  ariaLabel: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T | null) => void;
}

function FilterChip<T extends string>({ label, ariaLabel, value, options, onChange }: FilterChipProps<T>) {
  const selected = options.find((option) => option.value === value) ?? null;
  const rows: ReadonlyArray<{ value: T | null; label: string }> = [{ value: null, label: "Any" }, ...options];
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={selected ? "secondary" : "outline"} size="sm" className="text-xs" aria-label={ariaLabel}>
          {selected ? `${label}: ${selected.label}` : label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 max-h-(--sz-calc-9) overflow-y-auto overscroll-contain p-0">
        <div className="p-2 space-y-0.5">
          {rows.map((option) => (
            <button
              key={option.value ?? "__any"}
              type="button"
              className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                option.value === value ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50"
              }`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.value === value ? <Check className="h-3.5 w-3.5" /> : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export interface RoutineListFilterBarProps {
  searchDraft: string;
  onSearchDraftChange: (value: string) => void;
  filters: RoutineUrlFilters;
  /** Agents for the agent chip; omit to hide it (the agent page's tab fixes the agent). */
  agents?: ReadonlyArray<{ id: string; name: string }>;
  onFilterChange: (key: "status" | "trigger" | "agent", value: string | null) => void;
  onClear: () => void;
  active: boolean;
}

/** Search box and filter chips for the routine list. They combine with the group-by and live in the URL. */
export function RoutineListFilterBar({
  searchDraft,
  onSearchDraftChange,
  filters,
  agents,
  onFilterChange,
  onClear,
  active,
}: RoutineListFilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-64">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={searchDraft}
          onChange={(event) => onSearchDraftChange(event.target.value)}
          placeholder="Search routines"
          aria-label="Search routines"
          maxLength={ROUTINE_LIST_QUERY_MAX_LENGTH}
          className="h-8 pl-8"
        />
      </div>
      {agents ? (
        <FilterChip
          label="Agent"
          ariaLabel="Filter by agent"
          value={filters.agentId}
          options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
          onChange={(value) => onFilterChange("agent", value)}
        />
      ) : null}
      <FilterChip
        label="Status"
        ariaLabel="Filter by status"
        value={filters.status}
        options={ROUTINE_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] }))}
        onChange={(value) => onFilterChange("status", value)}
      />
      <FilterChip
        label="Trigger"
        ariaLabel="Filter by trigger"
        value={filters.trigger}
        options={ROUTINE_LIST_TRIGGER_FILTERS.map((trigger) => ({ value: trigger, label: TRIGGER_LABELS[trigger] }))}
        onChange={(value) => onFilterChange("trigger", value)}
      />
      {active ? (
        <Button variant="ghost" size="sm" className="text-xs" onClick={onClear}>
          <X className="mr-1 h-3.5 w-3.5" />
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
