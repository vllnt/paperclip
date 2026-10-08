/**
 * Generates `doc/api-coverage-matrix.md`: every OpenAPI operation with its
 * authentication level, the board UI client calls that reach it, and the
 * `paperclipai` CLI commands that reach it.
 *
 * Run: `pnpm --filter @paperclipai/server api:coverage`
 *
 * UI and CLI callers are found by static scanning of `ui/src/api/*.ts` and
 * `cli/src/commands/**`. Calls whose path is built at runtime are reported as
 * unresolved instead of being guessed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readObject } from "../src/lib/objects.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"] as const;

export type ApiKeyAccess =
  | "public"
  | "board-key"
  | "board-key+instance-admin"
  | "board-or-agent-key"
  | "agent-run-jwt"
  | "runtime-token";

export interface SpecOperation {
  method: string;
  path: string;
  summary: string;
  tag: string;
  access: ApiKeyAccess;
}

export interface ClientCall {
  method: string;
  /** Normalized path with `{}` for runtime segments, or null when unresolved. */
  path: string | null;
  raw: string;
  file: string;
  line: number;
  label: string;
}

interface TemplatePart {
  kind: "text" | "expr";
  value: string;
}

/**
 * Reads a template literal starting at `start` (the opening backtick).
 * @returns the parts and the index just past the closing backtick.
 */
export function readTemplateLiteral(
  source: string,
  start: number,
): { parts: TemplatePart[]; end: number } {
  const parts: TemplatePart[] = [];
  let text = "";
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      text += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "`") {
      if (text) parts.push({ kind: "text", value: text });
      return { parts, end: index + 1 };
    }
    if (char === "$" && source[index + 1] === "{") {
      if (text) parts.push({ kind: "text", value: text });
      text = "";
      const exprEnd = skipBalanced(source, index + 1);
      parts.push({ kind: "expr", value: source.slice(index + 2, exprEnd - 1) });
      index = exprEnd;
      continue;
    }
    text += char;
    index += 1;
  }
  return { parts, end: source.length };
}

/** Skips a balanced `(...)`, `{...}` or `[...]` group starting at `start`. */
function skipBalanced(source: string, start: number): number {
  const closers: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [closers[source[start]]];
  let index = start + 1;
  while (index < source.length && stack.length > 0) {
    const char = source[index];
    if (char === "`") {
      index = readTemplateLiteral(source, index).end;
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipString(source, index);
      continue;
    }
    if (closers[char]) stack.push(closers[char]);
    else if (char === stack[stack.length - 1]) stack.pop();
    index += 1;
  }
  return index;
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    index += source[index] === "\\" ? 2 : 1;
  }
  return index + 1;
}

/** Splits a call's argument list (text between the parentheses) on top-level commas. */
function splitArguments(argsText: string): string[] {
  const args: string[] = [];
  let current = "";
  let index = 0;
  while (index < argsText.length) {
    const char = argsText[index];
    if (char === "`") {
      const end = readTemplateLiteral(argsText, index).end;
      current += argsText.slice(index, end);
      index = end;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = skipString(argsText, index);
      current += argsText.slice(index, end);
      index = end;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      const end = skipBalanced(argsText, index);
      current += argsText.slice(index, end);
      index = end;
      continue;
    }
    if (char === ",") {
      args.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

const PATH_TEMPLATE_TAGS = new Set(["apiPath"]);
const RUNTIME_PLACEHOLDER = "__runtime_segment__";

/** Literal values bound to identifiers at a call site (`undefined` = argument omitted). */
type Bindings = Map<string, string | undefined>;

/** What the scanner may substitute while resolving a path expression. */
export interface ResolveContext {
  /** File-local path helpers, e.g. `function agentPath(id, companyId, suffix) { return `/agents/${id}${suffix}` }`. */
  helpers: Map<string, TemplatePart[]>;
  /** Literal values bound to identifiers at a call site. */
  bindings: Bindings;
  /** String constants and path builders (file-local and from `@paperclipai/shared`). */
  constants: Record<string, unknown>;
  /** Returns the initializer of the nearest preceding `const name = ...` for the call being resolved. */
  locals?: (name: string) => string | undefined;
}

const emptyContext = (constants: Record<string, unknown> = {}): ResolveContext => ({
  helpers: new Map(),
  bindings: new Map(),
  constants,
});

/** Returns the index of each top-level character matching `predicate`, skipping literals and brackets. */
function topLevelIndices(text: string, predicate: (char: string, index: number) => boolean): number[] {
  const indices: number[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "`") {
      index = readTemplateLiteral(text, index).end;
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipString(text, index);
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      index = skipBalanced(text, index);
      continue;
    }
    if (predicate(char, index)) indices.push(index);
    index += 1;
  }
  return indices;
}

/** Splits `cond ? a : b` at the top level; returns null when the text is not a conditional. */
function splitConditional(text: string): [string, string] | null {
  const marks = topLevelIndices(
    text,
    (char, index) =>
      (char === "?" && text[index + 1] !== "." && text[index + 1] !== "?" && text[index - 1] !== "?") ||
      char === ":",
  );
  const question = marks.find((index) => text[index] === "?");
  if (question === undefined) return null;
  let depth = 0;
  for (const index of marks) {
    if (index <= question) continue;
    if (text[index] === "?") depth += 1;
    else if (depth === 0) return [text.slice(question + 1, index).trim(), text.slice(index + 1).trim()];
    else depth -= 1;
  }
  return null;
}

function stripQuery(value: string): { path: string; hadQuery: boolean } {
  const queryIndex = value.indexOf("?");
  return queryIndex >= 0 ? { path: value.slice(0, queryIndex), hadQuery: true } : { path: value, hadQuery: false };
}

/**
 * Resolves one `${...}` expression. Returns path text, `null` when the
 * expression makes the whole path unresolvable, or `undefined` for a plain
 * runtime value (an ID, a query string).
 */
function resolveExpression(expression: string, context: ResolveContext): string | null | undefined {
  const trimmed = expression.trim();
  const unwrapped = /^(?:encodeURIComponent|String)\(([\s\S]*)\)$/.exec(trimmed);
  if (unwrapped) return resolveExpression(unwrapped[1], context);
  if (context.bindings.has(trimmed)) return context.bindings.get(trimmed) ?? "";
  const conditional = /^([A-Za-z_$][\w$]*)\s*\?\s*`([^`]*)`\s*:\s*(?:""|'')$/.exec(trimmed);
  if (conditional && context.bindings.has(conditional[1])) {
    const value = context.bindings.get(conditional[1]);
    return value ? conditional[2].split(`\${${conditional[1]}}`).join(value) : "";
  }
  const tagged = /^([A-Za-z_$][\w$]*)\s*`/.exec(trimmed);
  if (tagged && PATH_TEMPLATE_TAGS.has(tagged[1])) {
    return templatePartsToPath(readTemplateLiteral(trimmed, trimmed.indexOf("`")).parts, context);
  }
  const constant = context.constants[trimmed];
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed) && typeof constant === "string" && constant.startsWith("/")) {
    return constant;
  }
  if (/^[A-Za-z_$][\w$]*\s*\(/.test(trimmed)) {
    const resolved = callToPath(trimmed, context);
    if (resolved !== undefined) return resolved;
  }
  const initializer = /^[A-Za-z_$][\w$]*$/.test(trimmed) ? context.locals?.(trimmed) : undefined;
  if (initializer !== undefined) {
    const locals = context.locals;
    const resolved = literalToPath(initializer, {
      ...context,
      locals: (name) => (name === trimmed ? undefined : locals?.(name)),
    });
    return resolved ?? undefined;
  }
  return undefined;
}

