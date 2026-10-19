/**
 * Builds the board UI into a scratch directory and reports what ships on first load.
 *
 *   node tests/perf/web-app/bundle-report.mjs                 # print report, write tmp/perf/bundle.json
 *   node tests/perf/web-app/bundle-report.mjs --check tests/perf/web-app/bundle-budget.json
 *
 * "Initial" is the entry chunk plus everything it statically imports (what the
 * browser must fetch and execute before the first route can render).
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const checkIndex = args.indexOf("--check");
const budgetPath = checkIndex >= 0 ? args[checkIndex + 1] : null;
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : "tmp/perf/bundle.json";
const scratchDir = path.resolve("tmp/perf/dist-analysis");

const uiDir = path.resolve("ui");
const requireFromUi = createRequire(path.join(uiDir, "package.json"));
const { build } = await import(pathToFileURL(requireFromUi.resolve("vite")).href);

const collected = { chunks: [] };

const reportPlugin = {
  name: "perf-bundle-report",
  generateBundle(_options, bundle) {
    for (const item of Object.values(bundle)) {
      if (item.type !== "chunk") continue;
      collected.chunks.push({
        file: item.fileName,
        isEntry: item.isEntry,
        isDynamicEntry: item.isDynamicEntry,
        imports: item.imports,
        dynamicImports: item.dynamicImports,
        raw: Buffer.byteLength(item.code),
        gzip: zlib.gzipSync(item.code, { level: 9 }).length,
        brotli: zlib.brotliCompressSync(item.code).length,
        modules: Object.fromEntries(Object.entries(item.modules).map(([id, m]) => [id, m.renderedLength])),
      });
    }
  },
};

await build({
  root: uiDir,
  configFile: path.join(uiDir, "vite.config.ts"),
  logLevel: "warn",
  plugins: [reportPlugin],
  build: { outDir: scratchDir, emptyOutDir: true, reportCompressedSize: false },
});

const byFile = new Map(collected.chunks.map((c) => [c.file, c]));
const entry = collected.chunks.find((c) => c.isEntry);
const initial = new Set();
(function walk(file) {
  if (initial.has(file)) return;
  initial.add(file);
  for (const dep of byFile.get(file)?.imports ?? []) walk(dep);
})(entry.file);

function groupOf(id) {
  const clean = id.split("?")[0];
  const nm = clean.lastIndexOf("/node_modules/");
  if (nm >= 0) {
    const rest = clean.slice(nm + "/node_modules/".length).split("/");
    return rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  }
  const ui = clean.indexOf("/ui/src/");
  if (ui >= 0) {
    const rest = clean.slice(ui + "/ui/src/".length).split("/");
    if (rest[0] === "pages") {
      return rest.length === 2 ? `page:${rest[1].replace(/\.(production\.)?tsx?$/, "")}` : `pages/${rest[1]}/*`;
    }
    return rest.length > 2 ? `src/${rest[0]}/${rest[1]}` : `src/${rest[0]}`;
  }
  const pkg = clean.indexOf("/packages/");
  if (pkg >= 0) return `workspace:${clean.slice(pkg + "/packages/".length).split("/").slice(0, 2).join("/")}`;
  return "other";
}

const initialChunks = [...initial].map((f) => byFile.get(f));
const initialTotals = initialChunks.reduce(
  (t, c) => ({ raw: t.raw + c.raw, gzip: t.gzip + c.gzip, brotli: t.brotli + c.brotli }),
  { raw: 0, gzip: 0, brotli: 0 },
);
const lazyChunks = collected.chunks.filter((c) => !initial.has(c.file));
const lazyTotals = lazyChunks.reduce((t, c) => t + c.raw, 0);

const groups = new Map();
for (const c of initialChunks) {
  for (const [id, size] of Object.entries(c.modules)) {
    const g = groupOf(id);
    groups.set(g, (groups.get(g) ?? 0) + size);
  }
}
const sortedGroups = [...groups.entries()].sort((a, b) => b[1] - a[1]);
const topGroups = sortedGroups.slice(0, 45);
const renderedTotal = sortedGroups.reduce((sum, [, bytes]) => sum + bytes, 0);
const sumWhere = (test) => sortedGroups.filter(([group]) => test(group)).reduce((sum, [, bytes]) => sum + bytes, 0);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const report = {
  initial: { chunks: initialChunks.length, ...initialTotals },
  entry: { file: entry.file, raw: entry.raw, gzip: entry.gzip },
  lazy: { chunks: lazyChunks.length, raw: lazyTotals },
  topInitialGroups: topGroups.map(([group, bytes]) => ({ group, bytes })),
  largestLazy: [...lazyChunks].sort((a, b) => b.raw - a.raw).slice(0, 15).map((c) => ({ file: c.file, raw: c.raw, gzip: c.gzip })),
  largestInitial: [...initialChunks].sort((a, b) => b.raw - a.raw).slice(0, 12).map((c) => ({ file: c.file, raw: c.raw, gzip: c.gzip })),
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ ...report, chunks: collected.chunks.map(({ modules, ...rest }) => rest) }, null, 2));

console.log(`Initial JS: ${report.initial.chunks} chunks, ${kb(initialTotals.raw)} raw, ${kb(initialTotals.gzip)} gzip, ${kb(initialTotals.brotli)} brotli`);
console.log(`Entry chunk: ${report.entry.file} ${kb(entry.raw)} raw / ${kb(entry.gzip)} gzip`);
console.log(`Lazy: ${report.lazy.chunks} chunks, ${kb(lazyTotals)} raw`);
console.log("\nTop contributors to initial JS. Sizes are rendered bytes BEFORE minification, so use the share, not the KB, to compare with chunk sizes:");
for (const g of report.topInitialGroups) console.log(`  ${kb(g.bytes).padStart(8)}  ${((g.bytes / renderedTotal) * 100).toFixed(1).padStart(5)}%  ${g.group}`);
const pageShare = sumWhere((g) => g.startsWith("page:") || g.startsWith("pages/"));
const componentShare = sumWhere((g) => g.startsWith("src/components"));
const sharedShare = sumWhere((g) => g.startsWith("workspace:shared"));
console.log(`\nShares of initial JS: pages ${((pageShare / renderedTotal) * 100).toFixed(0)}%, components ${((componentShare / renderedTotal) * 100).toFixed(0)}%, @paperclipai/shared ${((sharedShare / renderedTotal) * 100).toFixed(0)}% (rendered total ${kb(renderedTotal)})`);
console.log("\nLargest initial chunks:");
for (const c of report.largestInitial) console.log(`  ${kb(c.raw).padStart(8)} / ${kb(c.gzip).padStart(7)} gz  ${c.file}`);

if (budgetPath) {
  const budget = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
  const failures = [];
  const limit = (name, actual, max) => {
    if (actual > max) failures.push(`${name}: ${kb(actual)} exceeds budget ${kb(max)}`);
  };
  limit("initial JS (gzip)", initialTotals.gzip, budget.initialJsGzipBytes);
  limit("initial JS (raw)", initialTotals.raw, budget.initialJsRawBytes);
  limit("entry chunk (raw)", entry.raw, budget.entryChunkRawBytes);
  if (failures.length) {
    console.error(`\nBundle budget exceeded:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nBundle budget OK");
}
