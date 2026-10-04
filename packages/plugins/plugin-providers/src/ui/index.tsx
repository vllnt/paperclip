import { useEffect, useState } from "react";
import {
  useHostContext,
  useHostNavigation,
  useHostLocation,
} from "@paperclipai/plugin-sdk/ui";
import { ProviderForm } from "./provider-form.js";
import { SavedProvider } from "./saved-provider.js";
import {
  gatewayApi,
  isGatewayConnection,
  type ProviderConnection,
  type GatewayConnection,
  type Agent,
} from "./api.js";
import { button, heading, muted, primary, row, stack } from "./styles.js";

export function ProvidersPage() {
  const { companyId } = useHostContext();
  const location = useHostLocation();
  const params = new URLSearchParams(location.search);
  const agentId = params.get("agentId") ?? "";
  if (!companyId) return <p>Select a company to configure providers.</p>;
  return (
    <Settings
      key={`${companyId}:${agentId}`}
      companyId={companyId}
      requestedAgentId={agentId}
    />
  );
}
function Settings({
  companyId,
  requestedAgentId,
}: {
  companyId: string;
  requestedAgentId: string;
}) {
  const navigation = useHostNavigation();
  const api = gatewayApi(companyId);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<"new" | GatewayConnection | null>(
    requestedAgentId ? "new" : null,
  );
  useEffect(() => {
    const abort = new AbortController();
    Promise.all([api.list(abort.signal), api.agents(abort.signal)])
      .then(([data, agents]) => {
        setConnections(data.connections);
        setAgents(agents);
        setLoading(false);
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          setError(error.message);
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [companyId]);
  async function refresh() {
    try {
      setConnections((await api.list()).connections);
      setError("");
    } catch (error) {
      setError(
        "Could not refresh providers. Reload the page before retrying an action.",
      );
      throw error;
    }
  }
  const agent = agents.find((agent) => agent.id === requestedAgentId);
  return (
    <section
      style={{
        ...stack,
        maxWidth: "var(--container-3xl)",
        padding: "calc(var(--spacing) * 4)",
      }}
      aria-label="Provider settings"
    >
      <header style={{ ...row, justifyContent: "space-between" }}>
        <div style={stack}>
          <h1
            style={{
              fontSize: "var(--text-2xl)",
              fontWeight: "var(--font-weight-semibold)",
            }}
          >
            Providers
          </h1>
          <p style={muted}>Manage API and subscription connections.</p>
        </div>
        {!editor && (
          <button
            style={primary}
            disabled={loading || Boolean(error)}
            onClick={() => setEditor("new")}
          >
            Add API provider
          </button>
        )}
      </header>
      <a
        style={{ ...muted, alignSelf: "flex-start" }}
        {...navigation.linkProps("/apps/connect")}
      >
        Connect a subscription or account
      </a>
      {agent && (
        <p style={muted}>
          Configuring providers for {agent.name}.{" "}
          <a
            {...navigation.linkProps(
              `/agents/${encodeURIComponent(agent.id)}/runtime`,
            )}
          >
            Back to agent
          </a>
        </p>
      )}
      {loading && <p role="status">Loading providers…</p>}
      {error && (
        <p role="alert" style={{ color: "var(--destructive)" }}>
          {error}
        </p>
      )}
      <>
        {editor && !loading && (
          <ProviderForm
            key={typeof editor === "string" ? "new" : editor.id}
            companyId={companyId}
            agents={agents}
            requestedAgentId={requestedAgentId}
            connection={typeof editor === "string" ? undefined : editor}
            onClose={() => setEditor(null)}
            onSaved={refresh}
          />
        )}
        <section aria-label="Saved providers" style={stack}>
          <h2 style={heading}>
            Saved providers
            {connections.length ? ` (${connections.length})` : ""}
          </h2>
          {!loading && !error && !connections.length && (
            <p style={muted}>
              No providers yet. Add an API connection or connect an account.
            </p>
          )}
          {connections.map((connection) => (
            <SavedProvider
              key={`${connection.id}:${connection.grantId}`}
              companyId={companyId}
              connection={connection}
              onReconnect={
                isGatewayConnection(connection)
                  ? () => setEditor(connection)
                  : undefined
              }
              onChanged={refresh}
            />
          ))}
        </section>
      </>
    </section>
  );
}

export function ProvidersSidebar() {
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const active = location.pathname === navigation.resolveHref("/providers");
  return (
    <a
      {...navigation.linkProps("/providers")}
      aria-current={active ? "page" : undefined}
      style={{
        ...row,
        padding: "calc(var(--spacing) * 2) calc(var(--spacing) * 3)",
        color: "var(--sidebar-foreground)",
        background: active ? "var(--sidebar-accent)" : undefined,
        borderRadius: "var(--radius-md)",
        fontSize: "var(--text-sm)",
        textDecoration: "none",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        style={{
          width: "calc(var(--spacing) * 4)",
          height: "calc(var(--spacing) * 4)",
        }}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M7 3v5m10-5v5M5 8h14v3a7 7 0 0 1-14 0V8Zm7 10v3" />
      </svg>
      Providers
    </a>
  );
}

export function AgentProvidersLink({
  context,
}: {
  context: { entityId?: string | null };
}) {
  const navigation = useHostNavigation();
  if (!context.entityId) return null;
  return (
    <a
      style={button}
      {...navigation.linkProps(
        `/providers?agentId=${encodeURIComponent(context.entityId)}`,
      )}
    >
      Manage providers
    </a>
  );
}
