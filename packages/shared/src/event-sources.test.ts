import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_GROUPING,
  DEFAULT_EVENT_GROUP_KEY_TEMPLATE,
  EVENT_GROUP_KEY_TEMPLATE_MAX_LENGTH,
  EVENT_MAX_LABELS,
  EVENT_WIRE_SCHEMA_ID,
  createEventSourceSchema,
  eventGroupKeyTemplateSchema,
  eventGroupingSchema,
  eventMatchSchema,
  eventSeverityRank,
  gatusNormalizerConfigSchema,
  genericV1EventSchema,
  listEventDeliveriesQuerySchema,
  matchesEvent,
  matchesEventGlob,
  renderEventGroupKey,
  sanitizeEventMultiLine,
  sanitizeEventSingleLine,
  updateEventSourceSchema,
  validateEventGroupKeyTemplate,
  validateEventSourceNormalizerConfig,
  type EventMatch,
  type NormalizedEvent,
} from "./event-sources.js";
import {
  createRoutineTriggerSchema,
  routineRevisionSnapshotTriggerV1Schema,
  updateRoutineTriggerSchema,
} from "./validators/routine.js";

const GUID = "11111111-1111-4111-8111-111111111111";

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: null,
    source: "gatus",
    type: "http.down",
    severity: "critical",
    state: "problem",
    dedupeKey: "gatus:core/api",
    title: "api is failing",
    summary: "",
    labels: {},
    occurredAt: "2026-01-01T00:00:00.000Z",
    url: null,
    ...overrides,
  };
}

function validGenericBody(overrides: Record<string, unknown> = {}) {
  return {
    schema: EVENT_WIRE_SCHEMA_ID,
    source: "monitor",
    type: "disk.full",
    severity: "warning",
    state: "problem",
    dedupeKey: "host-1:/var",
    title: "Disk almost full",
    ...overrides,
  };
}

describe("sanitize helpers and severity ranking", () => {
  it("ranks severities from info to critical", () => {
    expect(eventSeverityRank("info")).toBeLessThan(eventSeverityRank("warning"));
    expect(eventSeverityRank("warning")).toBeLessThan(eventSeverityRank("critical"));
  });

  it("collapses every control character and line break in single-line text", () => {
    expect(sanitizeEventSingleLine("  a\nb\r\nc\td\u2028e\u2029f\u0000g  ")).toBe("a b c d e f g");
    expect(sanitizeEventSingleLine("x\u0085y")).toBe("x y");
  });

  it("keeps tabs and newlines in multi-line text but removes NUL and other control characters", () => {
    expect(sanitizeEventMultiLine("line1\nline2\tcol\u0000\u0007\u007f")).toBe("line1\nline2\tcol");
  });
});

describe("matchesEventGlob", () => {
  it.each([
    ["gatus", "gatus", true],
    ["gatus", "gatus2", false],
    ["http.*", "http.down", true],
    ["http.*", "http.", true],
    ["http.*", "https.down", false],
    ["*.down", "http.down", true],
    ["*.down", "http.up", false],
    ["*", "", true],
    ["*", "anything.at.all", true],
    ["a*b*c", "aXXbYYc", true],
    ["a*b*c", "aXXcYYb", false],
    ["a*b*c", "abc", true],
    ["**", "abc", true],
    ["*end", "no-match-here", false],
  ])("pattern %j against %j -> %s", (pattern, value, expected) => {
    expect(matchesEventGlob(pattern, value)).toBe(expected);
  });

  it("treats a pattern without a wildcard as a case-sensitive literal", () => {
    expect(matchesEventGlob("Http.Down", "http.down")).toBe(false);
    expect(matchesEventGlob("http.down", "http.down")).toBe(true);
  });

  it("treats regex metacharacters literally", () => {
    expect(matchesEventGlob("a.b", "aXb")).toBe(false);
    expect(matchesEventGlob("a.*", "a.b")).toBe(true);
    expect(matchesEventGlob("a?b*", "axb")).toBe(false);
    expect(matchesEventGlob("a?b*", "a?bcd")).toBe(true);
    expect(matchesEventGlob("(x+)+*", "(x+)+!")).toBe(true);
  });

  it("returns for a hostile pattern against a long value instead of backtracking", () => {
    const value = "a".repeat(5000);
    expect(matchesEventGlob("*a*a*a*a*a*a*a*a*a*b", value)).toBe(false);
    expect(matchesEventGlob("*a*a*a*a*a*a*a*a*a*", value)).toBe(true);
  });
});

describe("eventMatchSchema", () => {
  it("accepts an empty match and a fully populated one", () => {
    expect(eventMatchSchema.safeParse({}).success).toBe(true);
    expect(
      eventMatchSchema.safeParse({
        sources: ["gatus"],
        types: ["http.*", "tcp.*"],
        minSeverity: "warning",
        labels: { env: "prod", team: ["core", "platform-*"] },
      }).success,
    ).toBe(true);
  });

  it("rejects unknown keys, unknown severities and empty collections", () => {
    expect(eventMatchSchema.safeParse({ severity: "warning" }).success).toBe(false);
    expect(eventMatchSchema.safeParse({ minSeverity: "fatal" }).success).toBe(false);
    expect(eventMatchSchema.safeParse({ sources: [] }).success).toBe(false);
    expect(eventMatchSchema.safeParse({ types: [] }).success).toBe(false);
    expect(eventMatchSchema.safeParse({ labels: { env: [] } }).success).toBe(false);
  });

  it("bounds pattern length and list size", () => {
    expect(eventMatchSchema.safeParse({ sources: [""] }).success).toBe(false);
    expect(eventMatchSchema.safeParse({ sources: ["a".repeat(128)] }).success).toBe(true);
    expect(eventMatchSchema.safeParse({ sources: ["a".repeat(129)] }).success).toBe(false);
    expect(eventMatchSchema.safeParse({ types: Array.from({ length: 32 }, (_, i) => `t${i}`) }).success).toBe(true);
    expect(eventMatchSchema.safeParse({ types: Array.from({ length: 33 }, (_, i) => `t${i}`) }).success).toBe(false);
  });

  it("restricts label filter keys to the label key pattern and caps the filter count", () => {
    expect(eventMatchSchema.safeParse({ labels: { "Bad-Key": "x" } }).success).toBe(false);
    const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, "v"]));
    expect(eventMatchSchema.safeParse({ labels: many(EVENT_MAX_LABELS) }).success).toBe(true);
    expect(eventMatchSchema.safeParse({ labels: many(EVENT_MAX_LABELS + 1) }).success).toBe(false);
  });
});

