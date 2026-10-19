#!/usr/bin/env node
// Test double for the `gh` binary, run by factory-kpi-github.test.mjs through the real child-process path.
// It records its arguments and environment next to KPI_STUB_OUT and answers with KPI_STUB_STDOUT.
import { writeFileSync } from "node:fs";

const out = process.env.KPI_STUB_OUT;
writeFileSync(`${out}.argv`, JSON.stringify(process.argv.slice(2)));
writeFileSync(`${out}.env`, JSON.stringify(process.env));
process.stdout.write(process.env.KPI_STUB_STDOUT ?? '{"data":{"ok":1}}');
process.exit(Number(process.env.KPI_STUB_EXIT ?? 0));
