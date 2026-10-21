/**
 * The decision step of the web-app performance harness: reads the JSON files the
 * probes wrote for a base arm and a head arm, applies the bands of one slice
 * (gate-bands.json, plan section 8) and exits non-zero when a gated row fails.
 *
 * Usage:
 *   node tests/perf/web-app/gate.mjs --slice M0 \
 *     --base 'tmp/perf/results/b1-*.json' --head 'tmp/perf/results/m0-*.json' \
 *     [--bands path] [--json out.json] [--quiet]
 *
 * --base and --head take files, directories (every *.json inside) and patterns with
 * a `*` in the last path segment, comma separated or as several arguments.
 *
 * Exit codes: 0 every gated row passes; 1 a gated row failed or is MISSING;
 * 2 the comparison is INVALID (load average moved more than 2x between the arms);
 * 3 usage or input error.
 *
 * Status of a row:
 *   PASS / FAIL         the cell is inside or outside its band
 *   MISSING             a gated row has no data (the tool did not run, or the cell is absent
 *                       from one arm); counts as a failure
 *   NOT_APPLICABLE      the probe reported `status: "not_applicable"` (the subject does not exist
 *                       yet); passes only before the slice named by the band's naAllowedBefore
 *   INFO                a row that is reported and never gated
 *
 * A file's `meta.tool` says which probe wrote it; a measure.mjs file without it is
 * recognised by its shape. A probe that measures both arms in one file (the image rows)
 * tags every row with `arm: "base" | "head"`; such a file may be given on either side.
 * Runs of the same arm are pooled by cell key; fewer than 5 runs per cell and fewer than
 * 2 rounds (files) per arm are warnings, as plan section 7 asks.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fmt, isFixtureNoise, median, percentile } from "./lib/common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MULTI = new Set(["base", "head"]);
const EPS = 1e-9;

class UsageError extends Error {}

/** `--base a b --quiet --slice M0` → { base: [a, b], quiet: true, slice: "M0" }. */
export function parseGateArgs(list) {
  const out = { base: [], head: [] };
  for (let i = 0; i < list.length; i += 1) {
    if (!list[i].startsWith("--")) continue;
    const key = list[i].slice(2);
    if (MULTI.has(key)) {
      while (list[i + 1] !== undefined && !list[i + 1].startsWith("--")) out[key].push(...list[++i].split(",").filter(Boolean));
    } else {
      const next = list[i + 1];
      out[key] = next === undefined || next.startsWith("--") ? true : list[++i];
    }
  }
  return out;
}

