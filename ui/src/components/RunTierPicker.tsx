import { DEFAULT_RUN_TIER, type CompanyRunTiers } from "@paperclipai/shared";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

/** The harnesses a run tier can apply to. */
export const RUN_TIER_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "grok_local"]);

/** Whether the picker has anything to offer for this assignee and company. */
export function runTiersAvailable(tiers: CompanyRunTiers | null | undefined, assigneeAdapterType: string | null | undefined): boolean {
  return Boolean(tiers && Object.keys(tiers.tiers).length > 0 && assigneeAdapterType && RUN_TIER_ADAPTER_TYPES.has(assigneeAdapterType));
}

/**
 * Picks the company tier an issue runs on. "Agent default" leaves the issue on
 * the assignee's own harness and model.
 */
export function RunTierPicker({
  tiers,
  value,
  onChange,
  agentDefaultLabel,
}: {
  tiers: CompanyRunTiers;
  value: string;
  onChange: (tier: string) => void;
  agentDefaultLabel: string;
}) {
  return (
    <div className="space-y-1.5" data-testid="run-tier-picker">
      <div className="text-xs text-muted-foreground">Run with</div>
      <Select value={value || DEFAULT_RUN_TIER} onValueChange={(next) => onChange(next === DEFAULT_RUN_TIER ? "" : next)}>
        <SelectTrigger aria-label="Run with" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_RUN_TIER}>Agent default · {agentDefaultLabel}</SelectItem>
          {Object.entries(tiers.tiers).map(([name, target]) => (
            <SelectItem key={name} value={name}>
              {name} · {target.adapterType}/{target.model}
              {target.effort ? ` (${target.effort})` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-(length:--text-micro) text-muted-foreground">
        A tier picks the harness and model for this task only. Quota limits fall back to the agent's other targets.
      </p>
    </div>
  );
}
