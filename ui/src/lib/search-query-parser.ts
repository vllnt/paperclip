import {
  COMPANY_SEARCH_SCOPES,
  COMPANY_SEARCH_SORTS,
  COMPANY_SEARCH_UPDATED_WITHIN_OPTIONS,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  isUuidLike,
  normalizeAgentUrlKey,
  type CompanySearchScope,
  type CompanySearchSort,
  type IssuePriority,
  type IssueStatus,
} from "@paperclipai/shared";
import type { CompanySearchParams } from "@/api/search";

const OPEN_STATUSES: IssueStatus[] = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const CLOSED_STATUSES: IssueStatus[] = ["done", "cancelled"];

export type SearchOperatorKey =
  | "status"
  | "assignee"
  | "project"
  | "label"
  | "priority"
  | "updated"
  | "is"
  | "scope"
  | "sort";

export interface SearchOperatorPill {
  key: SearchOperatorKey;
  value: string;
  label: string;
}

export interface SearchOperatorSuggestion {
  token: string;
  label: string;
  description: string;
}

export const SEARCH_OPERATOR_QUICK_FILTERS = ["assignee:me", "is:open", "updated:>7d"] as const;

export const SEARCH_OPERATOR_SUGGESTIONS: SearchOperatorSuggestion[] = [
  { token: "status:todo", label: "Open todo tasks", description: "Filter by task status" },
  { token: "status:blocked", label: "Blocked tasks", description: "Find blocked work" },
  { token: "assignee:me", label: "Assigned to me", description: "Use your current board user" },
  { token: "project:\"Paperclip App\"", label: "Project name", description: "Quote multi-word project names" },
  { token: "label:bug", label: "Label", description: "Filter by issue label" },
  { token: "priority:high", label: "High priority", description: "Filter by priority" },
  { token: "updated:>7d", label: "Recently updated", description: "Updated in the last 7 days" },
  { token: "scope:issues", label: "Only tasks", description: "Limit results to one kind" },
  { token: "sort:updated", label: "Newest first", description: "Order results by last update" },
];

export interface SearchQueryParserContext {
  currentAgentId?: string | null;
  currentUserId?: string | null;
  agents?: readonly { id: string; name: string; urlKey?: string | null }[];
  projects?: readonly { id: string; name: string; urlKey?: string | null }[];
  labels?: readonly { id: string; name: string }[];
}

export interface ParsedSearchQuery {
  query: string;
  filters: Pick<
    CompanySearchParams,
    | "status"
    | "priority"
    | "assigneeAgentId"
    | "assigneeUserId"
    | "projectId"
    | "labelId"
    | "updatedWithin"
    | "updatedAfter"
  >;
  /** Result kind from a `scope:` token; absent means all kinds. */
  scope?: CompanySearchScope;
  /** Order from a `sort:` token; absent means relevance. */
  sort?: CompanySearchSort;
  pills: SearchOperatorPill[];
}

interface QueryToken {
  raw: string;
  value: string;
}

function stripValueQuotes(value: string) {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1);
  }
  return value;
}

function tokenizeQuery(input: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  let index = 0;
  while (index < input.length) {
    while (/\s/.test(input[index] ?? "")) index += 1;
    if (index >= input.length) break;

    const start = index;
    if (input[index] === "\"") {
      index += 1;
      while (index < input.length && input[index] !== "\"") index += 1;
      if (input[index] === "\"") index += 1;
      const raw = input.slice(start, index);
      tokens.push({ raw, value: raw });
      continue;
    }

    while (index < input.length && !/\s/.test(input[index] ?? "")) {
      if (input[index] === ":" && input[index + 1] === "\"") {
        index += 2;
        while (index < input.length && input[index] !== "\"") index += 1;
        if (input[index] === "\"") index += 1;
        break;
      }
      index += 1;
    }

    const raw = input.slice(start, index);
    tokens.push({ raw, value: raw });
  }
  return tokens;
}

function currentTokenBounds(input: string): { start: number; end: number; token: string } {
  let end = input.length;
  while (end > 0 && /\s/.test(input[end - 1] ?? "")) end -= 1;
  let start = end;
  while (start > 0 && !/\s/.test(input[start - 1] ?? "")) start -= 1;
  return { start, end, token: input.slice(start, end) };
}

export function searchOperatorSuggestions(input: string, limit = 5): SearchOperatorSuggestion[] {
  const { token } = currentTokenBounds(input);
  const normalized = token.toLowerCase();
  const candidates = normalized.length > 0
    ? SEARCH_OPERATOR_SUGGESTIONS.filter((suggestion) => suggestion.token.toLowerCase().startsWith(normalized))
    : SEARCH_OPERATOR_SUGGESTIONS;
  return candidates.slice(0, limit);
}

export function applySearchOperatorSuggestion(input: string, token: string): string {
  const { start, end } = currentTokenBounds(input);
  const prefix = input.slice(0, start).trimEnd();
  const suffix = input.slice(end).trimStart();
  return [prefix, token, suffix].filter(Boolean).join(" ").trim();
}