/** Files named by a list of file, directory and `dir/prefix-*.json` specs. */
export function expandSpecs(specs) {
  const files = [];
  for (const spec of specs) {
    if (spec.includes("*")) {
      const dir = path.dirname(spec);
      if (dir.includes("*")) throw new UsageError(`a pattern may use * only in the last path segment: ${spec}`);
      const re = new RegExp(`^${path.basename(spec).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir).sort()) if (re.test(name)) files.push(path.join(dir, name));
    } else if (fs.existsSync(spec) && fs.statSync(spec).isDirectory()) {
      for (const name of fs.readdirSync(spec).sort()) if (name.endsWith(".json")) files.push(path.join(spec, name));
    } else if (fs.existsSync(spec)) {
      files.push(spec);
    } else {
      throw new UsageError(`no such file or directory: ${spec}`);
    }
  }
  return [...new Set(files.map((f) => path.resolve(f)))];
}

/** meta.tool, or the shape of a measure.mjs file written before it set one. */
function detectTool(doc) {
  if (typeof doc.meta?.tool === "string") return doc.meta.tool;
  const sample = doc.results?.[0] ?? doc.rows?.[0];
  if (sample && "page" in sample && "profile" in sample && ("fcpMs" in sample || "lcpMs" in sample)) return "measure";
  return null;
}

function readDoc(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${error.message}`);
  }
  return {
    file,
    meta: doc.meta ?? {},
    rows: Array.isArray(doc.rows) ? doc.rows : [],
    results: Array.isArray(doc.results) ? doc.results : [],
    tool: detectTool(doc),
  };
}

/** pool[arm] = Map(tool → { files: Set, rows, results }); metas[arm] = the meta blocks of its files. */
export function loadPools(baseFiles, headFiles, warnings) {
  const pool = { base: new Map(), head: new Map() };
  const metas = { base: [], head: [] };
  const docs = new Map();
  const armedSeen = new WeakSet();
  const slot = (arm, tool) => {
    if (!pool[arm].has(tool)) pool[arm].set(tool, { files: new Set(), rows: [], results: [] });
    return pool[arm].get(tool);
  };
  for (const [cliArm, files] of [["base", baseFiles], ["head", headFiles]]) {
    for (const file of files) {
      if (!docs.has(file)) docs.set(file, readDoc(file));
      const doc = docs.get(file);
      if (!doc.tool) {
        warnings.add(`ignored ${path.basename(file)}: meta.tool is missing and the shape is not a known probe`);
        continue;
      }
      let usedByCliArm = false;
      const add = (kind, list) => {
        for (const item of list) {
          if (item && typeof item.arm === "string") {
            if (armedSeen.has(item) || !pool[item.arm]) continue;
            armedSeen.add(item);
            slot(item.arm, doc.tool)[kind].push({ ...item, _file: file });
            slot(item.arm, doc.tool).files.add(file);
            if (!metas[item.arm].includes(doc.meta)) metas[item.arm].push(doc.meta);
          } else if (item) {
            slot(cliArm, doc.tool)[kind].push({ ...item, _file: file });
            usedByCliArm = true;
          }
        }
      };
      add("rows", doc.rows);
      add("results", doc.results);
      if (usedByCliArm) {
        slot(cliArm, doc.tool).files.add(file);
        if (!metas[cliArm].includes(doc.meta)) metas[cliArm].push(doc.meta);
      }
    }
  }
  return { pool, metas };
}

const STATS = {
  median: (v) => median(v),
  p75: (v) => percentile(v, 0.75),
  max: (v) => Math.max(...v),
  min: (v) => Math.min(...v),
  sum: (v) => v.reduce((a, b) => a + b, 0),
  mean: (v) => v.reduce((a, b) => a + b, 0) / v.length,
};

function stat(values, name) {
  const v = values.filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return null;
  const fn = STATS[name];
  if (!fn) throw new UsageError(`unknown statistic ${name}`);
  return fn(v);
}

/** A number for a metric of one item: arrays count their entries, booleans are 0/1, `!ok` is 1 for a false `ok`. */
function metricOf(item, metric) {
  if (metric.startsWith("!")) return item[metric.slice(1)] === false ? 1 : 0;
  let v = item[metric];
  if (Array.isArray(v)) v = (metric === "consoleErrors" ? v.filter((t) => !isFixtureNoise(String(t))) : v).length;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v == null) return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

const UNITS = {
  ms: (v) => `${fmt(v, 0)} ms`,
  s: (v) => `${fmt(v, 1)} s`,
  bytes: (v) => `${fmt(v / 1e6, 1)} MB`,
  count: (v) => (Number.isInteger(v) ? String(v) : fmt(v, 1)),
  frac: (v) => `${fmt(v * 100, 1)}%`,
  ratio: (v) => fmt(v, 2),
};
const show = (v, unit) => (v == null ? "-" : (UNITS[unit] ?? UNITS.count)(v));
const signed = (v, unit) => (v == null ? "-" : `${v >= 0 ? "+" : "-"}${show(Math.abs(v), unit)}`);

function describeBand(band) {
  if (band.text) return band.text;
  const unit = band.unit;
  switch (band.kind) {
    case "rel-max": {
      if (!band.relPct && !band.absolute) return "head ≤ base";
      const parts = [];
      if (band.relPct) parts.push(`+${band.relPct}%`);
      if (band.absolute) parts.push(`+${show(band.absolute, unit)}`);
      return `head ≤ base ${parts.join(" or ")}${parts.length > 1 ? " (larger)" : ""}`;
    }
    case "delta-max":
      return `head ≤ base +${show(band.limit, unit)}`;
    case "abs-max":
      return `head ≤ ${show(band.limit, unit)}`;
    case "ratio-max":
      return `${band.metric} ≤ ${band.maxRatio} × ${band.refMetric}`;
    case "report":
      return `reported${band.expected ? ` (${band.expected})` : ""}`;
    case "row-check":
      return band.checks.map(describeCheck).join(", ");
    default:
      return band.kind;
  }
}

const fieldName = (field) => (Array.isArray(field) ? field[0] : field);
function describeCheck(c) {
  const f = fieldName(c.field);
  return { eq: `${f} = ${c.value}`, le: `${f} ≤ ${c.value}`, ge: `${f} ≥ ${c.value}`, absLe: `|${f}| ≤ ${c.value}`, zero: `${f} = 0`, truthy: `${f} set`, notFalse: `${f} not false` }[c.op];
}

function fieldValue(item, field) {
  for (const f of Array.isArray(field) ? field : [field]) if (item[f] !== undefined && item[f] !== null) return item[f];
  return undefined;
}

function checkOne(item, c) {
  const v = fieldValue(item, c.field);
  const num = Number(v);
  if (c.op === "notFalse") return v !== false;
  if (v === undefined) return false;
  switch (c.op) {
    case "eq":
      return typeof c.value === "number" ? num === c.value : v === c.value;
    case "le":
      return Number.isFinite(num) && num <= c.value;
    case "ge":
      return Number.isFinite(num) && num >= c.value;
    case "absLe":
      return Number.isFinite(num) && Math.abs(num) <= c.value;
    case "zero":
      return Array.isArray(v) ? v.length === 0 : !v;
    case "truthy":
      return Array.isArray(v) ? v.length > 0 : Boolean(v);
    default:
      throw new UsageError(`unknown check op ${c.op}`);
  }
}

function checkText(item, checks) {
  return checks
    .map((c) => {
      const v = fieldValue(item, c.field);
      return `${fieldName(c.field)}=${v === undefined ? "missing" : Array.isArray(v) ? v.length : String(v)}`;
    })
    .join(", ");
}

/* Route groups (plan section 15.3). */

function parsePattern(raw, allowWildcard = false) {
  let s = String(raw).trim();
  const leading = s.startsWith("/");
  let wild = false;
  if (allowWildcard && (s === "/*" || s.endsWith("/*") || s === "*")) {
    wild = true;
    s = s.replace(/\/?\*$/, "");
  }
  const segs = s.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  let prefixed = !leading;
  if (segs[0]?.startsWith(":") && /prefix|company/i.test(segs[0])) {
    prefixed = true;
    segs.shift();
  }
  return { prefixed, wild, segs: segs.map((x) => (x.startsWith(":") ? ":" : x)) };
}

function matchScore(entry, pat) {
  if (entry.prefixed !== pat.prefixed) return -1;
  const n = entry.segs.length;
  if (entry.wild ? pat.segs.length < n : pat.segs.length !== n) return -1;
  let literals = 0;
  for (let i = 0; i < n; i += 1) {
    if (entry.segs[i] === ":") continue;
    if (entry.segs[i] !== pat.segs[i]) return -1;
    literals += 1;
  }
  return entry.wild ? literals : 1000 + literals;
}

/** The slice group (M1..M10) that owns a route pattern, or null when no group names it. */
export function routeGroupOf(pattern, routeGroups) {
  const pat = parsePattern(pattern);
  let best = { group: null, score: -1 };
  for (const [group, entries] of Object.entries(routeGroups)) {
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      const score = matchScore(parsePattern(raw, true), pat);
      if (score > best.score) best = { group, score };
    }
  }
  return best.group;
}

