import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brandChipBadge, runningLabelText } from "./lib/status-colors";

const css = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8");

type Declarations = Map<string, string>;

function declarationsFor(selectorPattern: string): Declarations {
  const result: Declarations = new Map();
  const blockRe = new RegExp(`(?<!,)(?:^|\\n)${selectorPattern}\\s*\\{([^{}]*)\\}`, "g");
  for (const block of css.matchAll(blockRe)) {
    const body = block[1].replace(/\/\*[\s\S]*?\*\//g, "");
    for (const declaration of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      result.set(declaration[1], declaration[2].trim());
    }
  }
  return result;
}

const light = declarationsFor(":root");
const dark = declarationsFor("\\.dark");
const shared = declarationsFor(":root,\\s*\\.dark");

function percent(value: string | undefined): number {
  const match = /([\d.]+)%/.exec(value ?? "");
  if (!match) throw new Error(`no percentage in ${value}`);
  return Number(match[1]) / 100;
}

type Rgb = readonly [number, number, number];

function channel(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminanceRgb([red, green, blue]: Rgb): number {
  return 0.2126 * channel(red / 255) + 0.7152 * channel(green / 255) + 0.0722 * channel(blue / 255);
}

function contrastRgb(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminanceRgb(a), luminanceRgb(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function grey(level: number): Rgb {
  return [level, level, level];
}

function contrast(a: number, b: number): number {
  return contrastRgb(grey(a), grey(b));
}

function over(foreground: number, alpha: number, background: number): number {
  return background + (foreground - background) * alpha;
}

function overRgb(foreground: Rgb, alpha: number, background: Rgb): Rgb {
  return [
    over(foreground[0], alpha, background[0]),
    over(foreground[1], alpha, background[1]),
    over(foreground[2], alpha, background[2]),
  ];
}

/** Reads `#rrggbb` or `#rrggbbaa`. */
function parseHex(hex: string): { rgb: Rgb; alpha: number } {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(hex);
  if (!match) throw new Error(`not a hex colour: ${hex}`);
  const [red, green, blue] = [match[1], match[2], match[3]].map((part) => parseInt(part, 16));
  return { rgb: [red, green, blue], alpha: match[4] ? parseInt(match[4], 16) / 255 : 1 };
}

/** Finds the arbitrary-hex utility `<prefix>-[#hex]` in a class list, e.g. `dark:text`. */
function hexUtility(classes: string, prefix: string): string {
  const match = new RegExp(`(?:^|\\s)${prefix}-\\[(#[0-9a-f]{6}(?:[0-9a-f]{2})?)\\]`, "i").exec(classes);
  if (!match) throw new Error(`no ${prefix}-[#hex] in "${classes}"`);
  return match[1];
}

const MODES = [
  { name: "light", own: light, background: 255, foreground: 0 },
  { name: "dark", own: dark, background: 0, foreground: 255 },
] as const;

describe("black-and-white theme tokens", () => {
  it("uses pure surfaces and pure ink", () => {
    expect(light.get("--background")).toBe("oklch(1 0 0)");
    expect(light.get("--foreground")).toBe("oklch(0 0 0)");
    expect(dark.get("--background")).toBe("oklch(0 0 0)");
    expect(dark.get("--foreground")).toBe("oklch(1 0 0)");
  });

  it("makes cards, popovers and the sidebar the same surface as the page", () => {
    for (const token of ["--card", "--popover", "--sidebar"]) {
      expect(shared.get(token), token).toBe("var(--background)");
    }
  });

  it("builds hover and selected fills from the foreground, never a grey value", () => {
    for (const token of ["--accent", "--muted", "--secondary", "--sidebar-accent"]) {
      expect(shared.get(token), token).toBe("color-mix(in srgb, var(--foreground) var(--fill-strength), var(--background))");
    }
  });

  it("uses the inverted pill for primary actions", () => {
    expect(shared.get("--primary")).toBe("var(--foreground)");
    expect(shared.get("--primary-foreground")).toBe("var(--background)");
  });

  it("keeps a state-free border and input ladder derived from the foreground", () => {
    expect(shared.get("--border")).toContain("var(--foreground) var(--border-strength), transparent");
    expect(shared.get("--input")).toContain("var(--foreground) var(--input-strength), transparent");
  });

  for (const { name, own, background, foreground } of MODES) {
    describe(`${name} mode contrast`, () => {
      const fill = over(foreground, percent(own.get("--fill-strength")), background);
      const secondaryText = percent(shared.get("--muted-foreground"));
      const neutralInk = percent(shared.get("--status-neutral"));

      it("keeps secondary text at AA on the page and on a hover fill", () => {
        expect(contrast(over(foreground, secondaryText, background), background)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(over(foreground, secondaryText, fill), fill)).toBeGreaterThanOrEqual(4.5);
      });

      it("keeps neutral status text (Cancelled, Backlog) at AA on the page and on a hover fill", () => {
        // `--status-neutral` is an opaque mix against the page, so it is the same ink on a fill.
        const ink = over(foreground, neutralInk, background);
        expect(contrast(ink, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(ink, fill)).toBeGreaterThanOrEqual(4.5);
      });

      it("keeps every brand status chip at AA, on the page and on a hover fill", () => {
        const surfaces = { page: grey(background), "hover fill": grey(fill) };
        const chips = Object.entries(brandChipBadge).filter(([, classes]) => classes.includes("[#"));
        expect(chips.length).toBeGreaterThan(0);
        for (const [color, classes] of chips) {
          const dark = name === "dark";
          const text = parseHex(hexUtility(classes, dark ? "dark:text" : "text")).rgb;
          const chipFill = parseHex(hexUtility(classes, dark ? "dark:bg" : "bg"));
          for (const [surface, behind] of Object.entries(surfaces)) {
            const chipBackground = overRgb(chipFill.rgb, chipFill.alpha, behind);
            expect(contrastRgb(text, chipBackground), `${color} chip on ${surface}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      it("keeps the Running label text at AA on the page and on a hover fill", () => {
        const text = parseHex(hexUtility(runningLabelText, name === "dark" ? "dark:text" : "text")).rgb;
        expect(contrastRgb(text, grey(background))).toBeGreaterThanOrEqual(4.5);
        expect(contrastRgb(text, grey(fill))).toBeGreaterThanOrEqual(4.5);
      });

      it("keeps form-control borders at the 3:1 non-text minimum", () => {
        const border = over(foreground, percent(own.get("--input-strength")), background);
        expect(contrast(border, background)).toBeGreaterThanOrEqual(3);
      });

      it("keeps dividers visible but quieter than form controls", () => {
        const divider = percent(own.get("--border-strength"));
        expect(divider).toBeGreaterThanOrEqual(0.1);
        expect(divider).toBeLessThanOrEqual(0.14);
        expect(divider).toBeLessThan(percent(own.get("--input-strength")));
      });
    });
  }
});
