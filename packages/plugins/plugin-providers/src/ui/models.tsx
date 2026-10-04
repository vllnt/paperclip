import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { control, field, muted, row, stack } from "./styles.js";

export function Status({
  good,
  children,
}: {
  good: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className="status-chip"
      style={
        {
          "--sc": good
            ? "var(--status-task-done)"
            : "var(--status-task-blocked)",
          borderRadius: "var(--radius-sm)",
          padding: "calc(var(--spacing) * 1) calc(var(--spacing) * 2)",
          fontSize: "var(--text-xs)",
          fontWeight: "var(--font-weight-medium)",
        } as CSSProperties
      }
    >
      {good ? "✓ " : "● "}
      {children}
    </span>
  );
}

export function ModelBrowser({
  models,
  selected,
  onSelect,
  busy,
}: {
  models: string[];
  selected: string;
  onSelect: (model: string) => void;
  busy: boolean;
}) {
  const [filter, setFilter] = useState("");
  const id = useId();
  const visible = models.filter((model) =>
    model.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <div style={stack} aria-label="Available models">
      <div style={{ ...row, justifyContent: "space-between" }}>
        <strong>Available models ({models.length})</strong>
        {filter && <span style={muted}>{visible.length} matches</span>}
      </div>
      <label style={field}>
        Search models
        <input
          type="search"
          style={control}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by model name"
        />
      </label>
      <div
        style={{ maxHeight: "var(--sz-300px)", overflowY: "auto", ...field }}
        role="group"
        aria-label="Choose a model"
      >
        {visible.map((model) => (
          <label
            key={model}
            style={{
              ...row,
              ...control,
              cursor: busy ? "default" : "pointer",
              background: selected === model ? "var(--accent)" : undefined,
            }}
          >
            <input
              type="radio"
              name={id}
              checked={selected === model}
              disabled={busy}
              onChange={() => onSelect(model)}
            />
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-sm)",
                overflowWrap: "anywhere",
              }}
            >
              {model}
            </span>
          </label>
        ))}
        {!visible.length && <p style={muted}>No matching models.</p>}
      </div>
    </div>
  );
}