function patternOf(item) {
  if (typeof item.pattern === "string") return item.pattern;
  const key = String(item.key ?? "");
  return key.replace(/^route\|/, "").replace(/\|\d+$/, "");
}

/* Evaluation. */

const NUMERIC_KINDS = new Set(["rel-max", "delta-max", "abs-max", "ratio-max", "report"]);
const NA_STATUS = new Set(["not_applicable", "n/a"]);
const MISSING_STATUS = new Set(["skipped", "error", "missing"]);

function cellsOf(armPool, band, ctx) {
  const data = armPool.get(band.tool);
  const cells = new Map();
  if (!data) return cells;
  const items = band.source === "rows" ? data.rows : band.source === "results" ? data.results : [...data.rows, ...data.results];
  const filter = band.cellFilter ? new RegExp(band.cellFilter) : null;
  for (const item of items) {
    let cell;
    if (band.cellFields) {
      const parts = band.cellFields.map((f) => item[f]);
      if (parts.some((p) => p === undefined || p === null)) continue;
      cell = parts.join("|");
    } else {
      cell = item.key;
    }
    if (typeof cell !== "string") continue;
    if (filter && !filter.test(cell)) continue;
    if (band.routeFilter && ctx.routeGroup && routeGroupOf(patternOf(item), ctx.routeGroups) !== ctx.routeGroup) continue;
    if (!cells.has(cell)) cells.set(cell, []);
    cells.get(cell).push(item);
  }
  return cells;
}