/**
 * Resolves a path-building call: a file-local helper, a shared path builder
 * (evaluated with placeholder arguments) or a wrapper such as
 * `withCompanyScope(`/x/${id}`, companyId)`.
 */
function callToPath(text: string, context: ResolveContext): string | null | undefined {
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(text);
  if (!call) return undefined;
  const argsStart = call[0].length - 1;
  const argsEnd = skipBalanced(text, argsStart);
  if (argsEnd !== text.length) return undefined;
  const innerArgs = splitArguments(text.slice(argsStart + 1, argsEnd - 1));
  const helper = context.helpers.get(call[1]);
  if (helper) {
    const base = templatePartsToPath(helper, { ...context, bindings: new Map() });
    if (base === null) return null;
    const suffix = innerArgs
      .slice(1)
      .map((arg) => (/^["'`]/.test(arg.trim()) ? literalToPath(arg, context) : null))
      .find((value) => value !== null && value !== "/");
    return suffix ? `${base}${suffix}` : base;
  }
  const builder = context.constants[call[1]];
  if (typeof builder === "function") {
    try {
      const value: unknown = builder(...innerArgs.map(() => RUNTIME_PLACEHOLDER));
      if (typeof value === "string" && value.startsWith("/")) {
        return stripQuery(value).path.split(RUNTIME_PLACEHOLDER).join("{}");
      }
    } catch {
      return null;
    }
    return null;
  }
  // A wrapper such as `withCompanyScope(`/x/${id}`, companyId)`; any other call
  // (for example a query-string builder) is a runtime value.
  const wrapped = innerArgs.length > 0 ? literalToPath(innerArgs[0], context) : null;
  return wrapped ?? undefined;
}

/**
 * Converts template-literal parts into a path with `{}` for runtime segments.
 * A runtime value glued to a segment (a query string) is dropped. A leading
 * runtime value, or one glued in the middle of the path, makes the path
 * unresolved.
 */
export function templatePartsToPath(parts: TemplatePart[], context: ResolveContext = emptyContext()): string | null {
  let result = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.kind === "text") {
      const { path: text, hadQuery } = stripQuery(part.value);
      result += text;
      if (hadQuery) break;
      continue;
    }
    const resolved = resolveExpression(part.value, context);
    if (resolved === null) return null;
    if (resolved !== undefined) {
      const { path: text, hadQuery } = stripQuery(resolved);
      result += text;
      if (hadQuery) break;
      continue;
    }
    if (i === 0) return null;
    const next = parts[i + 1];
    if (result.endsWith("/")) {
      // A whole runtime segment, e.g. `/agents/${id}` or `/agents/${id}${suffix}`.
      result += "{}";
      continue;
    }
    if (next?.kind === "text" && next.value.startsWith("/")) return null;
    if (/^[A-Z][A-Z0-9_]*$/.test(part.value.trim())) return null;
    // `/api/auth${path}` continues the path; `/x/${id}${suffix}` and
    // `/x/summary${query}` end in a query string or a dropped suffix.
    if (!result.endsWith("{}") && /^(?:path|subpath|route|endpoint)$/i.test(part.value.trim())) return null;
    break;
  }
  return result.replace(/\/+$/, "") || "/";
}

/** Converts `"/a/" + id + "/b"` into template parts; returns null when not a concatenation. */
function concatenationToParts(argument: string): TemplatePart[] | null {
  const plusIndices = topLevelIndices(argument, (char) => char === "+");
  if (plusIndices.length === 0) return null;
  const operands: string[] = [];
  let previous = 0;
  for (const index of plusIndices) {
    operands.push(argument.slice(previous, index).trim());
    previous = index + 1;
  }
  operands.push(argument.slice(previous).trim());
  const parts: TemplatePart[] = [];
  for (const operand of operands) {
    const literal = stringLiteralValue(operand);
    if (literal !== undefined) parts.push({ kind: "text", value: literal });
    else if (operand.startsWith("`")) parts.push(...readTemplateLiteral(operand, 0).parts);
    else parts.push({ kind: "expr", value: operand });
  }
  return parts;
}

function stringLiteralValue(argument: string): string | undefined {
  const trimmed = argument.trim();
  if (!(trimmed.startsWith('"') || trimmed.startsWith("'"))) return undefined;
  const end = skipString(trimmed, 0);
  return end === trimmed.length ? trimmed.slice(1, end - 1) : undefined;
}

/** Resolves the path argument of an API call, or returns null when it is built at runtime. */
function literalToPath(argument: string, context: ResolveContext): string | null {
  const trimmed = argument.trim();
  const branches = splitConditional(trimmed);
  if (branches) {
    return literalToPath(branches[0], context) ?? literalToPath(branches[1], context);
  }
  const concatenated = concatenationToParts(trimmed);
  if (concatenated) return templatePartsToPath(concatenated, context);
  const literal = stringLiteralValue(trimmed);
  if (literal !== undefined) {
    return literal.startsWith("/") ? stripQuery(literal).path.replace(/\/+$/, "") || "/" : null;
  }
  const tagged = /^([A-Za-z_$][\w$]*)?\s*`/.exec(trimmed);
  if (tagged && (!tagged[1] || PATH_TEMPLATE_TAGS.has(tagged[1]))) {
    return templatePartsToPath(readTemplateLiteral(trimmed, trimmed.indexOf("`")).parts, context);
  }
  const resolved = resolveExpression(trimmed, context);
  return typeof resolved === "string" ? stripQuery(resolved).path.replace(/\/+$/, "") || "/" : null;
}