describe("matchesEvent", () => {
  it("matches everything when the match is null, undefined or empty", () => {
    const event = makeEvent();
    expect(matchesEvent(null, event)).toBe(true);
    expect(matchesEvent(undefined, event)).toBe(true);
    expect(matchesEvent({}, event)).toBe(true);
  });

  it("matches source globs and requires one of them to match", () => {
    const event = makeEvent({ source: "gatus" });
    expect(matchesEvent({ sources: ["gatus"] }, event)).toBe(true);
    expect(matchesEvent({ sources: ["other", "gat*"] }, event)).toBe(true);
    expect(matchesEvent({ sources: ["other", "grafana"] }, event)).toBe(false);
  });

  it("matches type globs and requires one of them to match", () => {
    const event = makeEvent({ type: "http.down" });
    expect(matchesEvent({ types: ["http.*"] }, event)).toBe(true);
    expect(matchesEvent({ types: ["tcp.*", "http.down"] }, event)).toBe(true);
    expect(matchesEvent({ types: ["tcp.*"] }, event)).toBe(false);
  });

  it("gates problems and info events by minSeverity", () => {
    const warning: EventMatch = { minSeverity: "warning" };
    expect(matchesEvent(warning, makeEvent({ severity: "info", state: "problem" }))).toBe(false);
    expect(matchesEvent(warning, makeEvent({ severity: "warning", state: "problem" }))).toBe(true);
    expect(matchesEvent(warning, makeEvent({ severity: "critical", state: "problem" }))).toBe(true);
    expect(matchesEvent(warning, makeEvent({ severity: "info", state: "info" }))).toBe(false);
    expect(matchesEvent({ minSeverity: "critical" }, makeEvent({ severity: "warning" }))).toBe(false);
    expect(matchesEvent({ minSeverity: "info" }, makeEvent({ severity: "info" }))).toBe(true);
  });

  it("does not severity-gate a recovery", () => {
    expect(matchesEvent({ minSeverity: "critical" }, makeEvent({ severity: "info", state: "recovery" }))).toBe(true);
  });

  it("still applies the other filters to a recovery", () => {
    expect(
      matchesEvent({ minSeverity: "critical", types: ["tcp.*"] }, makeEvent({ severity: "info", state: "recovery" })),
    ).toBe(false);
  });

  it("matches a single label glob and fails when the label is absent", () => {
    expect(matchesEvent({ labels: { env: "prod" } }, makeEvent({ labels: { env: "prod" } }))).toBe(true);
    expect(matchesEvent({ labels: { env: "prod" } }, makeEvent({ labels: { env: "staging" } }))).toBe(false);
    expect(matchesEvent({ labels: { env: "pr*" } }, makeEvent({ labels: { env: "prod" } }))).toBe(true);
    expect(matchesEvent({ labels: { env: "prod" } }, makeEvent({ labels: {} }))).toBe(false);
    expect(matchesEvent({ labels: { env: "*" } }, makeEvent({ labels: {} }))).toBe(false);
    expect(matchesEvent({ labels: { env: "*" } }, makeEvent({ labels: { env: "" } }))).toBe(true);
  });

  it("treats an array of allowed label values as any-of", () => {
    const match: EventMatch = { labels: { env: ["prod", "stag*"] } };
    expect(matchesEvent(match, makeEvent({ labels: { env: "prod" } }))).toBe(true);
    expect(matchesEvent(match, makeEvent({ labels: { env: "staging" } }))).toBe(true);
    expect(matchesEvent(match, makeEvent({ labels: { env: "dev" } }))).toBe(false);
  });

  it("requires every label filter to match (all-of across keys)", () => {
    const match: EventMatch = { labels: { env: ["prod", "staging"], team: "core" } };
    expect(matchesEvent(match, makeEvent({ labels: { env: "prod", team: "core" } }))).toBe(true);
    expect(matchesEvent(match, makeEvent({ labels: { env: "prod", team: "other" } }))).toBe(false);
    expect(matchesEvent(match, makeEvent({ labels: { env: "prod" } }))).toBe(false);
    expect(matchesEvent(match, makeEvent({ labels: { env: "dev", team: "core" } }))).toBe(false);
  });

  it("requires every field to match at once", () => {
    const match: EventMatch = {
      sources: ["gatus"],
      types: ["http.*"],
      minSeverity: "warning",
      labels: { env: "prod" },
    };
    const event = makeEvent({ labels: { env: "prod" } });
    expect(matchesEvent(match, event)).toBe(true);
    expect(matchesEvent(match, { ...event, source: "grafana" })).toBe(false);
    expect(matchesEvent(match, { ...event, type: "tcp.down" })).toBe(false);
    expect(matchesEvent(match, { ...event, severity: "info" })).toBe(false);
    expect(matchesEvent(match, { ...event, labels: { env: "dev" } })).toBe(false);
  });
});