const isNa = (item) => NA_STATUS.has(String(item.status));
const isBlocked = (item) => MISSING_STATUS.has(String(item.status));

function result(band, cell, fields) {
  return { id: band.id, cell, base: "-", head: "-", delta: "-", band: describeBand(band), status: "FAIL", note: "", ...fields };
}

function naResult(band, cell, ctx, baseText) {
  const allowed = band.naAllowedBefore && ctx.order.indexOf(ctx.slice) < ctx.order.indexOf(band.naAllowedBefore);
  return result(band, cell, {
    base: baseText,
    head: "not_applicable",
    status: allowed ? "NOT_APPLICABLE" : "FAIL",
    note: allowed ? `allowed before ${band.naAllowedBefore}` : band.naAllowedBefore ? `not_applicable is allowed only before ${band.naAllowedBefore}` : "not_applicable is not allowed for this row",
  });
}

function evalRowCheck(band, cell, baseItems, headItems, ctx) {
  const baseText = baseItems?.length ? checkText(baseItems[0], band.checks) : "-";
  const real = headItems.filter((i) => !isNa(i));
  if (!real.length) return naResult(band, cell, ctx, baseText);
  const blocked = real.find(isBlocked);
  if (blocked) return result(band, cell, { base: baseText, head: String(blocked.status), status: "MISSING", note: `the probe reported status ${blocked.status}` });
  const failing = real.find((item) => band.checks.some((c) => !checkOne(item, c)));
  const shown = failing ?? real[0];
  const failedChecks = failing ? band.checks.filter((c) => !checkOne(failing, c)).map(describeCheck) : [];
  return result(band, cell, {
    base: baseText,
    head: checkText(shown, band.checks),
    status: failing ? "FAIL" : "PASS",
    note: failing ? `fails: ${failedChecks.join(", ")}` : "",
    n: { base: baseItems?.length ?? 0, head: real.length },
  });
}

function valueOf(items, band, metric = band.metric) {
  return stat(items.filter((i) => !isNa(i) && !isBlocked(i)).map((i) => metricOf(i, metric)), band.statistic);
}