/** Finds `function name(...) { return [wrapper(]`...` }` path helpers in a file. */
function findPathHelpers(source: string): Map<string, TemplatePart[]> {
  const helpers = new Map<string, TemplatePart[]>();
  const pattern =
    /(?:function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*string\s*)?\{\s*return\s+(?:[A-Za-z_$][\w$]*\()?|const\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*(?::\s*string\s*)?=>\s*(?:[A-Za-z_$][\w$]*\()?)`/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1] ?? match[2];
    const tickIndex = (match.index ?? 0) + match[0].length - 1;
    const { parts } = readTemplateLiteral(source, tickIndex);
    if (parts[0]?.kind === "text" && parts[0].value.startsWith("/")) {
      helpers.set(name, parts);
    }
  }
  return helpers;
}

/** Finds file-local `const NAME = "/path"` constants. */
function findPathConstants(source: string): Record<string, string> {
  const constants: Record<string, string> = {};
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(\/[^"']*)\2\s*;/g)) {
    constants[match[1]] = match[3];
  }
  return constants;
}

const blockRangeCache = new Map<string, Array<[number, number]>>();

/** Returns the `[open, close]` index of every `{...}` block, skipping strings, templates and comments. */
function findBlockRanges(source: string): Array<[number, number]> {
  const cached = blockRangeCache.get(source);
  if (cached) return cached;
  const ranges: Array<[number, number]> = [];
  const stack: number[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "`") {
      index = readTemplateLiteral(source, index).end;
    } else if (char === '"' || char === "'") {
      index = skipString(source, index);
    } else if (char === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline;
    } else if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
    } else {
      if (char === "{") stack.push(index);
      else if (char === "}") {
        const open = stack.pop();
        if (open !== undefined) ranges.push([open, index]);
      }
      index += 1;
    }
  }
  blockRangeCache.set(source, ranges);
  return ranges;
}

/** True when the innermost block around `declarationIndex` also encloses `useIndex`. */
function isInScope(source: string, declarationIndex: number, useIndex: number): boolean {
  let innermost: [number, number] | undefined;
  for (const range of findBlockRanges(source)) {
    if (range[0] < declarationIndex && range[1] > declarationIndex && (!innermost || range[0] > innermost[0])) {
      innermost = range;
    }
  }
  return !innermost || (innermost[0] < useIndex && innermost[1] > useIndex);
}

/** Returns the initializer of the nearest in-scope `const|let name = ...;` before `beforeIndex`. */
function findLocalInitializer(source: string, name: string, beforeIndex: number): string | undefined {
  const pattern = new RegExp(`\\b(?:const|let)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=;]+)?=\\s*`, "g");
  const match = [...source.slice(0, beforeIndex).matchAll(pattern)]
    .filter((candidate) => isInScope(source, candidate.index ?? 0, beforeIndex))
    .pop();
  if (!match) return undefined;
  const start = (match.index ?? 0) + match[0].length;
  const rest = source.slice(start, beforeIndex);
  const end = topLevelIndices(rest, (char) => char === ";" || char === "\n")[0] ?? rest.length;
  return rest.slice(0, end).trim();
}