function normalizedLookup(value: string) {
  return normalizeAgentUrlKey(value) ?? value.trim().toLowerCase();
}

function findByNameOrId<T extends { id: string; name: string; urlKey?: string | null }>(
  entries: readonly T[] | undefined,
  value: string,
): T | null {
  const normalized = normalizedLookup(value);
  return entries?.find((entry) => {
    if (entry.id === value) return true;
    if (normalizedLookup(entry.name) === normalized) return true;
    return entry.urlKey ? normalizedLookup(entry.urlKey) === normalized : false;
  }) ?? null;
}

function addUnique<T extends string>(values: T[] | undefined, value: T): T[] {
  return values?.includes(value) ? values : [...(values ?? []), value];
}

function appendText(parts: string[], raw: string) {
  if (raw.trim().length > 0) parts.push(raw);
}

function parseStatus(value: string): IssueStatus | null {
  return (ISSUE_STATUSES as readonly string[]).includes(value) ? value as IssueStatus : null;
}

function parsePriority(value: string): IssuePriority | null {
  return (ISSUE_PRIORITIES as readonly string[]).includes(value) ? value as IssuePriority : null;
}

function parseUpdatedWithin(value: string): string | null {
  const normalized = value.startsWith(">") ? value.slice(1) : value;
  if (!/^[1-9]\d{0,2}(h|d|w|m)$/.test(normalized)) return null;
  return normalized;
}

function operatorLabel(key: SearchOperatorKey, value: string) {
  return `${key}:${value}`;
}

export function parseSearchQuery(input: string, context: SearchQueryParserContext = {}): ParsedSearchQuery {
  const textParts: string[] = [];
  const filters: ParsedSearchQuery["filters"] = {};
  const pills: SearchOperatorPill[] = [];
  let scope: CompanySearchScope | undefined;
  let sort: CompanySearchSort | undefined;

  for (const token of tokenizeQuery(input)) {
    const match = /^([a-zA-Z]+):(.*)$/s.exec(token.value);
    if (!match) {
      appendText(textParts, token.raw);
      continue;
    }

    const key = match[1]!.toLowerCase();
    const rawValue = match[2]!;
    const value = stripValueQuotes(rawValue).trim();
    if (!value) {
      appendText(textParts, token.raw);
      continue;
    }

    if (key === "status") {
      const status = parseStatus(value);
      if (!status) {
        appendText(textParts, token.raw);
        continue;
      }
      filters.status = addUnique(filters.status, status);
      pills.push({ key: "status", value: status, label: operatorLabel("status", status) });
      continue;
    }

    if (key === "priority") {
      const priority = parsePriority(value);
      if (!priority) {
        appendText(textParts, token.raw);
        continue;
      }
      filters.priority = addUnique(filters.priority, priority);
      pills.push({ key: "priority", value: priority, label: operatorLabel("priority", priority) });
      continue;
    }

    if (key === "assignee") {
      if (value.toLowerCase() === "me") {
        if (context.currentAgentId) {
          filters.assigneeAgentId = context.currentAgentId;
          pills.push({ key: "assignee", value: "me", label: "assignee:me" });
          continue;
        }
        if (context.currentUserId) {
          filters.assigneeUserId = context.currentUserId;
          pills.push({ key: "assignee", value: "me", label: "assignee:me" });
          continue;
        }
        appendText(textParts, token.raw);
        continue;
      }

      const agent = findByNameOrId(context.agents, value);
      if (!agent) {
        appendText(textParts, token.raw);
        continue;
      }
      filters.assigneeAgentId = agent.id;
      pills.push({ key: "assignee", value: agent.name, label: operatorLabel("assignee", agent.name) });
      continue;
    }

    if (key === "project") {
      const project = findByNameOrId(context.projects, value);
      if (!project) {
        appendText(textParts, token.raw);
        continue;
      }
      filters.projectId = project.id;
      pills.push({ key: "project", value: project.name, label: operatorLabel("project", project.name) });
      continue;
    }

    if (key === "label") {
      const label = findByNameOrId(context.labels, value);
      if (label) {
        filters.labelId = label.id;
        pills.push({ key: "label", value: label.name, label: operatorLabel("label", label.name) });
        continue;
      }
      if (isUuidLike(value)) {
        filters.labelId = value;
        pills.push({ key: "label", value, label: operatorLabel("label", value.slice(0, 8)) });
        continue;
      }
      appendText(textParts, token.raw);
      continue;
    }

    if (key === "updated") {
      const updatedWithin = parseUpdatedWithin(value);
      if (!updatedWithin) {
        appendText(textParts, token.raw);
        continue;
      }
      filters.updatedWithin = updatedWithin;
      pills.push({ key: "updated", value: `>${updatedWithin}`, label: operatorLabel("updated", `>${updatedWithin}`) });
      continue;
    }

    if (key === "scope" || key === "sort") {
      const normalized = value.toLowerCase();
      if (key === "scope" && (COMPANY_SEARCH_SCOPES as readonly string[]).includes(normalized)) {
        scope = normalized as CompanySearchScope;
      } else if (key === "sort" && (COMPANY_SEARCH_SORTS as readonly string[]).includes(normalized)) {
        sort = normalized as CompanySearchSort;
      } else {
        appendText(textParts, token.raw);
        continue;
      }
      pills.push({ key, value: normalized, label: operatorLabel(key, normalized) });
      continue;
    }

    if (key === "is") {
      if (value === "open") {
        filters.status = OPEN_STATUSES;
        pills.push({ key: "is", value: "open", label: "is:open" });
        continue;
      }
      if (value === "closed") {
        filters.status = CLOSED_STATUSES;
        pills.push({ key: "is", value: "closed", label: "is:closed" });
        continue;
      }
      appendText(textParts, token.raw);
      continue;
    }

    appendText(textParts, token.raw);
  }

  return {
    query: textParts.join(" ").replace(/\s+/g, " ").trim(),
    filters,
    ...(scope && scope !== "all" ? { scope } : {}),
    ...(sort && sort !== "relevance" ? { sort } : {}),
    pills,
  };
}