function evalNumeric(band, cell, baseItems, headItems, ctx) {
  const unit = band.unit;
  const real = headItems.filter((i) => !isNa(i));
  if (!real.length) return naResult(band, cell, ctx, baseItems ? show(valueOf(baseItems, band), unit) : "-");
  const head = valueOf(headItems, band);
  let base = baseItems ? valueOf(baseItems, band) : null;
  const n = { base: baseItems?.length ?? 0, head: real.length };
  if (head === null) return result(band, cell, { status: "MISSING", note: `no ${band.metric} in head`, n });
  if (band.kind === "abs-max") {
    const ok = head <= band.limit + EPS;
    return result(band, cell, { base: base === null ? "-" : show(base, unit), head: show(head, unit), status: ok ? "PASS" : "FAIL", n });
  }
  if (band.kind === "ratio-max") {
    const ref = valueOf(headItems, band, band.refMetric);
    if (ref === null || ref <= 0) return result(band, cell, { head: show(head, unit), status: "MISSING", note: `no ${band.refMetric} in head`, n });
    const ratio = head / ref;
    const baseRef = baseItems ? valueOf(baseItems, band, band.refMetric) : null;
    const baseRatio = base !== null && baseRef > 0 ? base / baseRef : null;
    return result(band, cell, {
      base: baseRatio === null ? "-" : `${fmt(baseRatio, 2)}×`,
      head: `${show(head, unit)} / ${show(ref, unit)} = ${fmt(ratio, 2)}×`,
      delta: `${fmt(ratio, 2)}×`,
      status: ratio <= band.maxRatio + EPS ? "PASS" : "FAIL",
      n,
    });
  }
  if (base === null && band.noBase === "zero") base = 0;
  if (base === null) {
    const status = band.kind === "report" ? "INFO" : "MISSING";
    return result(band, cell, { head: show(head, unit), status, note: baseItems ? `no ${band.metric} in base` : "cell absent from base", n });
  }
  const diff = head - base;
  const pct = base ? ` (${diff >= 0 ? "+" : ""}${fmt((diff / Math.abs(base)) * 100, 1)}%)` : "";
  const delta = `${signed(diff, unit)}${band.kind === "delta-max" ? "" : pct}`;
  const fields = { base: show(base, unit), head: show(head, unit), delta, n };
  if (band.kind === "report") return result(band, cell, { ...fields, status: "INFO" });
  const tolerance = band.kind === "delta-max" ? band.limit : Math.max((Math.abs(base) * (band.relPct ?? 0)) / 100, band.absolute ?? 0);
  return result(band, cell, { ...fields, status: diff <= tolerance + EPS ? "PASS" : "FAIL" });
}

function evaluateBand(band, ctx) {
  const headCells = cellsOf(ctx.pool.head, band, ctx);
  const baseCells = cellsOf(ctx.pool.base, band, ctx);
  const names =[...new Set([...headCells.keys(), ...baseCells.keys()])].sort();
  if (!names.length) {
    const tool = ctx.pool.head.has(band.tool) ? "the cells of this row" : `the ${band.tool} probe`;
    return [result(band, "-", { status: band.kind === "report" ? "INFO" : "MISSING", note: `no data from ${tool}` })];
  }
  return names.map((cell) => {
    const headItems = headCells.get(cell);
    const baseItems = baseCells.get(cell);
    if (!headItems) return result(band, cell, { base: baseItems ? "present" : "-", status: band.kind === "report" ? "INFO" : "MISSING", note: "cell absent from head" });
    if (band.kind === "row-check") return evalRowCheck(band, cell, baseItems, headItems, ctx);
    if (!NUMERIC_KINDS.has(band.kind)) throw new UsageError(`unknown band kind ${band.kind} (${band.id})`);
    ctx.noteRuns(band, cell, headItems.length, baseItems?.length ?? null);
    return evalNumeric(band, cell, baseItems, headItems, ctx);
  });
}

/** The band ids a slice gates and reports, with `@group` and `*` expanded. */
export function resolveSlice(bands, slice) {
  const byId = new Map(bands.bands.map((b) => [b.id, b]));
  const cfg = bands.slices[slice];
  if (!cfg) throw new UsageError(`unknown slice ${slice}; known: ${Object.keys(bands.slices).join(", ")}`);
  const expand = (names) => {
    const ids = [];
    for (const name of names) {
      if (name === "*") ids.push(...bands.bands.filter((b) => b.kind !== "report").map((b) => b.id));
      else if (name.startsWith("@")) ids.push(...(bands.groups?.[name.slice(1)] ?? (() => { throw new UsageError(`unknown group ${name}`); })()));
      else ids.push(name);
    }
    for (const id of ids) if (!byId.has(id)) throw new UsageError(`slice ${slice} names the unknown row ${id}`);
    return [...new Set(ids)];
  };
  const report = expand(cfg.report ?? []);
  for (const id of report) if (byId.get(id).kind !== "report") throw new UsageError(`slice ${slice} reports ${id}, which is a gated row; only rows of kind "report" can be report-only`);
  const gate = expand(cfg.gate ?? []).filter((id) => byId.get(id).kind !== "report");
  return { gate, report, routeGroup: cfg.routeGroup ?? null, byId };
}

