/**
 * URL parity list: every route pattern of the React Router tree in ui/src/App.tsx.
 *
 * The list is read from the source, so it cannot drift from the router. A route moved to
 * the Next.js App Router stays in this list until the catch-all and React Router are
 * removed; after that the list is read from ui/app instead (extend `readPatterns`).
 *
 * Usage:
 *   node tests/perf/web-app/route-list.mjs            # one line per pattern: kind, pattern, conditions
 *   node tests/perf/web-app/route-list.mjs --json     # the same as JSON
 *   node tests/perf/web-app/route-list.mjs --count    # counts per kind, plus the <Route> tag count
 *
 * One entry per URL pattern (the key route-smoke.mjs and gate.mjs pair on):
 *   pattern     "/:companyPrefix/issues/:issueId"; a splat keeps its trailing "/*"
 *   kind        page > redirect > splat > layout, the first that any route of the pattern has
 *   kinds       every kind the pattern can take (a pattern can be a page or a redirect by flag)
 *   when        the conditions it depends on: "streamlinedUiEnabled", "mergedTasks",
 *               "import.meta.env.DEV" (a route that exists in dev builds only)
 *   gates       gate components in front of it (they can redirect away or render NotFound)
 *   params      the `:name` segments
 *   line        first line in App.tsx
 *
 * Kinds: page (renders UI), redirect (an element that only navigates), splat (`*` path),
 * layout (a route with child routes, which renders no page of its own).
 * Conditional routes are all listed; the browser decides which apply to an instance, and
 * route-smoke.mjs records where each URL ends up. `agents/${tab}` is expanded with
 * AGENT_FILTER_TABS from ui/src/lib/agent-filter-tabs.ts.
 *
 * The reader is a small scanner for `<Route ...>` tags, not a full JSX parser: App.tsx
 * writes every route as a literal tag, and a tag is closed at the first `>` outside braces
 * and quotes. The repository has no JSX parser as a dependency (TypeScript 7 has no
 * JavaScript API). Conditions come from the `{flag ? ( ... ) : ( ... )}` groups between
 * tags and from a ternary inside `element={...}`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BOARD_MOUNT = ":companyPrefix";
const KIND_ORDER = ["page", "redirect", "splat", "layout"];
const REDIRECT_NAME = /^(Navigate|\w*Redirect)$/;
const WRAPPER_NAME = /^(Suspense|ProductionSurface|PaperclipLoading)$|Gate$/;

/** Index of the `>` that closes the tag that starts at `from`, honouring `{}` and quotes. */
function tagEnd(src, from) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
    } else if (c === ">" && depth === 0) {
      return i;
    }
  }
  return -1;
}

/** The text inside the `{...}` that starts at `open`, honouring nested braces and quotes. */
function braced(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}

