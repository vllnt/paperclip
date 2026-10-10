import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The SSH run directory reaper claims `<root>/.paperclip-runtime/runs/<runId>`
// by looking at the leases of that run (`heartbeatRunId = runId`), and nothing
// else. That is sound because a directory is named by exactly one run id and a
// run only ever prepares its own: the heartbeat acquires the run's lease with
// `heartbeatRunId: run.id`, builds the target from that lease's `remoteCwd`, and
// hands the adapter `runId: run.id`.
//
// This test fails when a NEW file starts preparing a remote runtime. Before
// adding it to the list, check that the new caller does one of:
//   - passes the run id of the run that owns the target's lease, with the
//     target's own root (the adapters do this);
//   - passes its own `workspaceRemoteDir`, which nests the run directory under
//     that base and so keeps it out of `<root>/.paperclip-runtime/runs/`;
//   - passes `syncWorkspace: false`, which makes no run directory at all.
// A caller that passes ANOTHER run's id with the target's root would let a lease
// of one run use a directory the reaper decides by a different run's leases.
// If that is ever needed, key the reaper's claim on the directory instead of
// the run (see doc/ssh-run-directory-reaper.md, "Races").
const REVIEWED_CALLERS = [
  // Definitions and the one forwarding hop.
  "packages/adapter-utils/src/execution-target.ts",
  // Adapters: the executing run's own id, the target's own root.
  "packages/adapter-utils/src/acpx-engine/execute.ts",
  "packages/adapters/claude-local/src/server/claude-config.ts",
  "packages/adapters/claude-local/src/server/execute.ts",
  "packages/adapters/codex-local/src/server/execute.ts",
  "packages/adapters/codex-local/src/server/test.ts",
  "packages/adapters/cursor-local/src/server/execute.ts",
  "packages/adapters/gemini-local/src/server/execute.ts",
  "packages/adapters/grok-local/src/server/execute.ts",
  "packages/adapters/grok-local/src/server/test.ts",
  "packages/adapters/kimi-local/src/server/execute.ts",
  "packages/adapters/opencode-local/src/server/execute.ts",
  "packages/adapters/opencode-local/src/server/test.ts",
  "packages/adapters/pi-local/src/server/execute.ts",
  // Own base directory (agent-files/<agent>/<run>) or no run directory.
  "server/src/services/agent-directory-working-copies.ts",
  "server/src/services/agent-file-checkpoints.ts",
  "server/src/services/agent-instruction-working-copies.ts",
  // Sandbox transport only; it has no SSH run directory.
  "server/src/services/native-runtime/native-workspace-sync.ts",
];

const CALL = /\b(prepareAdapterExecutionTargetRuntime|prepareRemoteManagedRuntime|sshRunDirectory)\s*\(/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".turbo", "__tests__", "coverage"]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else if (/\.ts$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe("callers that make an SSH run directory", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");

  it("are exactly the reviewed ones", async () => {
    const found: string[] = [];
    for (const base of ["packages", "server/src", "cli/src"]) {
      for (const file of await sourceFiles(path.join(repoRoot, base)).catch(() => [])) {
        if (CALL.test(await readFile(file, "utf8"))) found.push(path.relative(repoRoot, file).split(path.sep).join("/"));
      }
    }

    // `sshRunDirectory(` is also called by the reaper's own packages; those are
    // the owners of the path rule, not callers that choose a run id.
    const owners = new Set([
      "packages/adapter-utils/src/remote-managed-runtime.ts",
    ]);
    const unreviewed = found.filter((file) => !REVIEWED_CALLERS.includes(file) && !owners.has(file)).sort();
    expect(
      unreviewed,
      "A new file prepares a remote runtime. Check it against the criteria at the top of this test before adding it to REVIEWED_CALLERS.",
    ).toEqual([]);

    // A reviewed caller that disappeared is a stale entry: delete it.
    const stale = REVIEWED_CALLERS.filter((file) => !found.includes(file)).sort();
    expect(stale, "These reviewed callers no longer call the builder. Remove them from REVIEWED_CALLERS.").toEqual([]);
  });
});
