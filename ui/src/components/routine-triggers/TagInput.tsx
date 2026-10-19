import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A small token field: type a value and press Enter or comma to add it,
 * Backspace on an empty field removes the last one. Pasted comma-separated
 * lists are split into separate tokens.
 */
export function TagInput({
  id,
  values,
  onChange,
  placeholder,
  ariaLabel,
  ariaDescribedBy,
  invalid = false,
  disabled = false,
}: {
  id?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");

  function commit(raw: string) {
    const additions = raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    setText("");
    if (additions.length === 0) return;
    const next = [...values];
    for (const addition of additions) if (!next.includes(addition)) next.push(addition);
    if (next.length !== values.length) onChange(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      if (text.trim() || event.key === ",") event.preventDefault();
      commit(text);
    } else if (event.key === "Backspace" && text === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border bg-transparent px-2 py-1 shadow-xs focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-(length:--rad-3)",
        invalid ? "border-destructive" : "border-input",
        disabled && "opacity-50",
      )}
    >
      {values.map((value) => (
        <span
          key={value}
          className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
        >
          <span className="truncate font-mono">{value}</span>
          <button
            type="button"
            aria-label={`Remove ${value}`}
            disabled={disabled}
            className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onChange(values.filter((item) => item !== value))}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid || undefined}
        placeholder={values.length === 0 ? placeholder : undefined}
        className="min-w-24 flex-1 bg-transparent py-0.5 text-base outline-none placeholder:text-muted-foreground md:text-sm"
        onChange={(event) => {
          const next = event.target.value;
          if (next.includes(",")) commit(next);
          else setText(next);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => commit(text)}
      />
    </div>
  );
}
