import { describe, expect, it } from "vitest";
import { diffConfigRevision, diffConfigLeaves } from "../commands/client/config-diff.js";

describe("diffConfigLeaves", () => {
  it("reports changed, added, and removed leaves with dotted paths", () => {
    const before = {
      name: "Builder",
      adapterConfig: { model: "gpt-5", cwd: "/repo", env: { A: { type: "plain", value: "1" } } },
      runtimeConfig: { heartbeat: { intervalSec: 300 } },
    };
    const after = {
      name: "Builder",
      adapterConfig: { model: "gpt-5.1", env: { A: { type: "plain", value: "1" }, B: { type: "plain", value: "2" } } },
      runtimeConfig: { heartbeat: { intervalSec: 600 } },
    };

    expect(diffConfigLeaves(before, after)).toEqual([
      { path: "adapterConfig.cwd", kind: "removed", before: "/repo", after: null },
      { path: "adapterConfig.env.B", kind: "added", before: null, after: { type: "plain", value: "2" } },
      { path: "adapterConfig.model", kind: "changed", before: "gpt-5", after: "gpt-5.1" },
      { path: "runtimeConfig.heartbeat.intervalSec", kind: "changed", before: 300, after: 600 },
    ]);
  });

  it("compares arrays as whole values and ignores key order", () => {
    const before = { capabilities: "x", tags: ["a", "b"], meta: { b: 1, a: 2 } };
    const after = { meta: { a: 2, b: 1 }, tags: ["a", "b", "c"], capabilities: "x" };

    expect(diffConfigLeaves(before, after)).toEqual([
      { path: "tags", kind: "changed", before: ["a", "b"], after: ["a", "b", "c"] },
    ]);
  });

  it("treats a type change between object and scalar as one leaf change", () => {
    expect(diffConfigLeaves({ metadata: null }, { metadata: { owner: "ops" } })).toEqual([
      { path: "metadata", kind: "changed", before: null, after: { owner: "ops" } },
    ]);
  });

  it("returns no changes for equal snapshots", () => {
    expect(diffConfigLeaves({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } })).toEqual([]);
  });

  it("quotes path segments that are not plain identifiers", () => {
    expect(diffConfigLeaves({ env: { "MY-KEY": 1 } }, { env: { "MY-KEY": 2 } })).toEqual([
      { path: 'env["MY-KEY"]', kind: "changed", before: 1, after: 2 },
    ]);
  });
});

describe("diffConfigRevision", () => {
  it("keeps the server changedKeys and lists keys whose change is hidden by redaction", () => {
    const diff = diffConfigRevision({
      changedKeys: ["adapterConfig", "name"],
      beforeConfig: { name: "A", adapterConfig: { env: { TOKEN: { type: "plain", value: "***REDACTED***" } } } },
      afterConfig: { name: "B", adapterConfig: { env: { TOKEN: { type: "plain", value: "***REDACTED***" } } } },
    });

    expect(diff).toEqual({
      changedKeys: ["adapterConfig", "name"],
      changes: [{ path: "name", kind: "changed", before: "A", after: "B" }],
      redactedOnlyKeys: ["adapterConfig"],
    });
  });

  it("derives changedKeys from the leaf changes when the record has none", () => {
    const diff = diffConfigRevision({
      beforeConfig: { title: null },
      afterConfig: { title: "Lead" },
    });

    expect(diff.changedKeys).toEqual(["title"]);
    expect(diff.redactedOnlyKeys).toEqual([]);
  });
});