function armLoad(metas, floor) {
  const loads = metas
    .map((m) => [m.loadAvgStart, m.loadAvgEnd].filter((x) => Number.isFinite(x)))
    .filter((xs) => xs.length)
    .map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length);
  if (!loads.length) return null;
  return Math.max(floor, loads.reduce((a, b) => a + b, 0) / loads.length);
}

/** Runs the whole gate on already-read pools. Returns the report object; prints nothing. */
export function runGate({ bands, slice, pool, metas }) {
  const plan = resolveSlice(bands, slice);
  const warnings = new Set();
  const runs = new Map();
  const ctx = {
    slice,
    order: bands.sliceOrder,
    pool,
    routeGroup: plan.routeGroup,
    routeGroups: bands.routeGroups ?? {},
    noteRuns(band, cell, head, base) {
      if (band.source !== "results") return;
      const key = `${band.tool}|${cell}`;
      const n = Math.min(head, base ?? head);
      if (!runs.has(key) || runs.get(key) > n) runs.set(key, n);
    },
  };
  const rows = [];
  for (const [ids, gated] of [[plan.gate, true], [plan.report, false]]) {
    for (const id of ids) {
      for (const r of evaluateBand(plan.byId.get(id), ctx)) rows.push({ ...r, gated });
    }
  }
  const minRuns = bands.validity?.minRunsPerCell ?? 5;
  const thin = [...runs].filter(([, n]) => n < minRuns);
  if (thin.length) {
    const byTool = new Map();
    for (const [key, n] of thin) {
      const tool = key.split("|")[0];
      byTool.set(tool, [...(byTool.get(tool) ?? []), n]);
    }
    for (const [tool, ns] of byTool) warnings.add(`${tool}: ${ns.length} cell(s) have fewer than ${minRuns} runs (fewest ${Math.min(...ns)}); a verdict on them is weak`);
  }
  const minRounds = bands.validity?.minRoundsPerArm ?? 2;
  const tools = new Set(rows.filter((r) => r.gated).map((r) => plan.byId.get(r.id).tool));
  for (const tool of tools) {
    if (tool === "image") continue;
    for (const arm of ["base", "head"]) {
      const files = pool[arm].get(tool)?.files.size ?? 0;
      if (files > 0 && files < minRounds) warnings.add(`${tool}: ${arm} has ${files} round(s) of files; section 7 asks for at least ${minRounds}, interleaved`);
    }
  }
  const floor = bands.validity?.loadAvgFloor ?? 0;
  const loadBase = armLoad(metas.base, floor);
  const loadHead = armLoad(metas.head, floor);
  let validity = { valid: true, loadBase, loadHead, ratio: null, reason: null };
  if (loadBase !== null && loadHead !== null) {
    const ratio = Math.max(loadBase, loadHead) / Math.min(loadBase, loadHead);
    const max = bands.validity?.maxLoadAvgRatio ?? 2;
    validity = { valid: ratio <= max + EPS, loadBase, loadHead, ratio, reason: ratio > max + EPS ? `load average moved ${fmt(ratio, 1)}x between the arms (base ${fmt(loadBase, 1)}, head ${fmt(loadHead, 1)}); the limit is ${max}x` : null };
  } else if (rows.some((r) => r.gated)) {
    warnings.add("load average is missing from the meta of some files; the 2x validity check could not run");
  }
  const count = (s) => rows.filter((r) => r.gated && r.status === s).length;
  const summary = { pass: count("PASS"), fail: count("FAIL"), missing: count("MISSING"), notApplicable: count("NOT_APPLICABLE"), info: rows.filter((r) => r.status === "INFO").length };
  const exitCode = !validity.valid ? 2 : summary.fail + summary.missing > 0 ? 1 : 0;
  return { slice, validity, summary, rows, warnings: [...warnings], exitCode, note: bands.slices[slice].note ?? null };
}

