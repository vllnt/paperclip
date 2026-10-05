import React, { useEffect, useState } from "react";
import { useHostNavigation, type PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { hostApi } from "./api.js";
import { message } from "./errors.js";
import { styles } from "./styles.js";

type ChatEndpoint = {
  id: string;
  provider?: string;
  status?: string;
  assignedAgentId?: string | null;
  assignedAgentName?: string | null;
  botUsername?: string | null;
  botLabel?: string | null;
};

/** Read-only view of Paperclip's native GitHub chat connector for this agent. */
export function GitHubAgentSettings({ context }: PluginDetailTabProps) {
  const companyId = context?.companyId as string | undefined;
  const agentId = context?.entityId as string | undefined;
  const nav = useHostNavigation();
  const [endpoint, setEndpoint] = useState<ChatEndpoint | null>(null);
  const [loading, setLoading] = useState(Boolean(companyId && agentId));
  const [error, setError] = useState("");

  useEffect(() => {
    if (!companyId || !agentId) return;
    let active = true;
    setLoading(true); setError("");
    void hostApi<ChatEndpoint[]>(`/companies/${encodeURIComponent(companyId)}/chat-endpoints`)
      .then(rows => {
        if (!active) return;
        const match = (Array.isArray(rows) ? rows : []).find(row => row.provider === "github" && row.assignedAgentId === agentId);
        setEndpoint(match ?? null);
      })
      .catch(cause => { if (active) setError(message(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [companyId, agentId]);

  if (!companyId || !agentId) return <p className="muted">Select an agent to view its GitHub channel.</p>;
  return <section className="pcg agent-github-settings"><style>{styles}</style>
    <header><h2>GitHub channel</h2><p className="muted">Paperclip’s native GitHub connector for this agent.</p></header>
    <div className="panel">
      {loading && <p role="status" className="muted">Checking channel setup…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {!loading && !error && endpoint && <>
        <div className="connection-status" data-connected={endpoint.status === "active" || endpoint.status === "ready"}>
          {endpoint.status === "active" || endpoint.status === "ready" ? "Connected" : endpoint.status ?? "Needs attention"}
        </div>
        <dl className="record-metadata">
          <div><dt>Bot</dt><dd>{endpoint.botUsername ? `@${endpoint.botUsername}` : endpoint.botLabel ?? "GitHub bot"}</dd></div>
          <div><dt>Status</dt><dd>{endpoint.status ?? "Unknown"}</dd></div>
        </dl>
        <p className="muted">This channel is the official Paperclip GitHub bot identity. It controls chat routing and notifications; it does not replace the plugin’s GitHub App or change who authors API reviews.</p>
        <a className="button" {...nav.linkProps("/settings")}>Open chat settings</a>
      </>}
      {!loading && !error && !endpoint && <>
        <p>No native GitHub channel is assigned to this agent.</p>
        <p className="muted">Set up a GitHub chat channel in Paperclip, assign it to this agent, then return here to verify the bot identity.</p>
        <a className="button primary" {...nav.linkProps("/settings")}>Set up GitHub channel</a>
      </>}
    </div>
  </section>;
}
