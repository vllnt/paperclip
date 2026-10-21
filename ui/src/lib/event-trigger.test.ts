import { describe, expect, it } from "vitest";
import type { EventRoutineTrigger } from "@/api/eventSources";
import {
  DEFAULT_GROUP_KEY,
  buildEventTriggerPayload,
  defaultEventDraft,
  describeEventMatch,
  describeEventTrigger,
  eventDraftFromTrigger,
  eventSourcePatch,
  hasLabelFilter,
  newLabelPair,
  normalizeEventDraft,
  validateEventDraft,
  validateGroupKeyTemplate,
  withLabelFilter,
} from "./event-trigger";

const SOURCE_ID = "3f0c5f6e-0000-4000-8000-000000000001";
const BUILT_IN = { id: "3f0c5f6e-0000-4000-8000-0000000000aa", normalizer: "paperclip_v1" } as const;
const GATUS = { id: SOURCE_ID, normalizer: "gatus" } as const;

function validDraft() {
  return { ...defaultEventDraft(), sourceId: SOURCE_ID };
}

describe("validateGroupKeyTemplate", () => {
  it("accepts the default template without warnings", () => {
    expect(validateGroupKeyTemplate(DEFAULT_GROUP_KEY)).toEqual({
      error: null,
      warnings: [],
      unknownPlaceholders: [],
    });
  });

  it("accepts every supported placeholder, including label keys", () => {
    const check = validateGroupKeyTemplate(
      "{{source}}/{{type}}/{{severity}}/{{labels.host_id}}/{{ dedupeKey }}",
    );
    expect(check.error).toBeNull();
    expect(check.warnings).toEqual([]);
  });

  it("rejects an unknown placeholder and names it", () => {
    const check = validateGroupKeyTemplate("{{source}}:{{host}}");
    expect(check.error).toContain("{{host}}");
    expect(check.unknownPlaceholders).toEqual(["host"]);
  });

  it("rejects a label placeholder with an invalid key", () => {
    expect(validateGroupKeyTemplate("{{labels.Host-Id}}").error).toContain("{{labels.Host-Id}}");
    expect(validateGroupKeyTemplate("{{labels.}}").error).not.toBeNull();
  });

  it("rejects an empty template and unbalanced braces", () => {
    expect(validateGroupKeyTemplate("   ").error).toContain("Enter a group key");
    expect(validateGroupKeyTemplate("{{source}}:{{dedupeKey").error).toContain("Unbalanced");
  });

  it("warns, without blocking, when dedupeKey is missing", () => {
    const check = validateGroupKeyTemplate("{{source}}:{{type}}");
    expect(check.error).toBeNull();
    expect(check.warnings[0]).toContain("{{dedupeKey}}");
  });

  it("warns about a fixed key", () => {
    const check = validateGroupKeyTemplate("all-alerts");
    expect(check.error).toBeNull();
    expect(check.warnings[0]).toContain("one group");
  });
});

