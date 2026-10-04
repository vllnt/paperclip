import { Field } from "@/components/agent-config-primitives";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  aiConnectionProblem,
  aiMethodLabel,
  bindingProblem,
  matchesAiRequirement,
  personalAiDefault,
  type AiConnectionBinding,
  type AiConnectionRequirement,
  type AiConnectionSummary,
} from "./model";

export interface AiConnectionPickerProps {
  requirement: AiConnectionRequirement;
  connections: AiConnectionSummary[];
  value?: AiConnectionBinding;
  currentUserId: string;
  agentId: string;
  agentName: string;
  loading?: boolean;
  error?: string;
  readOnly?: boolean;
  unmanaged?: boolean;
  onChange: (binding: AiConnectionBinding) => void;
  onConnect: () => void;
  onRetry?: () => void;
}

export function AiConnectionPicker({
  requirement,
  connections,
  value,
  currentUserId,
  agentId,
  loading,
  error,
  readOnly,
  unmanaged,
  onChange,
  onConnect,
  onRetry,
}: AiConnectionPickerProps) {
  const compatible = connections.filter((connection) =>
    matchesAiRequirement(connection, requirement),
  );
  const personalDefault = personalAiDefault(
    connections,
    requirement,
    currentUserId,
  );
  const shared = compatible.filter(
    (connection) => connection.ownership === "shared",
  );
  const problem = value
    ? bindingProblem(value, requirement, connections, currentUserId, agentId)
    : undefined;
  const selectedId =
    value?.mode === "responsible_user" ? "responsible_user" : value?.grantId;
  const selected = compatible.find(
    (connection) => connection.grantId === selectedId,
  );
  return (
    <section className="space-y-2" aria-label="Provider connection">
      <Field label="Provider">
        <Select
          value={selectedId ?? ""}
          disabled={readOnly || loading || Boolean(error)}
          onValueChange={(id) => {
            if (id === "connect") {
              onConnect();
              return;
            }
            if (id === "responsible_user") {
              onChange({
                provider: requirement.provider,
                method:
                  personalDefault?.method ??
                  requirement.method ??
                  (requirement.provider === "openrouter"
                    ? "api_key"
                    : "subscription"),
                mode: "responsible_user",
              });
              return;
            }
            const connection = shared.find((item) => item.grantId === id);
            if (connection)
              onChange({
                provider: requirement.provider,
                method: connection.method,
                mode: "shared",
                connectionId: connection.id,
                grantId: connection.grantId,
              });
          }}
        >
          <SelectTrigger aria-label="Provider" className="w-full" size="sm">
            <SelectValue
              placeholder={
                loading
                  ? "Loading providers…"
                  : unmanaged
                    ? "Existing authentication"
                    : "Select provider"
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="responsible_user">
              {personalDefault
                ? `${personalDefault.name} · ${aiMethodLabel(personalDefault.provider, personalDefault.method)} (personal default)`
                : "Responsible user’s default · Not connected"}
            </SelectItem>
            {shared.map((connection) => (
              <SelectItem
                key={connection.grantId}
                value={connection.grantId}
                disabled={Boolean(aiConnectionProblem(connection))}
              >
                {connection.name} ·{" "}
                {aiMethodLabel(connection.provider, connection.method)}
                {aiConnectionProblem(connection) ? " · Unavailable" : ""}
              </SelectItem>
            ))}
            {selectedId &&
              selectedId !== "responsible_user" &&
              !shared.some(
                (connection) => connection.grantId === selectedId,
              ) && (
                <SelectItem value={selectedId} disabled>
                  {selected?.name ?? "Unavailable provider"}
                </SelectItem>
              )}
            {!readOnly && (
              <>
                <SelectSeparator />
                <SelectItem value="connect">
                  Connect another account…
                </SelectItem>
              </>
            )}
          </SelectContent>
        </Select>
      </Field>
      {value?.mode === "responsible_user" && !problem && (
        <p className="text-xs text-muted-foreground">
          Each person’s tasks use their own default account.
        </p>
      )}
      {problem && (
        <p role="status" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      {error && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
          {onRetry && (
            <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
