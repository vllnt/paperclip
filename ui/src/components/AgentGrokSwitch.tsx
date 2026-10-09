import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { planCodexToGrokSwitch } from "@paperclipai/adapter-grok-local";
import { classifyModelVendor, type AgentDetail } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * Offered on a Codex agent that runs a Grok model: Grok models need the Grok
 * Build harness for full tool support, and the plan moves the model,
 * instructions, working directory and skills unchanged. It uses the same plan
 * as `paperclipai agent set-adapter` and the same PATCH route.
 */
export function AgentGrokSwitchNotice({ agent, companyId }: { agent: AgentDetail; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [error, setError] = useState<string | null>(null);
  const model = typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : "";
  const applicable = agent.adapterType === "codex_local" && classifyModelVendor(model) === "xai";
  const [baseUrl, setBaseUrl] = useState("");
  const plan = useMemo(
    () => (applicable
      ? planCodexToGrokSwitch(
          { adapterType: agent.adapterType, adapterConfig: agent.adapterConfig ?? {}, runtimeConfig: agent.runtimeConfig },
          { xaiBaseUrl: baseUrl },
        )
      : null),
    [applicable, agent.adapterType, agent.adapterConfig, agent.runtimeConfig, baseUrl],
  );

  const apply = useMutation({
    mutationFn: () => {
      if (!plan?.ok) throw new Error("This agent cannot be switched");
      return agentsApi.update(agent.id, plan.patch, companyId);
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
      pushToast({ title: "Agent moved to Grok Build", tone: "success" });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Could not switch the harness");
    },
  });

  if (!plan) return null;
  return (
    <section className="space-y-3 rounded-lg border border-border p-4" data-testid="agent-grok-switch" aria-labelledby="agent-grok-switch-title">
      <div className="space-y-1">
        <h3 id="agent-grok-switch-title" className="text-sm font-medium">Run {model} on Grok Build</h3>
        <p className="text-xs text-muted-foreground">
          This agent runs a Grok model through Codex. Grok Build is the native harness for it. The switch keeps the
          model, instructions, working directory and skills.
        </p>
      </div>
      {plan.ok || plan.reason === "invalid_base_url" ? (
        <label className="flex flex-col gap-1 text-xs">
          Gateway URL (optional)
          <Input
            data-testid="agent-grok-switch-base-url"
            value={baseUrl}
            placeholder="https://gateway.example/v1"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <span className="text-muted-foreground">
            Sets GROK_XAI_API_BASE_URL. The page cannot read the Codex base URL, because plain-text values are hidden.
          </span>
        </label>
      ) : null}
      {plan.ok ? (
        <>
          <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
            {plan.changes.map((change) => <li key={change}>{change}</li>)}
            {plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          <Button
            type="button"
            size="sm"
            data-testid="agent-grok-switch-apply"
            disabled={apply.isPending}
            onClick={() => apply.mutate()}
          >
            {apply.isPending ? "Switching…" : "Switch to Grok Build"}
          </Button>
        </>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="agent-grok-switch-blocked">{plan.message}</p>
      )}
    </section>
  );
}