/** Value of a string attribute: `path="x"`, `path={"x"}`, or a template literal `path={`a/${v}`}`. */
function stringAttr(tag, name) {
  const quoted = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  if (quoted) return quoted[1];
  const at = new RegExp(`\\b${name}=\\{`).exec(tag);
  if (!at) return null;
  const inner = braced(tag, at.index + at[0].length - 1).trim();
  const literal = /^["'`]([^"'`]*)["'`]$/.exec(inner);
  return literal ? literal[1] : null;
}

function elementExpression(tag) {
  const at = /\belement=\{/.exec(tag);
  return at ? braced(tag, at.index + at[0].length - 1) : "";
}

const componentNames = (expr) => [...expr.matchAll(/<([A-Z]\w*)/g)].map((m) => m[1]);

/** Kinds and gates of an `element` expression; a ternary between a redirect and a page gives both. */
function readElement(expr) {
  if (!expr.trim()) return { kinds: ["page"], gates: [], when: [] };
  const parts = expr.split(/\?\s*(?=<)|\s:\s(?=<)/);
  const hasTernary = parts.length > 1;
  const branches = hasTernary ? parts.slice(1) : parts;
  const kinds = new Set();
  const gates = new Set();
  for (const branch of branches) {
    const names = componentNames(branch);
    for (const n of names) if (/Gate$/.test(n)) gates.add(n);
    const core = names.filter((n) => !WRAPPER_NAME.test(n));
    kinds.add(core.length > 0 && core.every((n) => REDIRECT_NAME.test(n)) ? "redirect" : "page");
  }
  return { kinds: [...kinds], gates: [...gates], when: hasTernary ? [parts[0].trim()] : [] };
}

/**
 * Conditions and map sources between two tags. `stack` holds the open
 * `{flag ? (`, `{LIST.map((v) => (` groups; it is changed in place.
 */
function updateContext(stack, gapText) {
  const gap = gapText.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
  const token =
    /\{\s*([\w.]+)\.map\(\s*\(?(\w+)\)?\s*=>\s*\(|\{\s*([\w.]+(?:\s*&&\s*[\w.]+)*)\s*\?\s*\(|\)\s*:\s*\(|\)\s*:\s*null\s*\}|\)\)\s*\}|\)\s*\}/g;
  let m;
  while ((m = token.exec(gap))) {
    if (m[1]) stack.push({ map: m[1], variable: m[2] });
    else if (m[3]) stack.push({ cond: m[3].trim() });
    else if (/^\)\s*:\s*\(/.test(m[0])) continue;
    else stack.pop();
  }
}

function readTabs(file) {
  const src = fs.readFileSync(path.join(root, file), "utf8");
  const list = /AGENT_FILTER_TABS\s*=\s*\[([^\]]*)\]/.exec(src);
  return list ? [...list[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) : [];
}

function joinPath(parts) {
  const joined = parts.filter(Boolean).join("/").replace(/\/+/g, "/");
  return `/${joined}`.replace(/\/$/, "") || "/";
}

/** Reads every `<Route>` of App.tsx and returns one entry per distinct URL pattern. */
export function readPatterns(appFile = path.join(root, "ui/src/App.tsx")) {
  const src = fs.readFileSync(appFile, "utf8");
  const mapSources = { AGENT_FILTER_TABS: readTabs("ui/src/lib/agent-filter-tabs.ts") };
  const boardStart = src.search(/function boardRoutes\(/);
  const boardEnd = boardStart === -1 ? -1 : src.slice(boardStart + 1).search(/\nfunction |\nexport function /) + boardStart + 1;
  const found = [];
  const stack = [];
  const context = [];
  let tagCount = 0;
  let pathless = 0;
  let cursor = 0;
  const re = /<Route\b|<\/Route>/g;
  let m;
  while ((m = re.exec(src))) {
    const gap = src.slice(cursor, m.index);
    const fnAt = Math.max(gap.lastIndexOf("\nfunction "), gap.lastIndexOf("\nexport function "));
    if (fnAt !== -1) context.length = 0;
    updateContext(context, fnAt === -1 ? gap : gap.slice(fnAt));
    if (m[0] === "</Route>") {
      stack.pop();
      cursor = m.index + m[0].length;
      continue;
    }
    tagCount += 1;
    const end = tagEnd(src, m.index + m[0].length);
    if (end === -1) break;
    const tag = src.slice(m.index, end + 1);
    const selfClosing = src[end - 1] === "/";
    const rawPath = stringAttr(tag, "path");
    const inBoard = boardStart !== -1 && m.index > boardStart && m.index < boardEnd;
    const ancestors = stack.map((s) => s.path).filter(Boolean);
    const isIndex = /\sindex[\s/>]/.test(tag);
    const element = readElement(elementExpression(tag));
    const gates = [...stack.flatMap((s) => s.gates), ...element.gates];
    const when = [...context.filter((c) => c.cond).map((c) => c.cond), ...element.when];
    if (rawPath || isIndex) {
      const mapped = context.find((c) => c.map && rawPath?.includes("${"));
      const choices = mapped && mapSources[mapped.map] ? mapSources[mapped.map] : [null];
      for (const choice of choices) {
        const resolved =
          choice === null
            ? rawPath?.replace(/\$\{([^}]*)\}/g, (_m, e) => `:${e.replace(/\W+/g, "_")}`)
            : rawPath.replace(/\$\{[^}]*\}/g, choice);
        const kinds = !selfClosing ? ["layout"] : resolved?.endsWith("*") ? ["splat"] : element.kinds;
        found.push({
          pattern: joinPath([...(inBoard ? [BOARD_MOUNT] : []), ...ancestors, resolved]),
          kinds,
          when,
          gates,
          line: src.slice(0, m.index).split("\n").length,
        });
      }
    } else if (!selfClosing) {
      pathless += 1;
    }
    if (!selfClosing) stack.push({ path: rawPath, gates: element.gates });
    re.lastIndex = end + 1;
    cursor = end + 1;
  }
  const byPattern = new Map();
  for (const r of found) {
    const entry = byPattern.get(r.pattern) ?? { pattern: r.pattern, kinds: new Set(), when: new Set(), gates: new Set(), line: r.line };
    r.kinds.forEach((k) => entry.kinds.add(k));
    r.when.forEach((w) => entry.when.add(w));
    r.gates.forEach((g) => entry.gates.add(g));
    byPattern.set(r.pattern, entry);
  }
  const patterns = [...byPattern.values()]
    .map((e) => {
      const kinds = KIND_ORDER.filter((k) => e.kinds.has(k));
      return {
        pattern: e.pattern,
        kind: kinds[0],
        kinds,
        when: [...e.when],
        gates: [...e.gates],
        params: [...e.pattern.matchAll(/:(\w+)/g)].map((p) => p[1]),
        line: e.line,
      };
    })
    .sort((a, b) => a.pattern.localeCompare(b.pattern));
  Object.defineProperty(patterns, "routeTags", { value: tagCount });
  Object.defineProperty(patterns, "pathlessLayouts", { value: pathless });
  return patterns;
}

/** `{ total, page, redirect, ... }` for a `readPatterns` result. */
export function countKinds(patterns) {
  const counts = { total: patterns.length, routeTags: patterns.routeTags, pathlessLayouts: patterns.pathlessLayouts };
  for (const r of patterns) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  counts.conditional = patterns.filter((r) => r.when.length > 0).length;
  return counts;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const patterns = readPatterns();
  const flag = process.argv[2];
  if (flag === "--json") {
    console.log(JSON.stringify(patterns, null, 2));
  } else if (flag === "--count") {
    console.log(JSON.stringify(countKinds(patterns)));
  } else {
    for (const r of patterns) {
      const extra = [r.kinds.length > 1 ? `also ${r.kinds.slice(1).join("+")}` : "", r.when.length ? `when ${r.when.join(", ")}` : ""].filter(Boolean).join("; ");
      console.log(`${r.kind.padEnd(8)} ${r.pattern}${extra ? `   (${extra})` : ""}`);
    }
  }
}
