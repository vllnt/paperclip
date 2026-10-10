import { describe, expect, it } from "vitest";
import { queryKeys } from "./queryKeys";

describe("project query keys", () => {
  it("separates default and includeArchived project list caches", () => {
    expect(queryKeys.projects.list("company-1")).toEqual([
      "projects",
      "company-1",
      { includeArchived: false },
    ]);
    expect(queryKeys.projects.list("company-1", { includeArchived: true })).toEqual([
      "projects",
      "company-1",
      { includeArchived: true },
    ]);
    expect(queryKeys.projects.list("company-1")).not.toEqual(
      queryKeys.projects.list("company-1", { includeArchived: true }),
    );
    expect(queryKeys.projects.all("company-1")).toEqual(["projects", "company-1"]);
  });
});

describe("audit query keys", () => {
  it("separates entity-scoped activity from the unscoped feed", () => {
    const unscoped = queryKeys.audit.agentActions("company-1", { actorScope: "all" });
    const routine = queryKeys.audit.agentActions("company-1", {
      actorScope: "all",
      entityType: "routine",
      entityId: "routine-1",
    });

    expect(routine).not.toEqual(unscoped);
    expect(routine).toContain("routine-1");
  });
});

describe("routine query keys", () => {
  it("keeps the unfiltered key unchanged and nests filtered lists under it", () => {
    const all = queryKeys.routines.list("company-1");
    expect(all).toEqual(["routines", "company-1", "__all-projects__"]);
    expect(queryKeys.routines.list("company-1", { projectId: "project-1" })).toEqual(["routines", "company-1", "project-1"]);
    // Empty filters share the unfiltered cache entry.
    expect(queryKeys.routines.list("company-1", { q: "", status: null })).toEqual(all);

    const filtered = queryKeys.routines.list("company-1", { q: "weekly", assigneeAgentId: "agent-1", trigger: null });
    expect(filtered).toEqual(["routines", "company-1", "__all-projects__", { q: "weekly", assigneeAgentId: "agent-1" }]);
    // Invalidating the unfiltered list (what every routine mutation does) is a prefix of each filtered list.
    expect(filtered.slice(0, all.length)).toEqual(all);
    expect(queryKeys.routines.list("company-1", { status: "paused" })).not.toEqual(filtered);
  });
});
