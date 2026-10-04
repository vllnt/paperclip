import { useEffect, useRef, useState } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import {
  gatewayApi,
  type ProviderConnection,
  isGatewayConnection,
  type GatewayTestResult,
} from "./api.js";
import { ModelBrowser, Status } from "./models.js";
import { button, card, muted, names, row, stack } from "./styles.js";

export function SavedProvider({
  companyId,
  connection,
  onReconnect,
  onChanged,
}: {
  companyId: string;
  connection: ProviderConnection;
  onReconnect?: () => void;
  onChanged: () => Promise<void>;
}) {
  const api = gatewayApi(companyId);
  const navigation = useHostNavigation();
  const [canDisconnect, setCanDisconnect] = useState(false);
  const [capabilityError, setCapabilityError] = useState("");
  const [result, setResult] = useState<GatewayTestResult>();
  const [model, setModel] = useState("");
  const [testError, setTestError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState<"test" | "disconnect" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const disconnected = connection.status === "revoked";
  const gateway = isGatewayConnection(connection);
  useEffect(() => {
    const abort = new AbortController();
    setResult(undefined);
    setModel("");
    setTestError("");
    setCanDisconnect(false);
    api
      .grantCapabilities(connection.id, abort.signal)
      .then((data) => {
        setCanDisconnect(
          Boolean(
            data.grants.find((grant) => grant.id === connection.grantId)
              ?.capabilities?.canRevoke,
          ),
        );
        setCapabilityError("");
      })
      .catch((error) => {
        if (!abort.signal.aborted) setCapabilityError(error.message);
      });
    return () => {
      abort.abort();
      controller.current?.abort();
    };
  }, [connection.id, connection.grantId, connection.status]);
  async function test(testModel?: string) {
    const abort = new AbortController();
    controller.current = abort;
    setConfirm(false);
    setBusy("test");
    setTestError("");
    setActionError("");
    try {
      setResult(
        await api.test(
          {
            connectionId: connection.id,
            grantId: connection.grantId,
            ...(testModel ? { testModel } : {}),
          },
          abort.signal,
        ),
      );
    } catch (error) {
      if (!abort.signal.aborted)
        setTestError(
          error instanceof Error
            ? error.message
            : "Could not test the provider.",
        );
    } finally {
      if (!abort.signal.aborted) setBusy(null);
    }
  }
  async function disconnect() {
    setBusy("disconnect");
    setActionError("");
    try {
      await api.disconnect(connection.id, connection.grantId);
      setConfirm(false);
      setResult(undefined);
      await onChanged();
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not disconnect. Refresh before retrying.",
      );
    } finally {
      setBusy(null);
    }
  }
  const status = disconnected
    ? "Disconnected"
    : testError
      ? "Test failed"
      : result
        ? "Test passed"
        : connection.status === "connected"
          ? "Connected"
          : "Needs attention";
  const good =
    !disconnected &&
    !testError &&
    (Boolean(result) || connection.status === "connected");
  return (
    <article style={card} aria-label={connection.name}>
      <div style={{ ...row, justifyContent: "space-between" }}>
        <strong>{connection.name}</strong>
        <Status good={good}>{status}</Status>
      </div>
      <div style={muted}>
        {names[connection.provider]} ·{" "}
        {connection.method === "subscription" ? "Subscription" : "API key"} ·{" "}
        {connection.ownership === "shared" ? "Company shared" : "Personal"}
      </div>
      <div
        style={{
          ...muted,
          fontFamily: "var(--font-mono)",
          overflowWrap: "anywhere",
        }}
      >
        {connection.gateway?.baseUrl ??
          connection.accountLabel ??
          (connection.isDefault ? "Your default account" : "")}
      </div>
      <div style={row}>
        {gateway && (
          <button
            style={button}
            disabled={Boolean(busy) || disconnected}
            onClick={() => void test()}
          >
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
        )}
        {onReconnect ? (
          <button
            style={button}
            disabled={Boolean(busy)}
            onClick={() => {
              setConfirm(false);
              onReconnect();
            }}
          >
            Reconnect
          </button>
        ) : (
          <a
            style={button}
            {...navigation.linkProps(
              `/apps/${encodeURIComponent(connection.id)}/permissions`,
            )}
          >
            Manage account
          </a>
        )}
        {gateway && (
          <a
            style={button}
            {...navigation.linkProps(
              `/apps/${encodeURIComponent(connection.id)}/permissions`,
            )}
          >
            Access
          </a>
        )}
        {canDisconnect && !disconnected && (
          <button
            style={{ ...button, color: "var(--destructive)" }}
            disabled={Boolean(busy)}
            onClick={() => {
              setConfirm(true);
              setActionError("");
            }}
          >
            Disconnect
          </button>
        )}
      </div>
      {connection.unavailableReason && (
        <p role="status" style={{ ...muted, color: "var(--destructive)" }}>
          {connection.unavailableReason}
        </p>
      )}
      {capabilityError && (
        <p role="alert" style={muted}>
          Could not load disconnect permissions. Refresh the page to retry.
        </p>
      )}
      {(testError || actionError) && (
        <p role="alert" style={{ color: "var(--destructive)" }}>
          {testError || actionError}
        </p>
      )}
      {confirm && (
        <div
          role="group"
          aria-label={`Disconnect ${connection.name}`}
          style={stack}
        >
          <p>
            Disconnect this provider? Agents using it will need another
            connection. Running tasks keep their current credentials.
          </p>
          <div style={{ ...row, justifyContent: "space-between" }}>
            <button
              style={button}
              disabled={Boolean(busy)}
              onClick={() => setConfirm(false)}
            >
              Keep connected
            </button>
            <button
              style={{ ...button, color: "var(--destructive)" }}
              disabled={Boolean(busy)}
              onClick={() => void disconnect()}
            >
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect provider"}
            </button>
          </div>
        </div>
      )}
      {result && !disconnected && (
        <details open>
          <summary style={{ cursor: "pointer", ...muted }}>
            Last successful test:{" "}
            {new Date(result.checkedAt).toLocaleTimeString()} ·{" "}
            {result.testedModel
              ? `${result.testedModel} responded`
              : `${result.models.length} models available`}
          </summary>
          <div style={{ ...stack, paddingTop: "calc(var(--spacing) * 4)" }}>
            <ModelBrowser
              models={result.models}
              selected={model}
              onSelect={setModel}
              busy={Boolean(busy)}
            />
            <div style={row}>
              <button
                style={button}
                disabled={Boolean(busy) || !model}
                onClick={() => void test(model)}
              >
                Test model
              </button>
              <span style={muted}>
                Sends a short prompt. Agent settings stay as configured.
              </span>
            </div>
          </div>
        </details>
      )}
    </article>
  );
}
