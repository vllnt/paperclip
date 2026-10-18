// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Not `new URL(..., import.meta.url)`: under jsdom the global URL is jsdom's, which fileURLToPath rejects.
const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../index.html"), "utf8");

/** Reads the inline script that ships in `index.html`, using a real HTML parser. Parsing does not run it. */
function readBootScript(): string {
  const source = Array.from(new DOMParser().parseFromString(html, "text/html").querySelectorAll("script"))
    .map((script) => script.textContent ?? "")
    .find((inline) => inline.includes("paperclip.theme"));
  if (!source) throw new Error("ui/index.html has no theme boot script");
  return source;
}

const bootScript = readBootScript();

type Storage = "unset" | "light" | "dark" | "junk" | "blocked";
type Os = "dark" | "light" | "no-matchMedia" | "matchMedia-throws";

interface Painted {
  dark: boolean;
  colorScheme: string;
  themeColor: string;
}

/** Runs the real inline script from `index.html` against a minimal browser stand-in. */
function boot(storage: Storage, os: Os): Painted {
  const classes = new Set<string>();
  const meta = { content: "" };
  const root = {
    classList: {
      toggle(name: string, force?: boolean): boolean {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      add(name: string): void {
        classes.add(name);
      },
    },
    style: { colorScheme: "" },
  };
  const fakeDocument = {
    documentElement: root,
    querySelector: () => ({
      setAttribute(name: string, value: string): void {
        if (name === "content") meta.content = value;
      },
    }),
  };
  const fakeWindow = {
    localStorage: {
      getItem(): string | null {
        if (storage === "blocked") throw new Error("SecurityError: storage is blocked");
        return storage === "unset" ? null : storage;
      },
    },
    ...(os === "no-matchMedia"
      ? {}
      : {
          matchMedia(): { matches: boolean } {
            if (os === "matchMedia-throws") throw new Error("matchMedia failed");
            return { matches: os === "dark" };
          },
        }),
  };

  new Function("window", "document", bootScript)(fakeWindow, fakeDocument);
  return { dark: classes.has("dark"), colorScheme: root.style.colorScheme, themeColor: meta.content };
}

/**
 * What `ThemeContext` resolves for the same inputs: an explicit `light` or
 * `dark` wins; anything else (unset, junk, unreadable) follows the OS; an OS
 * with no readable preference is light.
 */
function expectedDark(storage: Storage, os: Os): boolean {
  if (storage === "light") return false;
  if (storage === "dark") return true;
  return os === "dark";
}

describe("theme boot script in index.html", () => {
  const storages: Storage[] = ["unset", "light", "dark", "junk", "blocked"];
  const systems: Os[] = ["dark", "light", "no-matchMedia", "matchMedia-throws"];

  for (const storage of storages) {
    for (const os of systems) {
      it(`paints ${expectedDark(storage, os) ? "dark" : "light"} with ${storage} storage and OS ${os}`, () => {
        const dark = expectedDark(storage, os);
        expect(boot(storage, os)).toEqual({
          dark,
          colorScheme: dark ? "dark" : "light",
          themeColor: dark ? "#000000" : "#ffffff",
        });
      });
    }
  }
});