describe("validateEventDraft", () => {
  it("passes the default draft once a source is chosen", () => {
    expect(validateEventDraft(validDraft()).valid).toBe(true);
  });

  it("requires a source", () => {
    const result = validateEventDraft(defaultEventDraft());
    expect(result.valid).toBe(false);
    expect(result.errors.source).toBeTruthy();
  });

  it("surfaces the groupKey error inline", () => {
    const result = validateEventDraft({ ...validDraft(), groupKey: "{{nope}}" });
    expect(result.valid).toBe(false);
    expect(result.errors.groupKey).toContain("{{nope}}");
  });

  it("validates emitter and type names", () => {
    expect(validateEventDraft({ ...validDraft(), sources: ["Gatus"] }).errors.sources).toContain("Gatus");
    expect(validateEventDraft({ ...validDraft(), types: ["disk usage"] }).errors.types).toContain("disk usage");
    expect(validateEventDraft({ ...validDraft(), types: ["disk.*", "gatus.endpoint"] }).valid).toBe(true);
  });

  it("validates label filters", () => {
    const with_ = (pairs: ReturnType<typeof newLabelPair>[]) =>
      validateEventDraft({ ...validDraft(), labels: pairs }).errors.labels;
    expect(with_([newLabelPair("", ["a"])])).toContain("name");
    expect(with_([newLabelPair("Host", ["a"])])).toContain("Host");
    expect(with_([newLabelPair("host_id", [])])).toContain("at least one value");
    expect(with_([newLabelPair("host_id", ["a"]), newLabelPair("host_id", ["b"])])).toContain("twice");
    expect(with_([newLabelPair("host_id", ["a", "b"])])).toBeUndefined();
  });

  it("validates the cooldown and the append target", () => {
    expect(validateEventDraft({ ...validDraft(), cooldownMinutes: "" }).errors.cooldown).toBeTruthy();
    expect(validateEventDraft({ ...validDraft(), cooldownMinutes: "-1" }).errors.cooldown).toBeTruthy();
    expect(validateEventDraft({ ...validDraft(), cooldownMinutes: "0" }).valid).toBe(true);
    expect(
      validateEventDraft({ ...validDraft(), issueMode: "append", appendToIssueId: "ISSUE-1" }).errors
        .appendToIssueId,
    ).toBeTruthy();
    expect(
      validateEventDraft({ ...validDraft(), issueMode: "append", appendToIssueId: SOURCE_ID }).valid,
    ).toBe(true);
  });
});

describe("buildEventTriggerPayload", () => {
  it("builds the wire shape with defaults", () => {
    expect(buildEventTriggerPayload(validDraft())).toEqual({
      eventSourceId: SOURCE_ID,
      eventMatch: {},
      eventGrouping: {
        groupKey: DEFAULT_GROUP_KEY,
        repeatCommentCooldownSec: 900,
        rewakeOnSeverityIncrease: true,
        onRecovery: "comment_and_wake",
        issueMode: "group",
      },
      fallback: false,
    });
  });

  it("keeps a single label value as a string and several as an any-of list", () => {
    const payload = buildEventTriggerPayload({
      ...validDraft(),
      sources: ["gatus"],
      types: ["disk.*"],
      minSeverity: "warning",
      labels: [newLabelPair("host_id", ["example-host"]), newLabelPair("check", ["disk.usage", "disk.inodes"])],
      fallback: true,
      cooldownMinutes: "1.5",
      onRecovery: "comment_only",
      issueMode: "append",
      appendToIssueId: SOURCE_ID,
    });
    expect(payload.eventMatch).toEqual({
      sources: ["gatus"],
      types: ["disk.*"],
      minSeverity: "warning",
      labels: { host_id: "example-host", check: ["disk.usage", "disk.inodes"] },
    });
    expect(payload.eventGrouping).toMatchObject({
      repeatCommentCooldownSec: 90,
      onRecovery: "comment_only",
      issueMode: { appendToIssueId: SOURCE_ID },
    });
    expect(payload.fallback).toBe(true);
  });
});

