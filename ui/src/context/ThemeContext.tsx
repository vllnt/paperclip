import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

type Theme = "light" | "dark";

/** What the user picked: follow the operating system, or pin light or dark. */
export type ThemePreference = "system" | Theme;

interface ThemeContextValue {
  /** The user's choice. `system` is the default and is never written to storage. */
  preference: ThemePreference;
  /** The theme actually painted: the preference, or the OS theme when it is `system`. */
  theme: Theme;
  setPreference: (preference: ThemePreference) => void;
  /** Pins an explicit theme. Shorthand for `setPreference` with a non-system value. */
  setTheme: (theme: Theme) => void;
  /** Pins the opposite of the theme currently painted. */
  toggleTheme: () => void;
}

const THEME_STORAGE_KEY = "paperclip.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const DARK_THEME_COLOR = "#000000";
const LIGHT_THEME_COLOR = "#ffffff";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/**
 * What `system` resolves to when the OS preference cannot be read. It is the
 * value the boot script in `index.html` paints in the same situation, so a
 * reload and a live switch to `system` agree.
 */
const UNREADABLE_SYSTEM_THEME: Theme = "light";

/**
 * The OS color-scheme query, or null when `matchMedia` is missing or throws
 * (some embedded webviews). Every `matchMedia` call in this module goes
 * through here.
 */
function systemMediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(DARK_QUERY);
  } catch {
    return null;
  }
}

function readSystemTheme(): Theme {
  try {
    const query = systemMediaQuery();
    if (!query) return UNREADABLE_SYSTEM_THEME;
    return query.matches ? "dark" : "light";
  } catch {
    return UNREADABLE_SYSTEM_THEME;
  }
}

/**
 * Calls `onChange` when the OS theme changes and returns the unsubscribe.
 * Uses `addEventListener`, or `addListener` on older query lists. It does
 * nothing, and its unsubscribe does nothing, when the query cannot be read or
 * when subscribing or unsubscribing throws.
 */
function subscribeToSystemTheme(onChange: (theme: Theme) => void): () => void {
  const query = systemMediaQuery();
  if (!query) return () => undefined;
  const handleChange = (event: MediaQueryListEvent): void => {
    onChange(event.matches ? "dark" : "light");
  };
  const modern = typeof query.addEventListener === "function";
  try {
    if (modern) query.addEventListener("change", handleChange);
    else query.addListener(handleChange);
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      if (modern) query.removeEventListener("change", handleChange);
      else query.removeListener(handleChange);
    } catch {
      return;
    }
  };
}

/**
 * Reads the stored choice. Anything other than an explicit `light` or `dark`,
 * including a missing key or unavailable storage, means `system`.
 */
function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * Persists the choice. `system` removes the key so an unset browser and a
 * system-following browser look identical to the boot script in `index.html`.
 * Storage can be unavailable (private mode, sandboxed frames); a failed write
 * is not an error because the theme still applies for the session.
 */
function writeStoredPreference(preference: ThemePreference): void {
  if (typeof window === "undefined") return;
  try {
    if (preference === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    return;
  }
}

function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const isDark = theme === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta instanceof HTMLMetaElement) {
    themeColorMeta.setAttribute("content", isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
  }
}

/**
 * Owns the theme preference. The boot script in `index.html` has already put
 * the right class on `<html>` before first paint; this provider keeps it in
 * sync afterwards, follows OS changes while the preference is `system`, and
 * mirrors a preference changed in another tab.
 */
export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [systemTheme, setSystemTheme] = useState<Theme>(readSystemTheme);
  const theme = preference === "system" ? systemTheme : preference;

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    writeStoredPreference(next);
    if (next === "system") setSystemTheme(readSystemTheme());
  }, []);

  const toggleTheme = useCallback(() => {
    setPreference(theme === "dark" ? "light" : "dark");
  }, [theme, setPreference]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (preference !== "system") return;
    return subscribeToSystemTheme(setSystemTheme);
  }, [preference]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleStorage = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
      setPreferenceState(readStoredPreference());
      setSystemTheme(readSystemTheme());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const value = useMemo(
    () => ({
      preference,
      theme,
      setPreference,
      setTheme: setPreference,
      toggleTheme,
    }),
    [preference, theme, setPreference, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Reads the theme state. Throws outside {@link ThemeProvider}. */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
