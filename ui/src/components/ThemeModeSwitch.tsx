import { useId, type ReactElement } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTheme, type ThemePreference } from "../context/ThemeContext";

interface ThemeModeOption {
  value: ThemePreference;
  label: string;
  Icon: LucideIcon;
}

const THEME_MODE_OPTIONS: readonly ThemeModeOption[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

interface ThemeModeSwitchProps {
  className?: string;
}

/**
 * System / Light / Dark selector. A native radio group, so arrow keys and
 * screen readers work without extra wiring. Selecting an option applies and
 * persists it immediately; the selected option is the inverted pill
 * (`bg-primary`), which is pure black on white in light mode and pure white on
 * black in dark mode.
 */
export function ThemeModeSwitch({ className }: ThemeModeSwitchProps): ReactElement {
  const { preference, setPreference } = useTheme();
  const groupName = useId();

  return (
    <div
      className={cn(
        "flex h-(--profile-popover-row-height) items-center justify-between gap-(--profile-popover-row-gap) px-2.5",
        className,
      )}
    >
      <span className="min-w-0 truncate text-(length:--text-compact) font-medium text-foreground">Appearance</span>
      <div role="radiogroup" aria-label="Appearance" className="inline-flex items-center gap-0.5 rounded-lg border border-border p-0.5">
        {THEME_MODE_OPTIONS.map(({ value, label, Icon }) => (
          <label
            key={value}
            title={label}
            className="relative flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground has-checked:bg-primary has-checked:text-primary-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"
          >
            <input
              type="radio"
              name={groupName}
              value={value}
              aria-label={label}
              checked={preference === value}
              onChange={() => setPreference(value)}
              className="sr-only"
            />
            <Icon className="size-3.5" aria-hidden="true" />
          </label>
        ))}
      </div>
    </div>
  );
}