function fileContext(source: string, sharedConstants: Record<string, unknown>): ResolveContext {
  return {
    helpers: findPathHelpers(source),
    bindings: new Map(),
    constants: { ...sharedConstants, ...findPathConstants(source) },
  };
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function callArgumentsAt(source: string, openParen: number): string[] {
  const end = skipBalanced(source, openParen);
  return splitArguments(source.slice(openParen + 1, end - 1));
}

const UI_METHODS: Record<string, string> = {
  get: "GET",
  post: "POST",
  postForm: "POST",
  put: "PUT",
  putRaw: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  deleteWithBody: "DELETE",
};

function nearestUiLabel(source: string, index: number): string {
  const before = source.slice(0, index);
  const objectMatch = [...before.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g)].pop();
  const functionMatch = [...before.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].pop();
  const memberMatch = [
    ...before.matchAll(/\n\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*(?:async\s*)?(?:<[^>]*>)?\(|\()/g),
  ].pop();
  if (objectMatch && memberMatch && (memberMatch.index ?? 0) > (objectMatch.index ?? 0)) {
    if (!functionMatch || (functionMatch.index ?? 0) < (objectMatch.index ?? 0)) {
      return `${objectMatch[1]}.${memberMatch[1]}`;
    }
  }
  if (functionMatch) return functionMatch[1];
  return objectMatch?.[1] ?? "(module)";
}

/** Extracts board UI client calls (`api.get(...)`, `requestResponse(...)`) from one file. */
export function extractUiCalls(
  file: string,
  source: string,
  sharedConstants: Record<string, unknown> = {},
): ClientCall[] {
  const calls: ClientCall[] = [];
  const context = fileContext(source, sharedConstants);
  for (const match of source.matchAll(/\bapi\.(get|post|postForm|put|putRaw|patch|delete|deleteWithBody)\s*(?:<[^>(]*(?:<[^>]*>[^>(]*)*>)?\s*\(/g)) {
    const openParen = (match.index ?? 0) + match[0].length - 1;
    const [first = ""] = callArgumentsAt(source, openParen);
    const resolved = literalToPath(first, {
      ...context,
      locals: (name) => findLocalInitializer(source, name, match.index ?? 0),
    });
    calls.push({
      method: UI_METHODS[match[1]],
      path: resolved === null ? null : `/api${resolved === "/" ? "" : resolved}`,
      raw: first.slice(0, 120),
      file,
      line: lineAt(source, match.index ?? 0),
      label: nearestUiLabel(source, match.index ?? 0),
    });
  }
  for (const match of source.matchAll(/\brequestResponse\s*\(/g)) {
    const openParen = (match.index ?? 0) + match[0].length - 1;
    const args = callArgumentsAt(source, openParen);
    if (args.length === 0 || /^path$/.test(args[0])) continue;
    const resolved = literalToPath(args[0], {
      ...context,
      locals: (name) => findLocalInitializer(source, name, match.index ?? 0),
    });
    const method = requestMethod(args[1]);
    calls.push({
      method: method ?? "GET",
      path: resolved === null || method === null ? null : `/api${resolved === "/" ? "" : resolved}`,
      raw: args[0].slice(0, 120),
      file,
      line: lineAt(source, match.index ?? 0),
      label: nearestUiLabel(source, match.index ?? 0),
    });
  }
  for (const site of findFetchSites(source, context)) {
    calls.push({ ...site, file, label: nearestUiLabel(source, site.index) });
  }
  return calls;
}

/**
 * Reads the HTTP method from a `fetch`/`requestResponse` init argument.
 * @returns the method, `undefined` when none is given (GET), or `null` when it is computed at runtime.
 */
function requestMethod(init: string | undefined): string | null | undefined {
  if (!init || !/\bmethod\s*:/.test(init)) return undefined;
  const literal = /\bmethod\s*:\s*["'](\w+)["']/.exec(init);
  return literal ? literal[1].toUpperCase() : null;
}

/**
 * Finds raw `fetch(...)` calls to the Paperclip API, including the CLI's
 * `fetch(buildApiUrl(apiBase, path), init)`. Calls to other origins are ignored.
 */
function findFetchSites(
  source: string,
  context: ResolveContext,
): Array<{ index: number; method: string; path: string | null; raw: string; line: number }> {
  const sites: Array<{ index: number; method: string; path: string | null; raw: string; line: number }> = [];
  for (const match of source.matchAll(/(?<![.\w])fetch\s*\(/g)) {
    const index = match.index ?? 0;
    const args = callArgumentsAt(source, index + match[0].length - 1);
    let target = args[0] ?? "";
    const built = /^buildApiUrl\s*\(/.exec(target.trim());
    if (built) target = callArgumentsAt(target.trim(), built[0].length - 1)[1] ?? "";
    if (/^`\$\{BASE\}\$\{path\}`$/.test(target.trim())) continue;
    const resolved = literalToPath(target, {
      ...context,
      locals: (name) => findLocalInitializer(source, name, index),
    });
    const method = requestMethod(args[1]);
    const apiPath = resolved !== null && /^\/(api|mcp)(\/|$)/.test(resolved);
    if (resolved !== null && !apiPath) continue;
    if (resolved === null && !built && !/\/api\b/.test(target)) continue;
    sites.push({
      index,
      method: method ?? "GET",
      path: apiPath && method !== null ? resolved : null,
      raw: target.slice(0, 120),
      line: lineAt(source, index),
    });
  }
  return sites;
}

/** Maps `child = parent.command("name")` variables to their parent and command name. */
function findCommandGroups(source: string): Map<string, { parent: string; name: string }> {
  const groups = new Map<string, { parent: string; name: string }>();
  for (const match of source.matchAll(/(\w+)\s*=\s*(\w+)\s*\.command\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    groups.set(match[1], { parent: match[2], name: match[3].split(" ")[0] });
  }
  return groups;
}

function commandChain(groups: Map<string, { parent: string; name: string }>, variable: string): string[] {
  const chain: string[] = [];
  let current: string | undefined = variable;
  const seen = new Set<string>();
  let entry = current ? groups.get(current) : undefined;
  while (current && entry && !seen.has(current)) {
    seen.add(current);
    chain.unshift(entry.name);
    current = entry.parent;
    entry = groups.get(current);
  }
  return chain;
}

/** A `.command("name")...action(...)` registration and the source range its handler covers. */
interface CommandRegion {
  receiver: string;
  name: string;
  start: number;
  end: number;
}

function findCommandRegions(source: string): CommandRegion[] {
  const regions: CommandRegion[] = [];
  const pattern = /(\w+)\s*\.command\(\s*["'`]([^"'`\s]+)[^"'`]*["'`]/g;
  const matches = [...source.matchAll(pattern)];
  matches.forEach((match, position) => {
    const start = match.index ?? 0;
    const nextStart = matches[position + 1]?.index ?? source.length;
    const actionIndex = source.indexOf(".action(", start);
    if (actionIndex < 0 || actionIndex > nextStart) return;
    const end = skipBalanced(source, actionIndex + ".action".length);
    regions.push({ receiver: match[1], name: match[2], start, end });
  });
  return regions;
}

/** Resolves a command parent argument: a group variable or an inline `program.command("x")` chain. */
function parentChain(argument: string, groups: Map<string, { parent: string; name: string }>): string[] {
  const inline = /^(\w+)\s*\.command\(\s*["'`]([^"'`\s]+)/.exec(argument.trim());
  if (inline) return [...commandChain(groups, inline[1]), inline[2]];
  return /^[A-Za-z_$][\w$]*$/.test(argument.trim()) ? commandChain(groups, argument.trim()) : [];
}

/** Labels a call by the command whose `.action(...)` handler contains it; shared helpers get no leaf. */
function nearestCliLabel(
  source: string,
  index: number,
  groups: Map<string, { parent: string; name: string }>,
  registrationPrefix: string[],
): string {
  const region = findCommandRegions(source)
    .filter((candidate) => candidate.start <= index && candidate.end >= index)
    .pop();
  if (!region) return "paperclipai";
  const receiverChain = commandChain(groups, region.receiver);
  const chain = receiverChain.length > 0 ? receiverChain : registrationPrefix;
  return ["paperclipai", ...chain, region.name].join(" ");
}

/**
 * Reads `cli/src/index.ts` to find files whose commands are registered under a
 * group, e.g. `registerRunCommands(run)` with `const run = program.command("run")`.
 * @returns a map from the imported file (repo-relative, `.ts`) to the group chain.
 */
export function findCliRegistrationPrefixes(indexSource: string, indexFile: string): Map<string, string[]> {
  const prefixes = new Map<string, string[]>();
  const groups = findCommandGroups(indexSource);
  const imports = new Map<string, string>();
  for (const match of indexSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g)) {
    const target = path.posix.join(path.posix.dirname(indexFile), match[2]).replace(/\.js$/, ".ts");
    for (const name of match[1].split(",")) imports.set(name.trim(), target);
  }
  for (const match of indexSource.matchAll(/\b(register\w+)\(\s*(\w+)\s*\)/g)) {
    const target = imports.get(match[1]);
    if (!target || match[2] === "program") continue;
    const chain = commandChain(groups, match[2]);
    if (chain.length > 0) prefixes.set(target, chain);
  }
  return prefixes;
}

const CLI_CALL_PATTERN = /\bapi\.(get|post|put|putRaw|patch|delete)\s*(?:<[^>(]*(?:<[^>]*>[^>(]*)*>)?\s*\(/g;

/** An API call in CLI source: `api.<method>(path, ...)` or `fetch(buildApiUrl(base, path), init)`. */
interface CliCallSite {
  index: number;
  method: string;
  pathArgument: string;
  /** Set when the method is computed at runtime. */
  unknownMethod?: boolean;
}

function findCliCallSites(source: string): CliCallSite[] {
  const sites: CliCallSite[] = [];
  for (const match of source.matchAll(CLI_CALL_PATTERN)) {
    const index = match.index ?? 0;
    const [pathArgument = ""] = callArgumentsAt(source, index + match[0].length - 1);
    sites.push({ index, method: match[1] === "putRaw" ? "PUT" : match[1].toUpperCase(), pathArgument });
  }
  for (const match of source.matchAll(/(?<![.\w])fetch\s*\(\s*buildApiUrl\s*\(/g)) {
    const index = match.index ?? 0;
    const fetchArgs = callArgumentsAt(source, source.indexOf("(", index));
    const urlArgs = callArgumentsAt(fetchArgs[0] ?? "", (fetchArgs[0] ?? "").indexOf("("));
    const method = requestMethod(fetchArgs[1]);
    sites.push({ index, method: method ?? "GET", pathArgument: urlArgs[1] ?? "", unknownMethod: method === null });
  }
  return sites.sort((a, b) => a.index - b.index);
}

interface ExpandableBlock {
  start: number;
  end: number;
  body: string;
  bodyOffset: number;
  /** One entry per expansion: identifier bindings, the command receiver variable and command name. */
  expansions: Array<{ bindings: Bindings; parent?: string; command?: string; callIndex: number }>;
}

function parameterNames(paramsText: string): string[] {
  return splitArguments(paramsText).map((param) => /^\s*([A-Za-z_$][\w$]*)/.exec(param)?.[1] ?? "");
}

/** A `for (const [a, b] of [["x", "y"], ...])` loop over literal tuples. */
interface TupleLoop {
  names: string[];
  tuples: Array<Array<string | undefined>>;
  index: number;
  bodyStart: number;
  bodyEnd: number;
}

function findTupleLoops(source: string): TupleLoop[] {
  const loops: TupleLoop[] = [];
  for (const match of source.matchAll(/for\s*\(\s*const\s*\[([^\]]+)\]\s*of\s*\[/g)) {
    const arrayStart = (match.index ?? 0) + match[0].length - 1;
    const arrayEnd = skipBalanced(source, arrayStart);
    const bodyStart = source.indexOf("{", arrayEnd);
    if (bodyStart < 0) continue;
    const tuples = splitArguments(source.slice(arrayStart + 1, arrayEnd - 1))
      .filter((tuple) => tuple.startsWith("["))
      .map((tuple) => splitArguments(tuple.slice(1, skipBalanced(tuple, 0) - 1)).map(stringLiteralValue));
    loops.push({
      names: match[1].split(",").map((name) => name.trim()),
      tuples,
      index: match.index ?? 0,
      bodyStart,
      bodyEnd: skipBalanced(source, bodyStart),
    });
  }
  return loops;
}

/**
 * Finds command-registering helpers (`function addIdGet(parent, name, ..., resource)`)
 * and tuple loops (`for (const [name, path] of [[...]])`) whose API path depends
 * on literal arguments, so each registration can be resolved separately. A
 * helper called inside a tuple loop with loop variables expands once per tuple.
 */
function findExpandableBlocks(source: string): ExpandableBlock[] {
  const blocks: ExpandableBlock[] = [];
  const loops = findTupleLoops(source);
  const hasApiCall = (body: string) => findCliCallSites(body).length > 0;
  for (const match of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const openParen = (match.index ?? 0) + match[0].length - 1;
    const paramsEnd = skipBalanced(source, openParen);
    const params = parameterNames(source.slice(openParen + 1, paramsEnd - 1));
    const bodyStart = source.indexOf("{", paramsEnd);
    if (bodyStart < 0) continue;
    const bodyEnd = skipBalanced(source, bodyStart);
    const body = source.slice(bodyStart, bodyEnd);
    if (!hasApiCall(body)) continue;
    const commandParamMatch = /\.command\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(body)?.[1];
    const commandParam = commandParamMatch && params.includes(commandParamMatch) ? commandParamMatch : undefined;
    const pathParams = params.filter((param) => new RegExp(`\\$\\{[^}]*\\b${param}\\b`).test(body));
    if (!commandParam && pathParams.length === 0) continue;
    const expansions: ExpandableBlock["expansions"] = [];
    for (const site of source.matchAll(new RegExp(`(?<!function\\s+)\\b${match[1]}\\s*\\(`, "g"))) {
      const siteIndex = site.index ?? 0;
      const siteParen = siteIndex + site[0].length - 1;
      if (siteParen === openParen) continue;
      const args = callArgumentsAt(source, siteParen);
      const loop = loops.find((candidate) => siteIndex > candidate.bodyStart && siteIndex < candidate.bodyEnd);
      for (const tuple of loop ? loop.tuples : [[]]) {
        const bindings: Bindings = new Map();
        params.forEach((param, position) => {
          if (position >= args.length) {
            bindings.set(param, undefined);
            return;
          }
          const argument = args[position].trim();
          const literal = stringLiteralValue(argument);
          const loopPosition = loop ? loop.names.indexOf(argument) : -1;
          const value = literal ?? (loopPosition >= 0 ? tuple[loopPosition] : undefined);
          if (value !== undefined) bindings.set(param, value);
        });
        expansions.push({
          bindings,
          parent: commandParam ? args[0] : undefined,
          command: commandParam ? bindings.get(commandParam) : undefined,
          callIndex: siteIndex,
        });
      }
    }
    blocks.push({ start: bodyStart, end: bodyEnd, body, bodyOffset: bodyStart, expansions });
  }
  for (const loop of loops) {
    const body = source.slice(loop.bodyStart, loop.bodyEnd);
    if (!hasApiCall(body)) continue;
    const receiver = /([A-Za-z_$][\w$]*)\s*\.command\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(body);
    const expansions: ExpandableBlock["expansions"] = loop.tuples.map((tuple) => {
      const bindings: Bindings = new Map();
      loop.names.forEach((name, position) => {
        if (tuple[position] !== undefined) bindings.set(name, tuple[position]);
      });
      return {
        bindings,
        parent: receiver?.[1],
        command: receiver ? bindings.get(receiver[2]) : undefined,
        callIndex: loop.index,
      };
    });
    blocks.push({ start: loop.bodyStart, end: loop.bodyEnd, body, bodyOffset: loop.bodyStart, expansions });
  }
  return blocks;
}

/**
 * Finds the `name === "literal" ? callA : callB` guard directly around an API
 * call at `index`, so a tuple loop that picks the HTTP method by command name
 * only reports the method each command really uses.
 */
function ternaryGuard(
  body: string,
  index: number,
): { name: string; value: string; whenEqual: boolean } | undefined {
  const before = body.slice(Math.max(0, index - 240), index);
  const match = [...before.matchAll(/([A-Za-z_$][\w$]*)\s*===\s*["']([^"']+)["']\s*\?/g)].pop();
  if (!match) return undefined;
  const between = before.slice((match.index ?? 0) + match[0].length);
  if (/;|\n\s*\n/.test(between)) return undefined;
  const elseBranch = topLevelIndices(between, (char) => char === ":").length > 0;
  return { name: match[1], value: match[2], whenEqual: !elseBranch };
}

/** Extracts CLI API calls (`ctx.api.get(...)`, `api.post(...)`) from one file. */
export function extractCliCalls(
  file: string,
  source: string,
  options: { sharedConstants?: Record<string, unknown>; registrationPrefix?: string[] } = {},
): ClientCall[] {
  const calls: ClientCall[] = [];
  const context = fileContext(source, options.sharedConstants ?? {});
  const groups = findCommandGroups(source);
  const prefix = options.registrationPrefix ?? [];
  const blocks = findExpandableBlocks(source).filter((block) => block.expansions.length > 0);
  const insideBlock = (index: number) => blocks.some((block) => index > block.start && index < block.end);
  for (const site of findCliCallSites(source)) {
    if (insideBlock(site.index)) continue;
    calls.push({
      method: site.method,
      path: site.unknownMethod
        ? null
        : literalToPath(site.pathArgument, {
            ...context,
            locals: (name) => findLocalInitializer(source, name, site.index),
          }),
      raw: site.pathArgument.slice(0, 120),
      file,
      line: lineAt(source, site.index),
      label: nearestCliLabel(source, site.index, groups, prefix),
    });
  }
  for (const block of blocks) {
    for (const site of findCliCallSites(block.body)) {
      const guard = ternaryGuard(block.body, site.index);
      for (const expansion of block.expansions) {
        const boundMethod = expansion.bindings.get("method")?.toUpperCase();
        if (boundMethod && boundMethod !== site.method) continue;
        if (guard && expansion.bindings.has(guard.name)) {
          const equal = expansion.bindings.get(guard.name) === guard.value;
          if (equal !== guard.whenEqual) continue;
        }
        const chain = expansion.parent ? parentChain(expansion.parent, groups) : [];
        const label = expansion.command
          ? ["paperclipai", ...(chain.length > 0 ? chain : prefix), expansion.command].join(" ")
          : nearestCliLabel(source, expansion.callIndex, groups, prefix);
        calls.push({
          method: site.method,
          path: site.unknownMethod
            ? null
            : literalToPath(site.pathArgument, {
                ...context,
                bindings: expansion.bindings,
                locals: (name) => findLocalInitializer(block.body, name, site.index),
              }),
          raw: site.pathArgument.slice(0, 120),
          file,
          line: lineAt(source, expansion.callIndex),
          label,
        });
      }
    }
  }
  return calls;
}

function accessFromAuthorization(authorization: Record<string, unknown> | undefined): ApiKeyAccess {
  switch (authorization?.actor) {
    case "public":
      return "public";
    case "board":
      return authorization.instanceAdmin ? "board-key+instance-admin" : "board-key";
    case "agent":
      return "agent-run-jwt";
    case "runtime_tools":
      return "runtime-token";
    default:
      return "board-or-agent-key";
  }
}

/** Flattens an OpenAPI document into one entry per operation. */
export function loadSpecOperations(spec: { paths?: Record<string, Record<string, unknown>> }): SpecOperation[] {
  const operations: SpecOperation[] = [];
  for (const [routePath, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = readObject(pathItem[method]);
      if (!operation) continue;
      const tags = Array.isArray(operation.tags) ? operation.tags : [];
      operations.push({
        method: method.toUpperCase(),
        path: routePath,
        summary: typeof operation.summary === "string" ? operation.summary : "",
        tag: typeof tags[0] === "string" ? tags[0] : "untagged",
        access: accessFromAuthorization(readObject(operation["x-paperclip-authorization"]) ?? undefined),
      });
    }
  }
  return operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/**
 * Finds the documented operation for a call path. A `{param}` spec segment
 * matches any call segment; a runtime `{}` call segment only matches a
 * `{param}` spec segment. The most literal match wins (`/agents/me` beats
 * `/agents/{id}`).
 */
export function matchOperation(
  method: string,
  callPath: string,
  operations: SpecOperation[],
): SpecOperation | null {
  const callSegments = callPath.split("/");
  let best: { operation: SpecOperation; literal: number } | null = null;
  for (const operation of operations) {
    if (operation.method !== method) continue;
    const specSegments = operation.path.split("/");
    if (specSegments.length !== callSegments.length) continue;
    let literal = 0;
    let matches = true;
    for (let i = 0; i < specSegments.length; i++) {
      const spec = specSegments[i];
      const call = callSegments[i];
      if (/^\{[^}]+\}$/.test(spec)) continue;
      if (spec.includes("{") && segmentPattern(spec).test(call)) continue;
      if (spec !== call) {
        matches = false;
        break;
      }
      literal += 1;
    }
    if (matches && (!best || literal > best.literal)) best = { operation, literal };
  }
  return best?.operation ?? null;
}

/**
 * True when a call with runtime segments in literal positions (a generic
 * dispatcher such as `/api/${resource}/${id}`) could reach some documented
 * operation of the same method.
 */
function looselyMatchingOperations(method: string, callPath: string, operations: SpecOperation[]): SpecOperation[] {
  const callSegments = callPath.split("/");
  return operations.filter((operation) => {
    if (operation.method !== method) return false;
    const specSegments = operation.path.split("/");
    return (
      specSegments.length === callSegments.length &&
      specSegments.every(
        (spec, i) =>
          callSegments[i] === "{}" ||
          spec === callSegments[i] ||
          /^\{[^}]+\}$/.test(spec) ||
          (spec.includes("{") && segmentPattern(spec).test(callSegments[i])),
      )
    );
  });
}

/** Matches a partial template segment such as `{adapterType}.txt`. */
function segmentPattern(specSegment: string): RegExp {
  const escaped = specSegment
    .split(/\{[^}]+\}/)
    .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join("[^/]+")}$`);
}

function listSourceFiles(root: string, filter: (file: string) => boolean): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full, filter));
    else if (filter(full)) files.push(full);
  }
  return files.sort();
}

const isSourceFile = (file: string) =>
  file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes(`${path.sep}__tests__${path.sep}`);

export interface CoverageInputs {
  repoRoot: string;
  operations: SpecOperation[];
  /** Exports of `@paperclipai/shared`, used to resolve shared path constants and builders. */
  sharedConstants?: Record<string, unknown>;
}

export interface CoverageResult {
  operations: SpecOperation[];
  uiCalls: ClientCall[];
  cliCalls: ClientCall[];
  uiByOperation: Map<string, ClientCall[]>;
  cliByOperation: Map<string, ClientCall[]>;
  uiUndocumented: ClientCall[];
  cliUndocumented: ClientCall[];
  /** Calls with a runtime segment where the spec has a literal, e.g. `/api/${resource}`. */
  dynamicCalls: ClientCall[];
}

export const operationId = (operation: { method: string; path: string }) => `${operation.method} ${operation.path}`;

/** Scans the UI and CLI sources and joins their calls to spec operations. */
export function collectCoverage({ repoRoot, operations, sharedConstants = {} }: CoverageInputs): CoverageResult {
  const read = (file: string) => fs.readFileSync(file, "utf8");
  const relative = (file: string) => path.relative(repoRoot, file).split(path.sep).join("/");
  const uiCalls = listSourceFiles(path.join(repoRoot, "ui/src/api"), isSourceFile).flatMap((file) =>
    extractUiCalls(relative(file), read(file), sharedConstants),
  );
  const cliIndex = "cli/src/index.ts";
  const prefixes = findCliRegistrationPrefixes(read(path.join(repoRoot, cliIndex)), cliIndex);
  const cliCalls = listSourceFiles(path.join(repoRoot, "cli/src/commands"), isSourceFile).flatMap((file) =>
    extractCliCalls(relative(file), read(file), {
      sharedConstants,
      registrationPrefix: prefixes.get(relative(file)),
    }),
  );
  const dynamicCalls: ClientCall[] = [];
  const join = (calls: ClientCall[]) => {
    const byOperation = new Map<string, ClientCall[]>();
    const undocumented: ClientCall[] = [];
    for (const call of calls) {
      if (call.path === null) continue;
      const operation = matchOperation(call.method, call.path, operations);
      if (!operation) {
        if (looselyMatchingOperations(call.method, call.path, operations).length > 0) dynamicCalls.push(call);
        else undocumented.push(call);
        continue;
      }
      const key = operationId(operation);
      byOperation.set(key, [...(byOperation.get(key) ?? []), call]);
    }
    return { byOperation, undocumented };
  };
  const ui = join(uiCalls);
  const cli = join(cliCalls);
  return {
    operations,
    uiCalls,
    cliCalls,
    uiByOperation: ui.byOperation,
    cliByOperation: cli.byOperation,
    uiUndocumented: ui.undocumented,
    cliUndocumented: cli.undocumented,
    dynamicCalls,
  };
}

const ACCESS_LABELS: Record<ApiKeyAccess, string> = {
  public: "public",
  "board-key": "board key",
  "board-key+instance-admin": "board key (instance admin)",
  "board-or-agent-key": "board or agent key",
  "agent-run-jwt": "no (agent run JWT)",
  "runtime-token": "no (runtime token)",
};

const escapeCell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");

const codeList = (values: Iterable<string>) => [...new Set(values)].map((value) => `\`${value}\``).join(", ");

/** CLI calls made inside a command's action handler (not from shared helper code). */
const isCliCommand = (call: ClientCall) => call.label.includes(" ");

/** How the CLI reaches one operation. */
type CliCoverage =
  | { kind: "command"; labels: string[] }
  | { kind: "helper"; files: string[] }
  | { kind: "generic"; sources: string[] }
  | { kind: "none" };

function cliCoverage(
  operation: SpecOperation,
  cliByOperation: Map<string, ClientCall[]>,
  genericCliCalls: ClientCall[],
  operations: SpecOperation[],
): CliCoverage {
  const calls = cliByOperation.get(operationId(operation)) ?? [];
  const commands = calls.filter(isCliCommand);
  if (commands.length > 0) return { kind: "command", labels: commands.map((call) => call.label) };
  if (calls.length > 0) return { kind: "helper", files: calls.map((call) => call.file) };
  const generic = genericCliCalls.filter(
    (call) =>
      call.path !== null &&
      looselyMatchingOperations(call.method, call.path, operations).some(
        (candidate) => operationId(candidate) === operationId(operation),
      ),
  );
  if (generic.length > 0) return { kind: "generic", sources: generic.map((call) => `${call.file}:${call.line}`) };
  return { kind: "none" };
}

/** Renders the matrix document. */
export function renderCoverageMarkdown(result: CoverageResult): string {
  const { operations, uiByOperation, cliByOperation } = result;
  const keyUsable = (operation: SpecOperation) => !["agent-run-jwt", "runtime-token"].includes(operation.access);
  const genericCliCalls = result.dynamicCalls.filter((call) => call.file.startsWith("cli/"));
  const coverage = new Map(
    operations.map((operation) => [
      operationId(operation),
      cliCoverage(operation, cliByOperation, genericCliCalls, operations),
    ]),
  );
  const cliKind = (operation: SpecOperation) => coverage.get(operationId(operation))?.kind ?? "none";
  const uiOps = operations.filter((operation) => uiByOperation.has(operationId(operation)));
  const uiOpsWithoutCli = uiOps.filter(
    (operation) => keyUsable(operation) && (cliKind(operation) === "none" || cliKind(operation) === "helper"),
  );
  const uiOpsGenericCli = uiOps.filter((operation) => cliKind(operation) === "generic");
  const unresolvedUi = [
    ...result.uiCalls.filter((call) => call.path === null),
    ...result.dynamicCalls.filter((call) => call.file.startsWith("ui/")),
  ];
  const unresolvedCli = [
    ...result.cliCalls.filter((call) => call.path === null),
    ...result.dynamicCalls.filter((call) => call.file.startsWith("cli/")),
  ];
  const countBy = (predicate: (operation: SpecOperation) => boolean) => operations.filter(predicate).length;

  const lines: string[] = [];
  lines.push("# API / CLI coverage matrix");
  lines.push("");
  lines.push("<!-- Generated by server/scripts/api-coverage-matrix.ts. Do not edit by hand. -->");
  lines.push("");
  lines.push(
    "Regenerate with `pnpm --filter @paperclipai/server api:coverage`. Ranked gaps and the PR plan live in " +
      "[`doc/plans/2026-10-09-api-cli-operator-parity.md`](plans/2026-10-09-api-cli-operator-parity.md).",
  );
  lines.push("");
  lines.push("## How to read it");
  lines.push("");
  lines.push("- **Operation:** an operation in the generated OpenAPI document (`GET /api/openapi.json`).");
  lines.push(
    "  `server/src/__tests__/openapi-routes.test.ts` fails when a mounted route is missing from the document, and " +
      "`server/src/__tests__/api-coverage-matrix.test.ts` fails when the UI client or the CLI calls a route that isn't in it.",
  );
  lines.push(
    "- **API key:** the credential the document declares (`x-paperclip-authorization`). `board key` means a board API key " +
      "(`Authorization: Bearer <key>`) is accepted, not only a browser session. Route handlers can add stricter checks; " +
      "known runtime exceptions are listed in the plan doc.",
  );
  lines.push("- **UI caller:** the board UI client function (`ui/src/api/*.ts`) that calls the operation.");
  lines.push(
    "- **CLI:** the `paperclipai` command whose handler calls the operation. `**missing**` means the UI calls it and no " +
      "command does; `helper only` means only shared CLI code calls it; `unknown` means a generic command (one that " +
      "builds the path from its arguments) may reach it.",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Measure | Count |");
  lines.push("|---|---|");
  lines.push(`| Documented operations | ${operations.length} |`);
  lines.push(`| Usable with a board API key | ${countBy((o) => o.access.startsWith("board"))} |`);
  lines.push(`| Instance-admin only | ${countBy((o) => o.access === "board-key+instance-admin")} |`);
  lines.push(`| Public | ${countBy((o) => o.access === "public")} |`);
  lines.push(`| Agent-run or runtime token only | ${countBy((o) => !keyUsable(o))} |`);
  lines.push(`| Called by the board UI | ${uiOps.length} |`);
  lines.push(`| Called by a CLI command | ${operations.filter((o) => cliKind(o) === "command").length} |`);
  lines.push(`| **Called by the UI but no CLI command** | **${uiOpsWithoutCli.length}** |`);
  lines.push(`| Called by the UI; a generic CLI command may reach it | ${uiOpsGenericCli.length} |`);
  lines.push(`| UI calls not statically resolved | ${unresolvedUi.length} |`);
  lines.push(`| CLI calls not statically resolved | ${unresolvedCli.length} |`);
  lines.push("");

  const tags = [...new Set(operations.map((operation) => operation.tag))].sort();
  lines.push("## UI operations without a CLI command, by tag");
  lines.push("");
  lines.push("| Tag | UI operations | Without CLI |");
  lines.push("|---|---|---|");
  for (const tag of tags) {
    const tagUi = uiOps.filter((operation) => operation.tag === tag);
    if (tagUi.length === 0) continue;
    const missing = uiOpsWithoutCli.filter((operation) => operation.tag === tag).length;
    lines.push(`| ${escapeCell(tag)} | ${tagUi.length} | ${missing} |`);
  }
  lines.push("");

  lines.push("## Matrix");
  lines.push("");
  for (const tag of tags) {
    lines.push(`### ${tag}`);
    lines.push("");
    lines.push("| Operation | Summary | API key | UI caller | CLI |");
    lines.push("|---|---|---|---|---|");
    for (const operation of operations.filter((entry) => entry.tag === tag)) {
      const key = operationId(operation);
      const ui = codeList((uiByOperation.get(key) ?? []).map((call) => call.label));
      const reach = coverage.get(key) ?? { kind: "none" };
      const cliCell =
        reach.kind === "command"
          ? codeList(reach.labels)
          : reach.kind === "helper"
            ? `${ui && keyUsable(operation) ? "**missing** — " : ""}helper only: ${codeList(reach.files)}`
            : reach.kind === "generic"
              ? `unknown: generic call at ${codeList(reach.sources)}`
              : ui && keyUsable(operation)
                ? "**missing**"
                : "";
      lines.push(
        `| \`${operation.method} ${escapeCell(operation.path)}\` | ${escapeCell(operation.summary)} | ${ACCESS_LABELS[operation.access]} | ${ui} | ${cliCell} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Calls the scanner could not resolve");
  lines.push("");
  lines.push(
    "These build their path at runtime (or dispatch generically, e.g. `/api/${resource}`). Their operations may be " +
      "reported above as having no caller.",
  );
  lines.push("");
  lines.push("| Source | Method | Path expression |");
  lines.push("|---|---|---|");
  for (const call of [...unresolvedUi, ...unresolvedCli]) {
    lines.push(
      `| \`${call.file}:${call.line}\` | ${call.method} | \`${escapeCell(call.raw.replace(/\s+/g, " "))}\` |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Loads `@paperclipai/shared` and every subpath the UI or CLI sources import
 * from it, so shared path constants and builders resolve. A failure to load
 * the root package is fatal: the matrix would silently lose resolved calls.
 */
export async function loadSharedConstants(repoRoot: string): Promise<Record<string, unknown>> {
  const specifiers = new Set(["@paperclipai/shared"]);
  const files = [
    ...listSourceFiles(path.join(repoRoot, "ui/src/api"), isSourceFile),
    ...listSourceFiles(path.join(repoRoot, "cli/src/commands"), isSourceFile),
  ];
  for (const file of files) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(/from\s+["'](@paperclipai\/shared(?:\/[\w./-]+)?)["']/g)) {
      specifiers.add(match[1]);
    }
  }
  const constants: Record<string, unknown> = { ...(await import("@paperclipai/shared")) };
  for (const specifier of specifiers) {
    if (specifier === "@paperclipai/shared") continue;
    try {
      Object.assign(constants, await import(specifier));
    } catch (error) {
      console.warn(`Skipping ${specifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return constants;
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../..");
  const { buildOpenApiSpec } = await import("../src/routes/openapi.js");
  const sharedConstants = await loadSharedConstants(repoRoot);
  const operations = loadSpecOperations(buildOpenApiSpec());
  const result = collectCoverage({ repoRoot, operations, sharedConstants });
  const outFile = path.join(repoRoot, "doc/api-coverage-matrix.md");
  fs.writeFileSync(outFile, renderCoverageMarkdown(result));
  console.log(`Wrote ${path.relative(repoRoot, outFile)} (${operations.length} operations)`);
  if (result.uiUndocumented.length || result.cliUndocumented.length) {
    console.warn("Calls without a documented operation:");
    for (const call of [...result.uiUndocumented, ...result.cliUndocumented]) {
      console.warn(`  ${call.method} ${call.path}  (${call.file}:${call.line})`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