describe("group key templates", () => {
  describe("validateEventGroupKeyTemplate", () => {
    it("accepts the default template and every documented placeholder", () => {
      expect(validateEventGroupKeyTemplate(DEFAULT_EVENT_GROUP_KEY_TEMPLATE)).toBeNull();
      expect(
        validateEventGroupKeyTemplate("{{source}}/{{type}}/{{severity}}/{{dedupeKey}}/{{labels.env}}/{{labels.a_1}}"),
      ).toBeNull();
      expect(validateEventGroupKeyTemplate("{{ source }}")).toBeNull();
      expect(validateEventGroupKeyTemplate("static-key")).toBeNull();
    });

    it("rejects an empty template", () => {
      expect(validateEventGroupKeyTemplate("")).toBe("groupKey must not be empty");
    });

    it("enforces the maximum length", () => {
      expect(validateEventGroupKeyTemplate("a".repeat(EVENT_GROUP_KEY_TEMPLATE_MAX_LENGTH))).toBeNull();
      expect(validateEventGroupKeyTemplate("a".repeat(EVENT_GROUP_KEY_TEMPLATE_MAX_LENGTH + 1))).toContain(
        `at most ${EVENT_GROUP_KEY_TEMPLATE_MAX_LENGTH}`,
      );
    });

    it.each(["{{foo}}", "{{title}}", "{{labels.}}", "{{labels.Bad-Key}}", "{{labels.a.b}}", "{{}}", "{{ Source }}"])(
      "rejects unknown placeholder %s",
      (template) => {
        expect(validateEventGroupKeyTemplate(template)).toContain("Unknown groupKey placeholder");
      },
    );

    it("names the offending placeholder in the error", () => {
      expect(validateEventGroupKeyTemplate("{{source}}:{{nope}}")).toContain("{{nope}}");
    });

    it.each(["{{source", "source}}", "{{source}", "{{ {{source}} }}"])(
      "rejects malformed placeholder %j",
      (template) => {
        expect(validateEventGroupKeyTemplate(template)).not.toBeNull();
      },
    );

    it("trims whitespace around a placeholder name, including tabs and newlines", () => {
      expect(validateEventGroupKeyTemplate("{{\t source \n}}")).toBeNull();
      expect(validateEventGroupKeyTemplate("{{ labels.env }}")).toBeNull();
    });

    it.each([
      ["an unclosed opener followed by whitespace", `{{${"\t".repeat(EVENT_GROUP_KEY_TEMPLATE_MAX_LENGTH - 2)}`],
      ["repeated openers", "{{".repeat(EVENT_GROUP_KEY_TEMPLATE_MAX_LENGTH / 2)],
      ["openers separated by whitespace", "{{ ".repeat(EVENT_GROUP_KEY_TEMPLATE_MAX_LENGTH / 3)],
    ])("validates %s in linear time", (_label, template) => {
      const started = performance.now();
      expect(validateEventGroupKeyTemplate(template)).not.toBeNull();
      expect(performance.now() - started).toBeLessThan(200);
    });
  });

  describe("eventGroupKeyTemplateSchema", () => {
    it("surfaces the validation message as a zod issue", () => {
      const result = eventGroupKeyTemplateSchema.safeParse("{{nope}}");
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.message).toContain("Unknown groupKey placeholder");
      expect(eventGroupKeyTemplateSchema.safeParse("{{source}}").success).toBe(true);
    });
  });

  describe("renderEventGroupKey", () => {
    it("renders the default template as source:dedupeKey", () => {
      const event = makeEvent({ source: "monitor", dedupeKey: "host-1:/var" });
      expect(renderEventGroupKey(DEFAULT_EVENT_GROUP_KEY_TEMPLATE, event)).toBe("monitor:host-1:/var");
    });

    it("renders each event field placeholder", () => {
      const event = makeEvent({ source: "gatus", type: "http.down", severity: "warning", dedupeKey: "k1" });
      expect(renderEventGroupKey("{{source}}|{{type}}|{{severity}}|{{dedupeKey}}", event)).toBe(
        "gatus|http.down|warning|k1",
      );
    });

    it("tolerates whitespace inside the braces", () => {
      expect(renderEventGroupKey("{{ source }}-{{  type  }}", makeEvent())).toBe("gatus-http.down");
    });

    it("renders label placeholders from the event labels", () => {
      const event = makeEvent({ labels: { env: "prod", service_name: "api" } });
      expect(renderEventGroupKey("{{labels.env}}/{{labels.service_name}}", event)).toBe("prod/api");
    });

    it("renders a missing label as a visible placeholder instead of merging groups", () => {
      const event = makeEvent({ labels: { env: "prod" } });
      expect(renderEventGroupKey("{{labels.env}}/{{labels.team}}", event)).toBe("prod/labels.team=∅");
      expect(renderEventGroupKey("{{labels.team}}", makeEvent({ labels: {} }))).not.toBe(
        renderEventGroupKey("{{labels.team}}", makeEvent({ labels: { team: "" } })),
      );
    });

    it("renders an empty label value as empty", () => {
      expect(renderEventGroupKey("[{{labels.env}}]", makeEvent({ labels: { env: "" } }))).toBe("[]");
    });

    it("leaves text outside placeholders untouched and does not re-expand rendered values", () => {
      const event = makeEvent({ dedupeKey: "{{source}}" });
      expect(renderEventGroupKey("pre-{{dedupeKey}}-post", event)).toBe("pre-{{source}}-post");
    });

    it("treats a single stray brace next to a placeholder as literal text", () => {
      expect(validateEventGroupKeyTemplate("{{{source}}")).toBeNull();
      expect(renderEventGroupKey("{{{source}}", makeEvent())).toBe("{gatus");
    });

    it("renders repeated placeholders each time", () => {
      expect(renderEventGroupKey("{{source}}{{source}}", makeEvent())).toBe("gatusgatus");
    });

    it("renders different events to different keys when the template distinguishes them", () => {
      const template = "{{source}}:{{labels.env}}";
      expect(renderEventGroupKey(template, makeEvent({ labels: { env: "prod" } }))).not.toBe(
        renderEventGroupKey(template, makeEvent({ labels: { env: "dev" } })),
      );
    });
  });
});

