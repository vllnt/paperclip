import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  HARNESS_FALLBACK_ADAPTER_TYPES,
  MAX_AGENT_FALLBACKS,
  checkHarnessModelCompatibility,
  type AgentDetail,
  type AgentFallbackTarget,
  type AgentHarnessFallbackState,
  type EnvBinding,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { secretsApi } from "../api/secrets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { EnvironmentVariablesEditor } from "./environment-variables-editor";

const HARNESS_LABELS: Record<string, string> = {
  claude_local: "Claude Code",
  codex_local: "Codex",
  grok_local: "Grok Build",
};

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The quota state of an agent: "On fallback codex_local/gpt-5.5 until 14:30",
 * or "Waiting for provider quota until 14:30" when every target is cooling down.
 */
export function AgentHarnessFallbackBadge({ state }: { state: AgentHarnessFallbackState | null | undefined }) {
  if (!state) return null;
  const target = state.model ? `${state.adapterType}/${state.model}` : state.adapterType;
  const text = state.heldUntil
    ? `Waiting for provider quota until ${formatClock(state.heldUntil)}`
    : state.active
      ? `On fallback ${target} until ${formatClock(state.primaryCooldownUntil)}`
      : `Primary cooling down until ${formatClock(state.primaryCooldownUntil)}`;
  return (
    <Badge
      variant="outline"
      className="max-w-full whitespace-normal text-left"
      data-testid="agent-harness-fallback-badge"
      title={state.reason ?? undefined}
    >
      {text}
    </Badge>
  );
}

interface DraftEntry {
  adapterType: AgentFallbackTarget["adapterType"];
  model: string;
  effort: string;
  env: Record<string, EnvBinding>;
  adapterConfig?: Record<string, unknown>;
}

function toDraft(fallbacks: readonly AgentFallbackTarget[] | undefined): DraftEntry[] {
  return (fallbacks ?? []).map((entry) => ({
    adapterType: entry.adapterType,
    model: entry.model,
    effort: entry.effort ?? "",
    env: (entry.env ?? {}) as Record<string, EnvBinding>,
    ...(entry.adapterConfig ? { adapterConfig: entry.adapterConfig } : {}),
  }));
}

function fromDraft(entries: readonly DraftEntry[]): AgentFallbackTarget[] {
  return entries.map((entry) => ({
    adapterType: entry.adapterType,
    model: entry.model.trim(),
    ...(entry.effort.trim() ? { effort: entry.effort.trim() } : {}),
    ...(entry.adapterConfig ? { adapterConfig: entry.adapterConfig } : {}),
    ...(Object.keys(entry.env).length > 0 ? { env: entry.env as AgentFallbackTarget["env"] } : {}),
  }));
}

function draftError(entry: DraftEntry): string | null {
  if (!entry.model.trim()) return "Choose a model.";
  const result = checkHarnessModelCompatibility(
    { adapterType: entry.adapterType, model: entry.model, extraArgs: entry.adapterConfig?.extraArgs },
    { requireKnownVendor: true },
  );
  return result.ok ? null : result.message;
}

/**
 * Edits an agent's ordered harness/model fallback chain. Each entry has its
 * own environment; credentials must be company secrets.
 */