function validValues<T extends string>(values: string[], allowed: readonly T[]): T[] {
  return values.filter((value): value is T => (allowed as readonly string[]).includes(value));
}

export function readSearchFiltersFromParams(search: URLSearchParams): ParsedSearchQuery["filters"] {
  const filters: ParsedSearchQuery["filters"] = {};
  const statuses = validValues(search.getAll("status").flatMap((value) => value.split(",")), ISSUE_STATUSES);
  const priorities = validValues(search.getAll("priority").flatMap((value) => value.split(",")), ISSUE_PRIORITIES);
  const assigneeAgentId = search.get("assigneeAgentId");
  const assigneeUserId = search.get("assigneeUserId");
  const projectId = search.get("projectId");
  const labelId = search.get("labelId");
  const updatedWithin = search.get("updatedWithin");
  const updatedAfter = search.get("updatedAfter");

  if (statuses.length > 0) filters.status = statuses;
  if (priorities.length > 0) filters.priority = priorities;
  if (assigneeAgentId !== null) filters.assigneeAgentId = assigneeAgentId === "null" ? null : assigneeAgentId;
  if (assigneeUserId) filters.assigneeUserId = assigneeUserId;
  if (projectId && isUuidLike(projectId)) filters.projectId = projectId;
  if (labelId && isUuidLike(labelId)) filters.labelId = labelId;
  if (updatedWithin && (/^[1-9]\d{0,2}(h|d|w|m)$/.test(updatedWithin) || (COMPANY_SEARCH_UPDATED_WITHIN_OPTIONS as readonly string[]).includes(updatedWithin))) {
    filters.updatedWithin = updatedWithin;
  }
  if (updatedAfter && !Number.isNaN(new Date(updatedAfter).getTime())) filters.updatedAfter = updatedAfter;
  return filters;
}

export function hasSearchFilters(filters: ParsedSearchQuery["filters"]) {
  return Boolean(
    filters.status?.length
    || filters.priority?.length
    || filters.assigneeAgentId !== undefined
    || filters.assigneeUserId
    || filters.projectId
    || filters.labelId
    || filters.updatedWithin
    || filters.updatedAfter,
  );
}

/**
 * Launcher text for an old `/search?...` URL: the free text plus operator
 * tokens for its filters, scope and sort, so the launcher reads them back.
 * `updatedAfter` has no operator and is dropped.
 */
export function searchQueryFromUrlParams(search: URLSearchParams): string {
  const filters = readSearchFiltersFromParams(search);
  const parts: string[] = [];
  const text = search.get("q")?.trim();
  if (text) parts.push(text);
  for (const status of filters.status ?? []) parts.push(`status:${status}`);
  for (const priority of filters.priority ?? []) parts.push(`priority:${priority}`);
  if (filters.assigneeUserId) parts.push("assignee:me");
  else if (filters.assigneeAgentId) parts.push(`assignee:${filters.assigneeAgentId}`);
  if (filters.projectId) parts.push(`project:${filters.projectId}`);
  if (filters.labelId) parts.push(`label:${filters.labelId}`);
  if (filters.updatedWithin) parts.push(`updated:>${filters.updatedWithin}`);
  const scope = search.get("scope");
  if (scope && scope !== "all" && (COMPANY_SEARCH_SCOPES as readonly string[]).includes(scope)) parts.push(`scope:${scope}`);
  const sort = search.get("sort");
  if (sort && sort !== "relevance" && (COMPANY_SEARCH_SORTS as readonly string[]).includes(sort)) parts.push(`sort:${sort}`);
  return parts.join(" ");
}
