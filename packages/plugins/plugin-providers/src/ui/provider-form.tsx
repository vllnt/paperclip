import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  gatewayApi,
  agentHarnessProvider,
  type Agent,
  type GatewayConnection,
  type GatewayTestResult,
  type Provider,
} from "./api.js";
import { ModelBrowser, Status } from "./models.js";
import {
  button,
  card,
  control,
  field,
  heading,
  muted,
  names,
  primary,
  row,
  stack,
} from "./styles.js";

export function ProviderForm({
  companyId,
  agents,
  requestedAgentId,
  connection,
  onClose,
  onSaved,
}: {
  companyId: string;
  agents: Agent[];
  requestedAgentId: string;
  connection?: GatewayConnection;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const api = gatewayApi(companyId);
  const selectedAgent = agents.find((agent) => agent.id === requestedAgentId);
  const [provider, setProvider] = useState<Provider>(
    connection?.provider ??
      (selectedAgent && agentHarnessProvider(selectedAgent)) ??
      "openai",
  );
  const [name, setName] = useState(connection?.name ?? "My API provider");
  const [baseUrl, setBaseUrl] = useState(connection?.gateway?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [allAgents, setAllAgents] = useState(!requestedAgentId);
  const [agentIds, setAgentIds] = useState(
    selectedAgent ? [selectedAgent.id] : [],
  );
  const [result, setResult] = useState<GatewayTestResult>();
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
    return () => controller.current?.abort();
  }, []);
  function invalidate() {
    setResult(undefined);
    setError("");
    setModel("");
  }
  async function test(testModel?: string) {
    const abort = new AbortController();
    controller.current = abort;
    setBusy("test");
    setError("");
    try {
      setResult(
        await api.test(
          {
            provider,
            gateway: { baseUrl },
            apiKey,
            ...(testModel ? { testModel } : {}),
          },
          abort.signal,
        ),
      );
    } catch (error) {
      if (!abort.signal.aborted) {
        setResult(undefined);
        setError(
          error instanceof Error
            ? error.message
            : "Could not test the provider.",
        );
      }
    } finally {
      if (!abort.signal.aborted) setBusy(null);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy("save");
    setError("");
    setResult(undefined);
    let saved = false;
    try {
      await api.connect({
        name: name.trim(),
        provider,
        gateway: { baseUrl },
        apiKey,
        testModel: model,
        allAgents,
        agentIds,
        ...(connection
          ? { connectionId: connection.id, ownership: connection.ownership }
          : {}),
      });
      saved = true;
      await onSaved();
      onClose();
    } catch (error) {
      setError(
        saved
          ? "Provider saved, but the list could not refresh. Reload the page before making changes."
          : error instanceof Error
            ? error.message
            : "Could not save the provider. Refresh before retrying.",
      );
    } finally {
      setApiKey("");
      setBusy(null);
    }
  }
  return (
    <form
      onSubmit={(event) => void save(event)}
      style={card}
      aria-label={connection ? "Reconnect provider" : "Add provider"}
    >
      <h2 ref={title} tabIndex={-1} style={heading}>
        {connection ? `Reconnect ${connection.name}` : "Add provider"}
      </h2>
      <fieldset
        disabled={Boolean(busy)}
        style={{ ...stack, border: "none", margin: 0, padding: 0 }}
      >
        {!connection && (
          <div style={{ ...row, alignItems: "stretch" }}>
            <label style={{ ...field, flex: 1 }}>
              Name
              <input
                style={control}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label style={{ ...field, flex: 1 }}>
              API format
              <select
                style={control}
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value as Provider);
                  invalidate();
                }}
              >
                <option value="openai">OpenAI (Responses)</option>
                <option value="anthropic">Anthropic (Messages)</option>
              </select>
            </label>
          </div>
        )}
        <label style={field}>
          API URL
          <input
            style={control}
            type="url"
            value={baseUrl}
            disabled={Boolean(connection)}
            placeholder="https://proxy.example.com/v1"
            required
            onChange={(event) => {
              setBaseUrl(event.target.value);
              invalidate();
            }}
          />
        </label>
        <label style={field}>
          {connection ? "New API key" : "API key"}
          <input
            style={control}
            type="password"
            autoComplete="new-password"
            required
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              invalidate();
            }}
          />
        </label>
        <div style={row}>
          <button
            type="button"
            style={button}
            disabled={!baseUrl.trim() || !apiKey.trim()}
            onClick={() => void test()}
          >
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          <span style={muted}>
            Checks access and lists models. Nothing is saved.
          </span>
        </div>
        {error && (
          <p role="alert" style={{ color: "var(--destructive)" }}>
            <Status good={false}>Test or save failed</Status> {error}
          </p>
        )}
        {result && (
          <div role="status" style={row}>
            <Status good>
              {result.testedModel
                ? "Model test passed"
                : "Connection test passed"}
            </Status>
            <span style={muted}>
              {result.testedModel ?? `${result.models.length} models found`}
            </span>
          </div>
        )}
        {result && (
          <ModelBrowser
            models={result.models}
            selected={model}
            onSelect={setModel}
            busy={Boolean(busy)}
          />
        )}
        <label style={field}>
          Model to test
          <input
            style={{ ...control, fontFamily: "var(--font-mono)" }}
            value={model}
            placeholder="Choose above or enter a model ID"
            required
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <div style={row}>
          <button
            type="button"
            style={button}
            disabled={!apiKey.trim() || !baseUrl.trim() || !model.trim()}
            onClick={() => void test(model)}
          >
            Test model
          </button>
          <span style={muted}>
            Model tests and saving send a short prompt through {names[provider]}
            .
          </span>
        </div>
        {!connection && (
          <details>
            <summary style={{ cursor: "pointer", fontSize: "var(--text-sm)" }}>
              Agent access ·{" "}
              {allAgents ? "All agents" : `${agentIds.length} selected`}
            </summary>
            <div style={{ ...stack, paddingTop: "calc(var(--spacing) * 3)" }}>
              <label style={row}>
                <input
                  type="checkbox"
                  checked={allAgents}
                  onChange={(event) => setAllAgents(event.target.checked)}
                />
                Available to all company agents
              </label>
              {!allAgents &&
                agents.map((agent) => (
                  <label style={row} key={agent.id}>
                    <input
                      type="checkbox"
                      checked={agentIds.includes(agent.id)}
                      onChange={(event) =>
                        setAgentIds((ids) =>
                          event.target.checked
                            ? [...ids, agent.id]
                            : ids.filter((id) => id !== agent.id),
                        )
                      }
                    />
                    {agent.name}
                  </label>
                ))}
              {!allAgents && !agents.length && (
                <p style={muted}>
                  No agents yet. Grant access later from the provider’s Access
                  settings.
                </p>
              )}
            </div>
          </details>
        )}
        <div style={{ ...row, justifyContent: "space-between" }}>
          <button type="button" style={button} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            style={primary}
            disabled={
              !apiKey.trim() || !baseUrl.trim() || !model.trim() || !name.trim()
            }
          >
            {busy === "save"
              ? "Saving…"
              : connection
                ? "Save new key"
                : "Save provider"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