describe("eventGroupingSchema", () => {
  it("fills every default from an empty object", () => {
    expect(eventGroupingSchema.parse({})).toEqual({
      groupKey: DEFAULT_EVENT_GROUP_KEY_TEMPLATE,
      repeatCommentCooldownSec: 900,
      rewakeOnSeverityIncrease: true,
      onRecovery: "comment_and_wake",
      issueMode: "group",
    });
    expect(DEFAULT_EVENT_GROUPING).toEqual(eventGroupingSchema.parse({}));
  });

  it("keeps explicit values", () => {
    const parsed = eventGroupingSchema.parse({
      groupKey: "{{labels.env}}",
      repeatCommentCooldownSec: 0,
      rewakeOnSeverityIncrease: false,
      onRecovery: "ignore",
      issueMode: { appendToIssueId: GUID },
    });
    expect(parsed).toEqual({
      groupKey: "{{labels.env}}",
      repeatCommentCooldownSec: 0,
      rewakeOnSeverityIncrease: false,
      onRecovery: "ignore",
      issueMode: { appendToIssueId: GUID },
    });
  });

  it("rejects unknown keys, bad group keys and bad recovery modes", () => {
    expect(eventGroupingSchema.safeParse({ extra: true }).success).toBe(false);
    expect(eventGroupingSchema.safeParse({ groupKey: "{{nope}}" }).success).toBe(false);
    expect(eventGroupingSchema.safeParse({ groupKey: "" }).success).toBe(false);
    expect(eventGroupingSchema.safeParse({ onRecovery: "close" }).success).toBe(false);
  });

  it("bounds the cooldown to an integer between 0 and a day", () => {
    expect(eventGroupingSchema.safeParse({ repeatCommentCooldownSec: 86_400 }).success).toBe(true);
    expect(eventGroupingSchema.safeParse({ repeatCommentCooldownSec: 86_401 }).success).toBe(false);
    expect(eventGroupingSchema.safeParse({ repeatCommentCooldownSec: -1 }).success).toBe(false);
    expect(eventGroupingSchema.safeParse({ repeatCommentCooldownSec: 1.5 }).success).toBe(false);
  });

  it("validates issueMode", () => {
    expect(eventGroupingSchema.safeParse({ issueMode: "group" }).success).toBe(true);
    expect(eventGroupingSchema.safeParse({ issueMode: "append" }).success).toBe(false);
    expect(eventGroupingSchema.safeParse({ issueMode: { appendToIssueId: "not-a-guid" } }).success).toBe(false);
    expect(eventGroupingSchema.safeParse({ issueMode: { appendToIssueId: GUID, extra: 1 } }).success).toBe(false);
  });
});