describe("eventDraftFromTrigger", () => {
  const trigger = {
    id: "t1",
    kind: "event",
    eventSourceId: SOURCE_ID,
    eventMatch: { types: ["disk.*"], minSeverity: "critical", labels: { host_id: ["a", "b"], check: "x" } },
    eventGrouping: {
      groupKey: "{{source}}:{{labels.host_id}}",
      repeatCommentCooldownSec: 600,
      rewakeOnSeverityIncrease: false,
      onRecovery: "ignore",
      issueMode: { appendToIssueId: SOURCE_ID },
    },
    fallback: true,
  } as unknown as EventRoutineTrigger;

  it("round-trips through the payload builder", () => {
    const draft = eventDraftFromTrigger(trigger);
    expect(draft).toMatchObject({
      sourceId: SOURCE_ID,
      types: ["disk.*"],
      minSeverity: "critical",
      cooldownMinutes: "10",
      rewakeOnSeverityIncrease: false,
      onRecovery: "ignore",
      issueMode: "append",
      appendToIssueId: SOURCE_ID,
      fallback: true,
    });
    expect(draft.labels.map((pair) => [pair.key, pair.values])).toEqual([
      ["host_id", ["a", "b"]],
      ["check", ["x"]],
    ]);
    expect(buildEventTriggerPayload(draft)).toEqual({
      eventSourceId: SOURCE_ID,
      eventMatch: trigger.eventMatch,
      eventGrouping: trigger.eventGrouping,
      fallback: true,
    });
  });

  it("falls back to defaults for a trigger without grouping", () => {
    const draft = eventDraftFromTrigger({ ...trigger, eventGrouping: null, eventMatch: null, fallback: false });
    expect(draft.groupKey).toBe(DEFAULT_GROUP_KEY);
    expect(draft.minSeverity).toBe("any");
    expect(draft.cooldownMinutes).toBe("15");
  });
});

describe("normalizeEventDraft", () => {
  it("returns defaults for junk and keeps valid saved values", () => {
    expect(normalizeEventDraft(null)).toEqual(defaultEventDraft());
    const draft = normalizeEventDraft({
      sourceId: SOURCE_ID,
      types: ["a", 3],
      minSeverity: "bogus",
      onRecovery: "nope",
      fallback: true,
    });
    expect(draft.sourceId).toBe(SOURCE_ID);
    expect(draft.types).toEqual(["a"]);
    expect(draft.minSeverity).toBe("any");
    expect(draft.onRecovery).toBe("comment_and_wake");
    expect(draft.fallback).toBe(true);
  });
});

