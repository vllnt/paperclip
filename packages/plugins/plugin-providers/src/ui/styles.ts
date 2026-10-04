import type { CSSProperties } from "react";

export const stack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "calc(var(--spacing) * 4)",
};
export const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "calc(var(--spacing) * 2)",
  flexWrap: "wrap",
};
export const field: CSSProperties = {
  ...stack,
  gap: "calc(var(--spacing) * 2)",
};
export const control: CSSProperties = {
  padding: "calc(var(--spacing) * 2) calc(var(--spacing) * 3)",
  border: "var(--border-width-default, thin) solid var(--border)",
  borderRadius: "var(--radius-md)",
  color: "var(--foreground)",
  background: "var(--background)",
  font: "inherit",
  minWidth: 0,
};
export const button: CSSProperties = {
  ...control,
  cursor: "pointer",
  fontSize: "var(--text-sm)",
};
export const primary: CSSProperties = {
  ...button,
  background: "var(--primary)",
  color: "var(--primary-foreground)",
};
export const muted: CSSProperties = {
  color: "var(--muted-foreground)",
  fontSize: "var(--text-sm)",
};
export const card: CSSProperties = {
  ...stack,
  padding: "calc(var(--spacing) * 4)",
  border: "var(--border-width-default, thin) solid var(--border)",
  borderRadius: "var(--radius-lg)",
};
export const heading: CSSProperties = {
  fontSize: "var(--text-lg)",
  fontWeight: "var(--font-weight-semibold)",
};
export const names = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  xai: "Grok",
};