describe("genericV1EventSchema", () => {
  it("accepts the minimal valid event", () => {
    const result = genericV1EventSchema.safeParse(validGenericBody());
    expect(result.success).toBe(true);
  });

  it("accepts a fully populated event", () => {
    const body = validGenericBody({
      eventId: "evt-0001",
      summary: "line one\nline two",
      labels: { env: "prod", host: "web-1" },
      occurredAt: "2026-01-02T03:04:05+02:00",
      url: "https://status.example.com/incidents/1",
    });
    const result = genericV1EventSchema.parse(body);
    expect(result.eventId).toBe("evt-0001");
    expect(result.labels).toEqual({ env: "prod", host: "web-1" });
    expect(result.url).toBe("https://status.example.com/incidents/1");
  });

  it.each(["schema", "source", "type", "severity", "state", "dedupeKey", "title"])(
    "requires %s",
    (field) => {
      const body: Record<string, unknown> = validGenericBody();
      delete body[field];
      expect(genericV1EventSchema.safeParse(body).success).toBe(false);
    },
  );

  it("requires the exact schema id", () => {
    expect(genericV1EventSchema.safeParse(validGenericBody({ schema: "paperclip.event.v2" })).success).toBe(false);
    expect(genericV1EventSchema.safeParse(validGenericBody({ schema: undefined })).success).toBe(false);
  });

  it.each(["", "Upper", "has space", "a/b", "x".repeat(65)])("rejects source %j", (source) => {
    expect(genericV1EventSchema.safeParse(validGenericBody({ source })).success).toBe(false);
  });

  it("accepts the edges of the source and type patterns", () => {
    expect(genericV1EventSchema.safeParse(validGenericBody({ source: "a.b_c-1" })).success).toBe(true);
    expect(genericV1EventSchema.safeParse(validGenericBody({ source: "x".repeat(64) })).success).toBe(true);
    expect(genericV1EventSchema.safeParse(validGenericBody({ type: "t".repeat(128) })).success).toBe(true);
    expect(genericV1EventSchema.safeParse(validGenericBody({ type: "t".repeat(129) })).success).toBe(false);
    expect(genericV1EventSchema.safeParse(validGenericBody({ type: "Bad Type" })).success).toBe(false);
  });

  it("restricts severity and state to the known values", () => {
    expect(genericV1EventSchema.safeParse(validGenericBody({ severity: "fatal" })).success).toBe(false);
    expect(genericV1EventSchema.safeParse(validGenericBody({ severity: "CRITICAL" })).success).toBe(false);
    expect(genericV1EventSchema.safeParse(validGenericBody({ state: "resolved" })).success).toBe(false);
    for (const state of ["problem", "recovery", "info"]) {
      expect(genericV1EventSchema.safeParse(validGenericBody({ state })).success).toBe(true);
    }
  });

  describe("dedupeKey and eventId", () => {
    it("accepts printable ASCII including spaces", () => {
      expect(genericV1EventSchema.safeParse(validGenericBody({ dedupeKey: "a b~!" })).success).toBe(true);
    });

    it.each(["", "café", "line\nbreak", "tab\there", "emoji \u{1F600}", "nul\u0000"])(
      "rejects dedupeKey %j",
      (dedupeKey) => {
        expect(genericV1EventSchema.safeParse(validGenericBody({ dedupeKey })).success).toBe(false);
      },
    );

    it("bounds dedupeKey to 256 characters", () => {
      expect(genericV1EventSchema.safeParse(validGenericBody({ dedupeKey: "k".repeat(256) })).success).toBe(true);
      expect(genericV1EventSchema.safeParse(validGenericBody({ dedupeKey: "k".repeat(257) })).success).toBe(false);
    });

    it("applies the same rules to eventId", () => {
      expect(genericV1EventSchema.safeParse(validGenericBody({ eventId: "e".repeat(256) })).success).toBe(true);
      expect(genericV1EventSchema.safeParse(validGenericBody({ eventId: "e".repeat(257) })).success).toBe(false);
      expect(genericV1EventSchema.safeParse(validGenericBody({ eventId: "café" })).success).toBe(false);
      expect(genericV1EventSchema.safeParse(validGenericBody({ eventId: "" })).success).toBe(false);
    });
  });

  describe("title and summary", () => {
    it("sanitizes the title to a single line", () => {
      const parsed = genericV1EventSchema.parse(validGenericBody({ title: "  Disk\n\n# heading\tfull\u2028now  " }));
      expect(parsed.title).toBe("Disk # heading full now");
    });

    it("rejects a title that is empty once sanitized", () => {
      expect(genericV1EventSchema.safeParse(validGenericBody({ title: "" })).success).toBe(false);
      expect(genericV1EventSchema.safeParse(validGenericBody({ title: " \n\t " })).success).toBe(false);
    });

    it("bounds the raw title to 200 characters", () => {
      expect(genericV1EventSchema.safeParse(validGenericBody({ title: "t".repeat(200) })).success).toBe(true);
      expect(genericV1EventSchema.safeParse(validGenericBody({ title: "t".repeat(201) })).success).toBe(false);
    });

    it("keeps summary line breaks and tabs but strips NUL", () => {
      const parsed = genericV1EventSchema.parse(validGenericBody({ summary: "a\nb\tc\u0000d" }));
      expect(parsed.summary).toBe("a\nb\tcd");
    });

    it("bounds summary to 4000 characters", () => {
      expect(genericV1EventSchema.safeParse(validGenericBody({ summary: "s".repeat(4000) })).success).toBe(true);
      expect(genericV1EventSchema.safeParse(validGenericBody({ summary: "s".repeat(4001) })).success).toBe(false);
    });
  });

  describe("labels", () => {
    it("accepts label keys made of lowercase letters, digits and underscores", () => {
      expect(genericV1EventSchema.safeParse(validGenericBody({ labels: { a_1: "x" } })).success).toBe(true);
    });

    it.each(["Env", "has-dash", "has space", "", "k".repeat(65)])("rejects label key %j", (key) => {
      expect(genericV1EventSchema.safeParse(validGenericBody({ labels: { [key]: "x" } })).success).toBe(false);
    });

    it("sanitizes label values to a single line and bounds them to 256", () => {
      const parsed = genericV1EventSchema.parse(validGenericBody({ labels: { env: "pro\nd\u0000" } }));
      expect(parsed.labels).toEqual({ env: "pro d" });
      expect(genericV1EventSchema.safeParse(validGenericBody({ labels: { env: "v".repeat(256) } })).success).toBe(true);
      expect(genericV1EventSchema.safeParse(validGenericBody({ labels: { env: "v".repeat(257) } })).success).toBe(false);
    });

    it("rejects non-string label values", () => {
      expect(genericV1EventSchema.safeParse(validGenericBody({ labels: { env: 1 } })).success).toBe(false);
    });

    it("allows at most 32 labels", () => {
      const labels = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, "v"]));
      expect(genericV1EventSchema.safeParse(validGenericBody({ labels: labels(EVENT_MAX_LABELS) })).success).toBe(true);
      expect(genericV1EventSchema.safeParse(validGenericBody({ labels: labels(EVENT_MAX_LABELS + 1) })).success).toBe(false);
    });
  });

  describe("occurredAt", () => {
    it.each(["2026-01-01T00:00:00Z", "2026-01-01T00:00:00.123Z", "2026-01-01T00:00:00+05:30"])(
      "accepts %s",
      (occurredAt) => {
        expect(genericV1EventSchema.safeParse(validGenericBody({ occurredAt })).success).toBe(true);
      },
    );

    it.each(["yesterday", "2026-01-01", "2026-01-01T00:00:00", "1767225600"])("rejects %s", (occurredAt) => {
      expect(genericV1EventSchema.safeParse(validGenericBody({ occurredAt })).success).toBe(false);
    });
  });

  describe("url", () => {
    it("accepts http and https URLs and trims whitespace", () => {
      expect(genericV1EventSchema.parse(validGenericBody({ url: "  https://example.com/x  " })).url).toBe(
        "https://example.com/x",
      );
      expect(genericV1EventSchema.safeParse(validGenericBody({ url: "http://example.com" })).success).toBe(true);
    });

    it.each([
      ["userinfo", "https://user:s3cret@example.com/health", "https://example.com/health"],
      ["a username only", "https://token@example.com/health", "https://example.com/health"],
      ["a query token", "https://example.com/health?token=abc123&env=prod", "https://example.com/health"],
      ["a fragment", "https://example.com/health#access_token=abc", "https://example.com/health"],
      ["all of them", "http://u:p@example.com:8080/a/b?x=1#y", "http://example.com:8080/a/b"],
    ])("removes credentials before the url is stored: %s", (_label, url, expected) => {
      expect(genericV1EventSchema.parse(validGenericBody({ url })).url).toBe(expected);
    });

    it.each(["ftp://example.com", "javascript:alert(1)", "not a url", "example.com/path", ""])(
      "rejects %j",
      (url) => {
        expect(genericV1EventSchema.safeParse(validGenericBody({ url })).success).toBe(false);
      },
    );

    it("bounds the URL to 2048 characters", () => {
      const base = "https://example.com/";
      expect(genericV1EventSchema.safeParse(validGenericBody({ url: base + "a".repeat(2048 - base.length) })).success).toBe(true);
      expect(genericV1EventSchema.safeParse(validGenericBody({ url: base + "a".repeat(2049 - base.length) })).success).toBe(false);
    });
  });
});