describe("built-in Paperclip source", () => {
  it("fixes event_issue, presets the event type and drops emitter, severity and fallback", () => {
    const from = { ...validDraft(), sources: ["gatus"], types: ["disk.*"], minSeverity: "critical" as const, fallback: true };
    const patch = eventSourcePatch(from, BUILT_IN);
    expect(patch).toMatchObject({
      sourceId: BUILT_IN.id,
      sources: [],
      types: ["issue.created"],
      minSeverity: "any",
      labels: [],
      issueMode: "event_issue",
      fallback: false,
    });
  });

  it("changes nothing when the same source is chosen again", () => {
    const draft = { ...defaultEventDraft(), ...eventSourcePatch(defaultEventDraft(), BUILT_IN) };
    const edited = { ...draft, labels: [newLabelPair("created_by", ["user"])] };
    expect(eventSourcePatch(edited, BUILT_IN)).toEqual({});
  });

  it("undoes the preset when the board moves to another source, so event_issue never reaches it", () => {
    const onBuiltIn = {
      ...defaultEventDraft(),
      ...eventSourcePatch(defaultEventDraft(), BUILT_IN),
      labels: [newLabelPair("created_by", ["user"])],
    };
    const patch = eventSourcePatch(onBuiltIn, GATUS);
    expect(patch).toEqual({ sourceId: GATUS.id, types: [], labels: [], issueMode: "group" });
    expect(eventSourcePatch(onBuiltIn, null)).toMatchObject({ sourceId: "", issueMode: "group" });
  });

  it("keeps the filters when the board moves between ordinary sources", () => {
    const draft = { ...validDraft(), types: ["disk.*"] };
    expect(eventSourcePatch(draft, { id: "other", normalizer: "generic_v1" })).toEqual({ sourceId: "other" });
  });

  it("builds an event_issue trigger with the default group settings and no fallback", () => {
    const draft = {
      ...defaultEventDraft(),
      ...eventSourcePatch(defaultEventDraft(), BUILT_IN),
      labels: [newLabelPair("created_by", ["user"]), newLabelPair("label_bug", ["true"])],
      groupKey: "ignored",
      cooldownMinutes: "7",
    };
    expect(buildEventTriggerPayload({ ...draft, fallback: true })).toEqual({
      eventSourceId: BUILT_IN.id,
      eventMatch: { types: ["issue.created"], labels: { created_by: "user", label_bug: "true" } },
      eventGrouping: {
        groupKey: DEFAULT_GROUP_KEY,
        repeatCommentCooldownSec: 900,
        rewakeOnSeverityIncrease: true,
        onRecovery: "comment_and_wake",
        issueMode: "event_issue",
      },
      fallback: false,
    });
  });

  it("does not validate the hidden group settings", () => {
    const draft = {
      ...defaultEventDraft(),
      ...eventSourcePatch(defaultEventDraft(), BUILT_IN),
      groupKey: "{{nope}}",
      cooldownMinutes: "",
    };
    expect(validateEventDraft(draft).valid).toBe(true);
    expect(validateEventDraft({ ...draft, issueMode: "group" }).valid).toBe(false);
  });

  it("round-trips an event_issue trigger", () => {
    const trigger = {
      id: "t1",
      kind: "event",
      eventSourceId: BUILT_IN.id,
      eventMatch: { types: ["issue.created"], labels: { created_by: "user" } },
      eventGrouping: {
        groupKey: DEFAULT_GROUP_KEY,
        repeatCommentCooldownSec: 900,
        rewakeOnSeverityIncrease: true,
        onRecovery: "comment_and_wake",
        issueMode: "event_issue",
      },
      fallback: false,
    } as unknown as EventRoutineTrigger;
    const draft = eventDraftFromTrigger(trigger);
    expect(draft.issueMode).toBe("event_issue");
    expect(buildEventTriggerPayload(draft)).toEqual({
      eventSourceId: BUILT_IN.id,
      eventMatch: trigger.eventMatch,
      eventGrouping: trigger.eventGrouping,
      fallback: false,
    });
  });

  it("restores a saved event_issue draft and never a saved fallback with it", () => {
    const draft = normalizeEventDraft({ sourceId: BUILT_IN.id, issueMode: "event_issue", fallback: true });
    expect(draft.issueMode).toBe("event_issue");
    expect(draft.fallback).toBe(false);
  });

  it("adds a label filter once and replaces the values of an existing one", () => {
    const first = withLabelFilter([], "created_by", ["user"]);
    expect(first.map((pair) => [pair.key, pair.values])).toEqual([["created_by", ["user"]]]);
    const second = withLabelFilter(first, "created_by", ["agent"]);
    expect(second).toHaveLength(1);
    expect(second[0]?.values).toEqual(["agent"]);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(hasLabelFilter({ ...defaultEventDraft(), labels: second }, "created_by")).toBe(true);
    expect(hasLabelFilter(defaultEventDraft(), "created_by")).toBe(false);
  });
});

describe("describeEventTrigger", () => {
  const base = {
    id: "t1",
    kind: "event",
    eventSourceId: SOURCE_ID,
    eventMatch: { types: ["issue.created"], labels: { created_by: "user" } },
    fallback: false,
  };

  it("says where the steps go for an event_issue trigger", () => {
    const trigger = { ...base, eventGrouping: { issueMode: "event_issue" } } as unknown as EventRoutineTrigger;
    expect(describeEventTrigger(trigger)).toBe(
      "issue.created · created_by=user · Steps attach to the created task",
    );
  });

  it("keeps the plain filter line for a grouped trigger", () => {
    const trigger = { ...base, eventGrouping: { issueMode: "group" } } as unknown as EventRoutineTrigger;
    expect(describeEventTrigger(trigger)).toBe("issue.created · created_by=user");
  });
});

describe("describeEventMatch", () => {
  it("summarises the filters on one line", () => {
    expect(describeEventMatch(null)).toBe("Every event from the source");
    expect(
      describeEventMatch({ types: ["disk.*"], minSeverity: "warning", labels: { host_id: ["a", "b"] } }),
    ).toBe("disk.* · Warning and above · host_id=a|b");
    expect(describeEventMatch({}, true)).toBe("Fallback · Every event from the source");
  });
});