const esc = (s) => String(s).replace(/\|/g, "\\|");

/** The markdown report. With `quiet`, PASS rows collapse to one count per row id. */
export function renderReport(report, { quiet = false, bandsById = new Map() } = {}) {
  const out = [];
  const { summary, validity } = report;
  out.push(`## gate: slice ${report.slice}`);
  if (report.note) out.push(`\n_${report.note}_`);
  if (!validity.valid) out.push(`\n**INVALID: ${validity.reason}.** Measure again with the arms interleaved under a steady load; nothing below is a verdict.`);
  else if (validity.ratio !== null) out.push(`\nload average: base ${fmt(validity.loadBase, 1)}, head ${fmt(validity.loadHead, 1)} (${fmt(validity.ratio, 2)}x, limit 2x)`);
  if (!report.rows.length) {
    out.push("\nThis slice gates no rows.");
  } else {
    out.push("\n| row | cell | base | head | delta | band | status |", "|---|---|---|---|---|---|---|");
    const passCounts = new Map();
    for (const r of report.rows) {
      if (quiet && r.gated && r.status === "PASS") {
        passCounts.set(r.id, (passCounts.get(r.id) ?? 0) + 1);
        continue;
      }
      const status = r.note ? `${r.status} (${r.note})` : r.status;
      out.push(`| ${esc(r.id)} | ${esc(r.cell)} | ${esc(r.base)} | ${esc(r.head)} | ${esc(r.delta)} | ${esc(r.band)} | ${esc(status)} |`);
    }
    for (const [id, n] of passCounts) {
      const band = bandsById.get(id);
      out.push(`| ${esc(id)} | ${n} cell(s) | | | | ${esc(band ? describeBand(band) : "")} | PASS |`);
    }
  }
  out.push(`\n**${summary.fail + summary.missing === 0 && validity.valid ? "GATE PASSES" : validity.valid ? "GATE FAILS" : "GATE INVALID"}**: PASS ${summary.pass}, FAIL ${summary.fail}, MISSING ${summary.missing}, NOT_APPLICABLE ${summary.notApplicable}, INFO ${summary.info}`);
  if (report.warnings.length) out.push("", "Warnings:", ...report.warnings.map((w) => `- ${w}`));
  return out.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const args = parseGateArgs(argv);
  if (!args.slice || args.slice === true) throw new UsageError("--slice <name> is required (H, M0, M0b, M0c, M1..M10, MF)");
  const bandsPath = typeof args.bands === "string" ? args.bands : path.join(HERE, "gate-bands.json");
  const bands = JSON.parse(fs.readFileSync(bandsPath, "utf8"));
  const plan = resolveSlice(bands, args.slice);
  const warnings = new Set();
  let pool = { base: new Map(), head: new Map() };
  let metas = { base: [], head: [] };
  if (plan.gate.length + plan.report.length > 0) {
    if (!args.base.length || !args.head.length) throw new UsageError("--base and --head are required (files, directories or patterns)");
    const baseFiles = expandSpecs(args.base);
    const headFiles = expandSpecs(args.head);
    if (!baseFiles.length) throw new UsageError(`--base matched no file: ${args.base.join(", ")}`);
    if (!headFiles.length) throw new UsageError(`--head matched no file: ${args.head.join(", ")}`);
    ({ pool, metas } = loadPools(baseFiles, headFiles, warnings));
  }
  const report = runGate({ bands, slice: args.slice, pool, metas });
  for (const w of warnings) if (!report.warnings.includes(w)) report.warnings.push(w);
  console.log(renderReport(report, { quiet: args.quiet === true, bandsById: plan.byId }));
  if (typeof args.json === "string") {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
  }
  return report.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`gate: ${error.message}`);
    process.exitCode = 3;
  }
}