describe("gatusNormalizerConfigSchema and validateEventSourceNormalizerConfig", () => {
  it("defaults endpointMap to an empty object", () => {
    expect(gatusNormalizerConfigSchema.parse({})).toEqual({ endpointMap: {} });
  });

  it("accepts a mapped endpoint with type, labels and severity", () => {
    const config = {
      endpointMap: { "core/api": { type: "http.down", labels: { env: "prod" }, severity: "warning" } },
    };
    expect(gatusNormalizerConfigSchema.parse(config)).toEqual(config);
  });

  it("accepts an ungrouped endpoint key and rejects unknown keys", () => {
    expect(gatusNormalizerConfigSchema.safeParse({ endpointMap: { "/standalone": { type: "http.down" } } }).success).toBe(true);
    expect(gatusNormalizerConfigSchema.safeParse({ endpointMap: {}, other: 1 }).success).toBe(false);
    expect(gatusNormalizerConfigSchema.safeParse({ endpointMap: { "core/api": { type: "x", extra: 1 } } }).success).toBe(false);
  });

  it("caps the endpoint map at 500 entries", () => {
    const map = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`g/e${i}`, { type: "http.down" }]));
    expect(gatusNormalizerConfigSchema.safeParse({ endpointMap: map(500) }).success).toBe(true);
    expect(gatusNormalizerConfigSchema.safeParse({ endpointMap: map(501) }).success).toBe(false);
  });

  it("validates gatus config and treats missing config as valid", () => {
    expect(validateEventSourceNormalizerConfig("gatus", null)).toBeNull();
    expect(validateEventSourceNormalizerConfig("gatus", undefined)).toBeNull();
    expect(validateEventSourceNormalizerConfig("gatus", {})).toBeNull();
    expect(validateEventSourceNormalizerConfig("gatus", { endpointMap: { "core/api": { type: "http.down" } } })).toBeNull();
  });

  it("reports the path of an invalid gatus endpointMap entry", () => {
    const error = validateEventSourceNormalizerConfig("gatus", {
      endpointMap: { "core/api": { type: "Not A Type" } },
    });
    expect(error).toContain("endpointMap.core/api.type");
  });

  it("rejects unknown gatus config keys", () => {
    expect(validateEventSourceNormalizerConfig("gatus", { nope: true })).not.toBeNull();
  });

  it("rejects any non-empty config for generic_v1 and accepts none or an empty one", () => {
    expect(validateEventSourceNormalizerConfig("generic_v1", null)).toBeNull();
    expect(validateEventSourceNormalizerConfig("generic_v1", undefined)).toBeNull();
    expect(validateEventSourceNormalizerConfig("generic_v1", {})).toBeNull();
    expect(validateEventSourceNormalizerConfig("generic_v1", { endpointMap: {} })).toBe(
      "normalizerConfig is only used by the gatus normalizer",
    );
  });
});

describe("createEventSourceSchema", () => {
  it("accepts a name alone", () => {
    const parsed = createEventSourceSchema.parse({ name: "  Gatus prod  " });
    expect(parsed.name).toBe("Gatus prod");
  });

  it("accepts every optional field", () => {
    const result = createEventSourceSchema.safeParse({
      name: "Gatus",
      enabled: true,
      signingMode: "hmac_sha256",
      replayWindowSec: 300,
      normalizer: "gatus",
      normalizerConfig: { endpointMap: { "core/api": { type: "http.down" } } },
      pinnedLabels: { env: "prod" },
      rateLimitPerMinute: 600,
      maxNewIssuesPerHour: 20,
      retentionDays: 30,
    });
    expect(result.success).toBe(true);
  });

  it("requires a non-blank name of at most 120 characters", () => {
    expect(createEventSourceSchema.safeParse({}).success).toBe(false);
    expect(createEventSourceSchema.safeParse({ name: "" }).success).toBe(false);
    expect(createEventSourceSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(createEventSourceSchema.safeParse({ name: "n".repeat(120) }).success).toBe(true);
    expect(createEventSourceSchema.safeParse({ name: "n".repeat(121) }).success).toBe(false);
  });

  it("restricts signing mode and normalizer to the known values", () => {
    expect(createEventSourceSchema.safeParse({ name: "x", signingMode: "bearer" }).success).toBe(true);
    expect(createEventSourceSchema.safeParse({ name: "x", signingMode: "none" }).success).toBe(false);
    expect(createEventSourceSchema.safeParse({ name: "x", normalizer: "datadog" }).success).toBe(false);
  });

  it.each([
    ["replayWindowSec", 30, 86_400],
    ["rateLimitPerMinute", 1, 100_000],
    ["maxNewIssuesPerHour", 1, 10_000],
    ["retentionDays", 1, 365],
  ])("bounds %s to [%i, %i] as an integer", (field, min, max) => {
    expect(createEventSourceSchema.safeParse({ name: "x", [field]: min }).success).toBe(true);
    expect(createEventSourceSchema.safeParse({ name: "x", [field]: max }).success).toBe(true);
    expect(createEventSourceSchema.safeParse({ name: "x", [field]: min - 1 }).success).toBe(false);
    expect(createEventSourceSchema.safeParse({ name: "x", [field]: max + 1 }).success).toBe(false);
    expect(createEventSourceSchema.safeParse({ name: "x", [field]: min + 0.5 }).success).toBe(false);
  });

  it("validates pinned labels (key pattern, non-empty values, at most 32)", () => {
    expect(createEventSourceSchema.safeParse({ name: "x", pinnedLabels: { Env: "prod" } }).success).toBe(false);
    expect(createEventSourceSchema.safeParse({ name: "x", pinnedLabels: { env: "" } }).success).toBe(false);
    expect(createEventSourceSchema.safeParse({ name: "x", pinnedLabels: { env: "v".repeat(257) } }).success).toBe(false);
    const labels = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, "v"]));
    expect(createEventSourceSchema.safeParse({ name: "x", pinnedLabels: labels(32) }).success).toBe(true);
    expect(createEventSourceSchema.safeParse({ name: "x", pinnedLabels: labels(33) }).success).toBe(false);
  });

  it("rejects normalizerConfig on the default (generic_v1) normalizer", () => {
    const result = createEventSourceSchema.safeParse({ name: "x", normalizerConfig: { endpointMap: {} } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["normalizerConfig"]);
      expect(result.error.issues[0]?.message).toBe("normalizerConfig is only used by the gatus normalizer");
    }
    expect(
      createEventSourceSchema.safeParse({ name: "x", normalizer: "generic_v1", normalizerConfig: { a: 1 } }).success,
    ).toBe(false);
  });

  it("accepts empty or null normalizerConfig for generic_v1", () => {
    expect(createEventSourceSchema.safeParse({ name: "x", normalizerConfig: null }).success).toBe(true);
    expect(createEventSourceSchema.safeParse({ name: "x", normalizerConfig: {} }).success).toBe(true);
  });

  it("validates normalizerConfig against the gatus endpointMap shape", () => {
    expect(
      createEventSourceSchema.safeParse({
        name: "x",
        normalizer: "gatus",
        normalizerConfig: { endpointMap: { "core/api": { type: "http.down", severity: "warning" } } },
      }).success,
    ).toBe(true);
    const invalid = createEventSourceSchema.safeParse({
      name: "x",
      normalizer: "gatus",
      normalizerConfig: { endpointMap: { "core/api": { type: "http.down", severity: "fatal" } } },
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(invalid.error.issues[0]?.path).toEqual(["normalizerConfig"]);
  });
});