export function AgentFallbacksSection({ agent, companyId }: { agent: AgentDetail; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [entries, setEntries] = useState<DraftEntry[]>(() => toDraft(agent.fallbacks));
  const [saveError, setSaveError] = useState<string | null>(null);
  const storedKey = JSON.stringify(agent.fallbacks ?? []);
  useEffect(() => {
    setEntries(toDraft(agent.fallbacks));
    setSaveError(null);
  }, [storedKey]);
  const dirty = JSON.stringify(fromDraft(entries)) !== JSON.stringify(fromDraft(toDraft(agent.fallbacks)));
  const errors = useMemo(() => entries.map(draftError), [entries]);

  const { data: secrets = [] } = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
  });
  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => secretsApi.create(companyId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) }),
  });
  const save = useMutation({
    mutationFn: () => agentsApi.update(agent.id, { fallbacks: fromDraft(entries) }, companyId),
    onSuccess: () => {
      setSaveError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
      pushToast({ title: "Fallbacks saved", tone: "success" });
    },
    onError: (err) => {
      setSaveError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Could not save fallbacks");
    },
  });

  const update = (index: number, patch: Partial<DraftEntry>) =>
    setEntries((current) => current.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)));
  const move = (index: number, offset: number) =>
    setEntries((current) => {
      const next = [...current];
      const [entry] = next.splice(index, 1);
      next.splice(index + offset, 0, entry);
      return next;
    });

  return (
    <section className="space-y-3" data-testid="agent-fallbacks-section" aria-labelledby="agent-fallbacks-title">
      <div className="space-y-1">
        <h3 id="agent-fallbacks-title" className="text-sm font-medium">Fallback harnesses</h3>
        <p className="text-xs text-muted-foreground">
          When the primary harness hits a provider usage limit before doing work, the wake runs once on the first
          available fallback. Later runs use the fallback until the provider resets. Anthropic models run only on
          Claude Code.
        </p>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="agent-fallbacks-empty">
          No fallbacks. Runs wait for the provider reset when the primary is out of quota.
        </p>
      ) : null}
      <ol className="space-y-3">
        {entries.map((entry, index) => (
          <li
            key={index}
            className="space-y-3 rounded-lg border border-border p-4"
            data-testid={`agent-fallback-entry-${index}`}
          >
            <div className="flex flex-wrap items-end gap-3">
              <span className="text-xs font-medium text-muted-foreground">{index + 1}.</span>
              <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs">
                Harness
                <Select
                  value={entry.adapterType}
                  onValueChange={(value) => update(index, { adapterType: value as DraftEntry["adapterType"] })}
                >
                  <SelectTrigger aria-label={`Fallback ${index + 1} harness`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HARNESS_FALLBACK_ADAPTER_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>{HARNESS_LABELS[type] ?? type}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs">
                Model
                <Input
                  aria-label={`Fallback ${index + 1} model`}
                  value={entry.model}
                  placeholder={entry.adapterType === "codex_local" ? "gpt-5.5" : entry.adapterType === "grok_local" ? "grok-4.7" : "claude-sonnet-5"}
                  onChange={(event) => update(index, { model: event.target.value })}
                />
              </label>
              <label className="flex w-32 flex-col gap-1 text-xs">
                Effort
                <Input
                  aria-label={`Fallback ${index + 1} effort`}
                  value={entry.effort}
                  placeholder="default"
                  onChange={(event) => update(index, { effort: event.target.value })}
                />
              </label>
              <div className="flex gap-1">
                <Button type="button" variant="ghost" size="icon" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
                  <ArrowUp />
                </Button>
                <Button type="button" variant="ghost" size="icon" aria-label="Move down" disabled={index === entries.length - 1} onClick={() => move(index, 1)}>
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove fallback ${index + 1}`}
                  onClick={() => setEntries((current) => current.filter((_, position) => position !== index))}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            {errors[index] ? (
              <p role="alert" className="text-xs text-destructive" data-testid={`agent-fallback-error-${index}`}>
                {errors[index]}
              </p>
            ) : null}
            <EnvironmentVariablesEditor
              value={entry.env}
              onChange={(next) => update(index, { env: next ?? {} })}
              secrets={secrets}
              onCreateSecret={(name, value) => createSecret.mutateAsync({ name, value })}
              footerHint="This harness's own environment. Store keys such as OPENAI_API_KEY as secrets."
            />
          </li>
        ))}
      </ol>
      {saveError ? (
        <p role="alert" className="text-xs text-destructive" data-testid="agent-fallbacks-save-error">{saveError}</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={entries.length >= MAX_AGENT_FALLBACKS}
          onClick={() => setEntries((current) => [...current, { adapterType: "codex_local", model: "", effort: "", env: {} }])}
        >
          <Plus /> Add fallback
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || save.isPending || errors.some(Boolean)}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save fallbacks"}
        </Button>
      </div>
    </section>
  );
}
