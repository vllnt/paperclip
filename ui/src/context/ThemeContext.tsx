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

function readDocumentTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function readSystemTheme(): Theme {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  }
  return readDocumentTheme();
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
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(DARK_QUERY);
    const handleChange = (event: MediaQueryListEvent): void => {
      setSystemTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
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