describe("updateEventSourceSchema", () => {
  it("accepts an empty patch and any single field", () => {
    expect(updateEventSourceSchema.safeParse({}).success).toBe(true);
    expect(updateEventSourceSchema.safeParse({ name: "Renamed" }).success).toBe(true);
    expect(updateEventSourceSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(updateEventSourceSchema.safeParse({ archived: true }).success).toBe(true);
    expect(updateEventSourceSchema.safeParse({ normalizerConfig: null }).success).toBe(true);
  });

  it("still validates the fields it is given", () => {
    expect(updateEventSourceSchema.safeParse({ name: "" }).success).toBe(false);
    expect(updateEventSourceSchema.safeParse({ replayWindowSec: 10 }).success).toBe(false);
    expect(updateEventSourceSchema.safeParse({ rateLimitPerMinute: 0 }).success).toBe(false);
    expect(updateEventSourceSchema.safeParse({ archived: "yes" }).success).toBe(false);
    expect(updateEventSourceSchema.safeParse({ pinnedLabels: { Bad: "x" } }).success).toBe(false);
  });

  it("leaves cross-field normalizer/config validation to the service", () => {
    expect(updateEventSourceSchema.safeParse({ normalizerConfig: { endpointMap: {} } }).success).toBe(true);
  });
});

describe("listEventDeliveriesQuerySchema", () => {
  it("defaults limit to 50", () => {
    expect(listEventDeliveriesQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it("coerces a string limit from the query string", () => {
    expect(listEventDeliveriesQuerySchema.parse({ limit: "25" }).limit).toBe(25);
  });

  it("bounds limit to [1, 200]", () => {
    expect(listEventDeliveriesQuerySchema.safeParse({ limit: "1" }).success).toBe(true);
    expect(listEventDeliveriesQuerySchema.safeParse({ limit: "200" }).success).toBe(true);
    expect(listEventDeliveriesQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listEventDeliveriesQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(listEventDeliveriesQuerySchema.safeParse({ limit: "abc" }).success).toBe(false);
    expect(listEventDeliveriesQuerySchema.safeParse({ limit: "1.5" }).success).toBe(false);
  });

  it("accepts every delivery status and rejects unknown ones", () => {
    for (const status of ["processing", "dispatched", "grouped_silent", "invalid", "unrouted", "storm_folded", "recovery_without_issue", "failed", "rejected_aggregate"]) {
      expect(listEventDeliveriesQuerySchema.safeParse({ status }).success).toBe(true);
    }
    expect(listEventDeliveriesQuerySchema.safeParse({ status: "pending" }).success).toBe(false);
  });

  it("bounds the cursor length", () => {
    expect(listEventDeliveriesQuerySchema.safeParse({ cursor: "c".repeat(256) }).success).toBe(true);
    expect(listEventDeliveriesQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
    expect(listEventDeliveriesQuerySchema.safeParse({ cursor: "c".repeat(257) }).success).toBe(false);
  });
});

describe("event routine triggers", () => {
  describe("createRoutineTriggerSchema", () => {
    it("accepts a minimal event trigger and fills defaults", () => {
      const parsed = createRoutineTriggerSchema.parse({ kind: "event", eventSourceId: GUID });
      expect(parsed).toEqual({ kind: "event", eventSourceId: GUID, enabled: true, fallback: false });
    });

    it("accepts match, grouping, fallback and label together", () => {
      const parsed = createRoutineTriggerSchema.parse({
        kind: "event",
        label: "  prod alerts  ",
        enabled: false,
        eventSourceId: GUID,
        eventMatch: { types: ["http.*"], minSeverity: "warning", labels: { env: ["prod"] } },
        eventGrouping: { groupKey: "{{labels.env}}", onRecovery: "comment_only" },
        fallback: true,
      });
      expect(parsed.kind).toBe("event");
      if (parsed.kind !== "event") throw new Error("expected an event trigger");
      expect(parsed.label).toBe("prod alerts");
      expect(parsed.enabled).toBe(false);
      expect(parsed.fallback).toBe(true);
      expect(parsed.eventMatch).toEqual({ types: ["http.*"], minSeverity: "warning", labels: { env: ["prod"] } });
      expect(parsed.eventGrouping).toEqual({
        groupKey: "{{labels.env}}",
        repeatCommentCooldownSec: 900,
        rewakeOnSeverityIncrease: true,
        onRecovery: "comment_only",
        issueMode: "group",
      });
    });

    it("accepts a null eventMatch", () => {
      const parsed = createRoutineTriggerSchema.parse({ kind: "event", eventSourceId: GUID, eventMatch: null });
      expect(parsed.kind === "event" && parsed.eventMatch).toBeNull();
    });

    it("rejects an event trigger without eventSourceId", () => {
      expect(createRoutineTriggerSchema.safeParse({ kind: "event" }).success).toBe(false);
      expect(createRoutineTriggerSchema.safeParse({ kind: "event", fallback: true }).success).toBe(false);
    });

    it("rejects a non-guid eventSourceId", () => {
      expect(createRoutineTriggerSchema.safeParse({ kind: "event", eventSourceId: "abc" }).success).toBe(false);
      expect(createRoutineTriggerSchema.safeParse({ kind: "event", eventSourceId: null }).success).toBe(false);
      expect(createRoutineTriggerSchema.safeParse({ kind: "event", eventSourceId: "" }).success).toBe(false);
    });

    it("rejects an invalid eventMatch or eventGrouping", () => {
      expect(
        createRoutineTriggerSchema.safeParse({ kind: "event", eventSourceId: GUID, eventMatch: { bogus: 1 } }).success,
      ).toBe(false);
      expect(
        createRoutineTriggerSchema.safeParse({ kind: "event", eventSourceId: GUID, eventMatch: { minSeverity: "nope" } }).success,
      ).toBe(false);
      expect(
        createRoutineTriggerSchema.safeParse({ kind: "event", eventSourceId: GUID, eventGrouping: { groupKey: "{{x}}" } }).success,
      ).toBe(false);
      expect(
        createRoutineTriggerSchema.safeParse({ kind: "event", eventSourceId: GUID, eventGrouping: null }).success,
      ).toBe(false);
    });

    it("rejects a non-boolean fallback", () => {
      expect(createRoutineTriggerSchema.safeParse({ kind: "event", eventSourceId: GUID, fallback: "yes" }).success).toBe(false);
    });

    it("rejects an unknown kind", () => {
      expect(createRoutineTriggerSchema.safeParse({ kind: "events", eventSourceId: GUID }).success).toBe(false);
    });

    it.each([
      ["schedule", { cronExpression: "0 * * * *" }],
      ["webhook", {}],
      ["api", {}],
    ])("does not carry event fields onto a %s trigger", (kind, extra) => {
      const parsed = createRoutineTriggerSchema.parse({
        kind,
        ...extra,
        eventSourceId: GUID,
        eventMatch: { types: ["*"] },
        eventGrouping: { groupKey: "{{source}}" },
        fallback: true,
      });
      expect(parsed.kind).toBe(kind);
      expect(parsed).not.toHaveProperty("eventSourceId");
      expect(parsed).not.toHaveProperty("eventMatch");
      expect(parsed).not.toHaveProperty("eventGrouping");
      expect(parsed).not.toHaveProperty("fallback");
    });

    it("does not let an event trigger inherit schedule or webhook fields", () => {
      const parsed = createRoutineTriggerSchema.parse({
        kind: "event",
        eventSourceId: GUID,
        cronExpression: "0 * * * *",
        signingMode: "bearer",
        replayWindowSec: 300,
      });
      expect(parsed).not.toHaveProperty("cronExpression");
      expect(parsed).not.toHaveProperty("signingMode");
      expect(parsed).not.toHaveProperty("replayWindowSec");
    });

    it("still requires the schedule fields on schedule triggers", () => {
      expect(createRoutineTriggerSchema.safeParse({ kind: "schedule", eventSourceId: GUID }).success).toBe(false);
    });
  });

  describe("updateRoutineTriggerSchema", () => {
    it("accepts event fields on a patch", () => {
      const parsed = updateRoutineTriggerSchema.parse({
        eventSourceId: GUID,
        eventMatch: { sources: ["gatus"] },
        eventGrouping: { repeatCommentCooldownSec: 60 },
        fallback: true,
      });
      expect(parsed.eventSourceId).toBe(GUID);
      expect(parsed.eventMatch).toEqual({ sources: ["gatus"] });
      expect(parsed.eventGrouping?.repeatCommentCooldownSec).toBe(60);
      expect(parsed.eventGrouping?.groupKey).toBe(DEFAULT_EVENT_GROUP_KEY_TEMPLATE);
      expect(parsed.fallback).toBe(true);
    });

    it("accepts an empty patch and a null eventMatch (clearing the filter)", () => {
      expect(updateRoutineTriggerSchema.parse({})).toEqual({});
      expect(updateRoutineTriggerSchema.parse({ eventMatch: null }).eventMatch).toBeNull();
    });

    it("rejects invalid event fields", () => {
      expect(updateRoutineTriggerSchema.safeParse({ eventSourceId: "nope" }).success).toBe(false);
      expect(updateRoutineTriggerSchema.safeParse({ eventSourceId: null }).success).toBe(false);
      expect(updateRoutineTriggerSchema.safeParse({ eventMatch: { bogus: 1 } }).success).toBe(false);
      expect(updateRoutineTriggerSchema.safeParse({ eventGrouping: { groupKey: "{{x}}" } }).success).toBe(false);
      expect(updateRoutineTriggerSchema.safeParse({ fallback: "no" }).success).toBe(false);
    });
  });

  describe("routineRevisionSnapshotTriggerV1Schema", () => {
    const baseSnapshot = {
      id: GUID,
      kind: "event",
      label: null,
      enabled: true,
      cronExpression: null,
      timezone: null,
      publicId: null,
      signingMode: null,
      replayWindowSec: null,
    };

    it("accepts a snapshot without event fields (non-event triggers keep their stored shape)", () => {
      expect(routineRevisionSnapshotTriggerV1Schema.safeParse({ ...baseSnapshot, kind: "schedule" }).success).toBe(true);
    });

    it("accepts event fields on a snapshot", () => {
      const parsed = routineRevisionSnapshotTriggerV1Schema.parse({
        ...baseSnapshot,
        eventSourceId: GUID,
        eventMatch: null,
        eventGrouping: eventGroupingSchema.parse({}),
        fallback: false,
      });
      expect(parsed.eventSourceId).toBe(GUID);
      expect(parsed.fallback).toBe(false);
    });

    it("stays strict about unknown snapshot keys", () => {
      expect(routineRevisionSnapshotTriggerV1Schema.safeParse({ ...baseSnapshot, bogus: 1 }).success).toBe(false);
    });
  });
});
