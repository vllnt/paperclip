import { describe, expect, it } from "vitest";
import { EVENT_WIRE_SCHEMA_ID, type NormalizedEvent } from "@paperclipai/shared";
import {
  normalizeEvent,
  type EventNormalizerSource,
  type NormalizeEventResult,
} from "../services/event-sources/normalizers.js";

const NOW = new Date("2026-03-04T05:06:07.000Z");

function genericSource(overrides: Partial<EventNormalizerSource> = {}): EventNormalizerSource {
  return { normalizer: "generic_v1", normalizerConfig: null, pinnedLabels: {}, ...overrides };
}

function gatusSource(overrides: Partial<EventNormalizerSource> = {}): EventNormalizerSource {
  return { normalizer: "gatus", normalizerConfig: null, pinnedLabels: {}, ...overrides };
}

function genericBody(overrides: Record<string, unknown> = {}) {
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

function gatusBody(overrides: Record<string, unknown> = {}) {
  return {
    status: "TRIGGERED",
    group: "core",
    name: "api",
    description: "HTTP 500",
    url: "https://api.example.com/health",
    ...overrides,
  };
}

function expectOk(result: NormalizeEventResult): NormalizedEvent {
  if (!result.ok) throw new Error(`expected a normalized event, got errors: ${result.errors.join("; ")}`);
  return result.event;
}

function expectErrors(result: NormalizeEventResult): string[] {
  if (result.ok) throw new Error("expected normalization to fail");
  return result.errors;
}

describe("normalizeEvent: shared body checks", () => {
  it.each([
    ["null", null],
    ["a string", "alert"],
    ["a number", 7],
    ["an array", [genericBody()]],
    ["undefined", undefined],
  ])("rejects %s for every normalizer", (_label, body) => {
    expect(expectErrors(normalizeEvent(genericSource(), body, NOW))).toEqual(["body must be a JSON object"]);
    expect(expectErrors(normalizeEvent(gatusSource(), body, NOW))).toEqual(["body must be a JSON object"]);
  });

  it("rejects an unknown normalizer", () => {
    expect(expectErrors(normalizeEvent(genericSource({ normalizer: "datadog" }), genericBody(), NOW))).toEqual([
      "Unknown normalizer datadog",
    ]);
  });
});

describe("normalizeEvent: generic_v1", () => {
  it("normalizes a minimal event and fills defaults", () => {
    const event = expectOk(normalizeEvent(genericSource(), genericBody(), NOW));
    expect(event).toEqual({
      eventId: null,
      source: "monitor",
      type: "disk.full",
      severity: "warning",
      state: "problem",
      dedupeKey: "host-1:/var",
      title: "Disk almost full",
      summary: "",
      labels: {},
      occurredAt: "2026-03-04T05:06:07.000Z",
      url: null,
    });
  });

  it("normalizes a fully populated event", () => {
    const event = expectOk(
      normalizeEvent(
        genericSource(),
        genericBody({
          eventId: "evt-42",
          summary: "98% used\non /var",
          labels: { env: "prod", host: "web-1" },
          occurredAt: "2026-01-02T03:04:05+02:00",
          url: "https://status.example.com/incidents/42",
        }),
        NOW,
      ),
    );
    expect(event).toEqual({
      eventId: "evt-42",
      source: "monitor",
      type: "disk.full",
      severity: "warning",
      state: "problem",
      dedupeKey: "host-1:/var",
      title: "Disk almost full",
      summary: "98% used\non /var",
      labels: { env: "prod", host: "web-1" },
      occurredAt: "2026-01-02T01:04:05.000Z",
      url: "https://status.example.com/incidents/42",
    });
  });

  it("uses the injected now when occurredAt is absent and ignores the wall clock", () => {
    const a = expectOk(normalizeEvent(genericSource(), genericBody(), new Date("2030-01-01T00:00:00.000Z")));
    const b = expectOk(normalizeEvent(genericSource(), genericBody(), new Date("2031-06-01T12:00:00.000Z")));
    expect(a.occurredAt).toBe("2030-01-01T00:00:00.000Z");
    expect(b.occurredAt).toBe("2031-06-01T12:00:00.000Z");
  });

  it("prefers the sender's occurredAt over now", () => {
    const event = expectOk(normalizeEvent(genericSource(), genericBody({ occurredAt: "2025-12-31T23:59:59Z" }), NOW));
    expect(event.occurredAt).toBe("2025-12-31T23:59:59.000Z");
  });

  it("sanitizes the title and label values", () => {
    const event = expectOk(
      normalizeEvent(genericSource(), genericBody({ title: "Line 1\n# Line 2", labels: { env: "pro\nd" } }), NOW),
    );
    expect(event.title).toBe("Line 1 # Line 2");
    expect(event.labels).toEqual({ env: "pro d" });
  });

  describe("invalid bodies", () => {
    it("reports every missing required field", () => {
      const errors = expectErrors(normalizeEvent(genericSource(), {}, NOW));
      for (const field of ["schema", "source", "type", "severity", "state", "dedupeKey", "title"]) {
        expect(errors.some((error) => error.startsWith(`${field}:`))).toBe(true);
      }
    });

    it("rejects a wrong schema id", () => {
      const errors = expectErrors(normalizeEvent(genericSource(), genericBody({ schema: "paperclip.event.v0" }), NOW));
      expect(errors).toEqual([expect.stringContaining("schema:")]);
    });

    it("rejects an unknown severity and names the field", () => {
      const errors = expectErrors(normalizeEvent(genericSource(), genericBody({ severity: "fatal" }), NOW));
      expect(errors).toEqual([expect.stringContaining("severity:")]);
    });

    it("rejects an unknown state", () => {
      const errors = expectErrors(normalizeEvent(genericSource(), genericBody({ state: "resolved" }), NOW));
      expect(errors).toEqual([expect.stringContaining("state:")]);
    });

    it("rejects a non-ASCII dedupeKey and names the field", () => {
      const errors = expectErrors(normalizeEvent(genericSource(), genericBody({ dedupeKey: "café" }), NOW));
      expect(errors).toEqual([expect.stringContaining("dedupeKey:")]);
    });

    it("rejects a bad label key with its path", () => {
      const errors = expectErrors(normalizeEvent(genericSource(), genericBody({ labels: { Bad: "x" } }), NOW));
      expect(errors.some((error) => error.startsWith("labels.Bad"))).toBe(true);
    });

    it("rejects a non-http url", () => {
      const errors = expectErrors(normalizeEvent(genericSource(), genericBody({ url: "javascript:alert(1)" }), NOW));
      expect(errors).toEqual([expect.stringContaining("url:")]);
    });

    it("rejects a malformed occurredAt", () => {
      const errors = expectErrors(normalizeEvent(genericSource(), genericBody({ occurredAt: "yesterday" }), NOW));
      expect(errors).toEqual([expect.stringContaining("occurredAt:")]);
    });

    it("reports at most ten errors", () => {
      const body = {
        schema: "bad",
        source: "BAD",
        type: "BAD",
        severity: "bad",
        state: "bad",
        dedupeKey: "",
        title: "",
        eventId: "é",
        occurredAt: "x",
        url: "x",
        labels: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`BAD${i}`, "v"])),
      };
      expect(expectErrors(normalizeEvent(genericSource(), body, NOW))).toHaveLength(10);
    });
  });

  describe("pinned labels", () => {
    it("adds pinned labels to the event", () => {
      const event = expectOk(
        normalizeEvent(genericSource({ pinnedLabels: { env: "prod" } }), genericBody({ labels: { host: "web-1" } }), NOW),
      );
      expect(event.labels).toEqual({ host: "web-1", env: "prod" });
    });

    it("forces pinned labels last so the sender cannot override them", () => {
      const event = expectOk(
        normalizeEvent(
          genericSource({ pinnedLabels: { env: "prod", team: "core" } }),
          genericBody({ labels: { env: "dev", team: "other", host: "web-1" } }),
          NOW,
        ),
      );
      expect(event.labels).toEqual({ env: "prod", team: "core", host: "web-1" });
    });

    it("applies pinned labels even when the sender sends no labels", () => {
      const event = expectOk(normalizeEvent(genericSource({ pinnedLabels: { env: "prod" } }), genericBody(), NOW));
      expect(event.labels).toEqual({ env: "prod" });
    });

    it("sanitizes pinned label values to a single line", () => {
      const event = expectOk(normalizeEvent(genericSource({ pinnedLabels: { env: "pro\nd\t" } }), genericBody(), NOW));
      expect(event.labels).toEqual({ env: "pro d" });
    });

    function labels(count: number, prefix = "k") {
      return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, "v"]));
    }

    it("allows exactly 32 labels including pinned ones", () => {
      const event = expectOk(
        normalizeEvent(genericSource({ pinnedLabels: { env: "prod" } }), genericBody({ labels: labels(31) }), NOW),
      );
      expect(Object.keys(event.labels)).toHaveLength(32);
    });

    it("rejects more than 32 labels once pinned labels are added", () => {
      const errors = expectErrors(
        normalizeEvent(genericSource({ pinnedLabels: { env: "prod" } }), genericBody({ labels: labels(32) }), NOW),
      );
      expect(errors).toEqual([expect.stringContaining("at most 32 labels")]);
    });

    it("does not count a pinned label that overwrites a sender label twice", () => {
      const event = expectOk(
        normalizeEvent(genericSource({ pinnedLabels: { k0: "pinned" } }), genericBody({ labels: labels(32) }), NOW),
      );
      expect(Object.keys(event.labels)).toHaveLength(32);
      expect(event.labels.k0).toBe("pinned");
    });
  });
});

describe("normalizeEvent: gatus", () => {
  it("normalizes a triggered alert for an unmapped endpoint", () => {
    const event = expectOk(normalizeEvent(gatusSource(), gatusBody(), NOW));
    expect(event).toEqual({
      eventId: null,
      source: "gatus",
      type: "gatus.endpoint",
      severity: "critical",
      state: "problem",
      dedupeKey: "gatus:core/api",
      title: "Gatus: core/api is failing",
      summary: "HTTP 500",
      labels: { endpoint: "core/api" },
      occurredAt: "2026-03-04T05:06:07.000Z",
      url: "https://api.example.com/health",
    });
  });

  it("maps RESOLVED to a recovery with the same dedupeKey", () => {
    const triggered = expectOk(normalizeEvent(gatusSource(), gatusBody({ status: "TRIGGERED" }), NOW));
    const resolved = expectOk(normalizeEvent(gatusSource(), gatusBody({ status: "RESOLVED" }), NOW));
    expect(triggered.state).toBe("problem");
    expect(resolved.state).toBe("recovery");
    expect(resolved.title).toBe("Gatus: core/api recovered");
    expect(resolved.dedupeKey).toBe(triggered.dedupeKey);
  });

  it("accepts the status in any case with surrounding whitespace", () => {
    expect(expectOk(normalizeEvent(gatusSource(), gatusBody({ status: " resolved " }), NOW)).state).toBe("recovery");
    expect(expectOk(normalizeEvent(gatusSource(), gatusBody({ status: "Triggered" }), NOW)).state).toBe("problem");
  });

  it.each(["PENDING", "", "OK", 1, null])("rejects unknown status %j", (status) => {
    const errors = expectErrors(normalizeEvent(gatusSource(), gatusBody({ status }), NOW));
    expect(errors.some((error) => error.startsWith("status"))).toBe(true);
  });

  it("requires a status and a name", () => {
    const { status: _status, ...withoutStatus } = gatusBody();
    expect(expectErrors(normalizeEvent(gatusSource(), withoutStatus, NOW)).some((e) => e.startsWith("status"))).toBe(true);
    const { name: _name, ...withoutName } = gatusBody();
    expect(expectErrors(normalizeEvent(gatusSource(), withoutName, NOW)).some((e) => e.startsWith("name"))).toBe(true);
    expect(expectErrors(normalizeEvent(gatusSource(), gatusBody({ name: "   " }), NOW)).some((e) => e.startsWith("name"))).toBe(true);
  });

  it("defaults the summary to empty when there is no description", () => {
    const { description: _description, ...body } = gatusBody();
    expect(expectOk(normalizeEvent(gatusSource(), body, NOW)).summary).toBe("");
  });

  it("ignores fields Gatus is not documented to send", () => {
    const event = expectOk(normalizeEvent(gatusSource(), gatusBody({ severity: "info", type: "spoofed", source: "other" }), NOW));
    expect(event.source).toBe("gatus");
    expect(event.type).toBe("gatus.endpoint");
    expect(event.severity).toBe("critical");
  });

  describe("endpoint identity", () => {
    it("treats an ungrouped endpoint as /name", () => {
      const event = expectOk(normalizeEvent(gatusSource(), gatusBody({ group: "" }), NOW));
      expect(event.dedupeKey).toBe("gatus:/api");
      expect(event.title).toBe("Gatus: /api is failing");
      expect(event.labels).toEqual({ endpoint: "/api" });
    });

    it("treats a missing group like an empty group", () => {
      const { group: _group, ...body } = gatusBody();
      const event = expectOk(normalizeEvent(gatusSource(), body, NOW));
      expect(event.dedupeKey).toBe("gatus:/api");
    });

    it("gives different endpoints different dedupe keys", () => {
      const a = expectOk(normalizeEvent(gatusSource(), gatusBody({ group: "core", name: "api" }), NOW));
      const b = expectOk(normalizeEvent(gatusSource(), gatusBody({ group: "edge", name: "api" }), NOW));
      expect(a.dedupeKey).not.toBe(b.dedupeKey);
    });

    it("percent-escapes non-ASCII characters so the dedupeKey stays printable ASCII", () => {
      const event = expectOk(normalizeEvent(gatusSource(), gatusBody({ group: "café", name: "api 日本" }), NOW));
      expect(event.dedupeKey).toBe("gatus:caf%C3%A9/api %E6%97%A5%E6%9C%AC");
      expect(event.dedupeKey).toMatch(/^[ -~]+$/);
      // The human-readable parts keep the original characters.
      expect(event.title).toBe("Gatus: café/api 日本 is failing");
      expect(event.labels).toEqual({ endpoint: "café/api 日本" });
    });

    it("keeps endpoints that differ only by escaping or by where the slash sits apart", () => {
      const key = (group: string, name: string) =>
        expectOk(normalizeEvent(gatusSource(), gatusBody({ group, name }), NOW)).dedupeKey;
      expect(key("café", "api")).not.toBe(key("caf%C3%A9", "api"));
      expect(key("a/b", "c")).not.toBe(key("a", "b/c"));
      expect(key("a/b", "c")).toBe("gatus:a%2Fb/c");
      expect(key("100%", "api")).toBe("gatus:100%25/api");
    });

    it("percent-escapes astral characters as a single sequence", () => {
      const event = expectOk(normalizeEvent(gatusSource(), gatusBody({ group: "", name: "api \u{1F600}" }), NOW));
      expect(event.dedupeKey).toBe("gatus:/api %F0%9F%98%80");
    });

    it("rejects an endpoint whose escaped dedupeKey exceeds 256 characters", () => {
      const errors = expectErrors(normalizeEvent(gatusSource(), gatusBody({ group: "", name: "日".repeat(100) }), NOW));
      expect(errors.some((error) => error.startsWith("dedupeKey"))).toBe(true);
    });

    // A lone UTF-16 surrogate is a legal JSON string (`"\ud800"`), and `encodeURIComponent` throws a
    // URIError on it. A bad sender body must come back as a validation error, never an exception.
    it("returns a validation result instead of throwing for a lone surrogate in the endpoint name", () => {
      let result: NormalizeEventResult | undefined;
      expect(() => {
        result = normalizeEvent(gatusSource(), gatusBody({ name: "api\uD800" }), NOW);
      }).not.toThrow();
      expect(result).toBeDefined();
    });
  });

  describe("endpointMap", () => {
    const config = {
      endpointMap: {
        "core/api": { type: "http.down", labels: { env: "prod", team: "core" }, severity: "warning" },
        "core/db": { type: "tcp.down" },
        "/standalone": { type: "http.down", labels: { env: "dev" } },
      },
    };

    it("applies a mapped endpoint's type, labels and severity override", () => {
      const event = expectOk(normalizeEvent(gatusSource({ normalizerConfig: config }), gatusBody(), NOW));
      expect(event.type).toBe("http.down");
      expect(event.severity).toBe("warning");
      expect(event.labels).toEqual({ env: "prod", team: "core" });
      expect(event.dedupeKey).toBe("gatus:core/api");
    });

    it("does not add the raw endpoint label to a mapped endpoint", () => {
      const event = expectOk(normalizeEvent(gatusSource({ normalizerConfig: config }), gatusBody(), NOW));
      expect(event.labels).not.toHaveProperty("endpoint");
    });

    it("falls back to critical severity and no labels for a sparse mapping", () => {
      const event = expectOk(normalizeEvent(gatusSource({ normalizerConfig: config }), gatusBody({ name: "db" }), NOW));
      expect(event.type).toBe("tcp.down");
      expect(event.severity).toBe("critical");
      expect(event.labels).toEqual({});
    });

    it("matches an ungrouped endpoint by its /name key", () => {
      const event = expectOk(
        normalizeEvent(gatusSource({ normalizerConfig: config }), gatusBody({ group: "", name: "standalone" }), NOW),
      );
      expect(event.type).toBe("http.down");
      expect(event.labels).toEqual({ env: "dev" });
    });

    it("treats an endpoint absent from the map as unmapped", () => {
      const event = expectOk(normalizeEvent(gatusSource({ normalizerConfig: config }), gatusBody({ name: "cache" }), NOW));
      expect(event.type).toBe("gatus.endpoint");
      expect(event.severity).toBe("critical");
      expect(event.labels).toEqual({ endpoint: "core/cache" });
    });

    it("applies the mapped severity to a recovery too", () => {
      const event = expectOk(normalizeEvent(gatusSource({ normalizerConfig: config }), gatusBody({ status: "RESOLVED" }), NOW));
      expect(event.state).toBe("recovery");
      expect(event.severity).toBe("warning");
      expect(event.type).toBe("http.down");
    });
  });

  describe("pinned labels", () => {
    it("forces pinned labels over mapped labels and the raw endpoint label", () => {
      const mapped = expectOk(
        normalizeEvent(
          gatusSource({
            normalizerConfig: { endpointMap: { "core/api": { type: "http.down", labels: { env: "dev" } } } },
            pinnedLabels: { env: "prod" },
          }),
          gatusBody(),
          NOW,
        ),
      );
      expect(mapped.labels).toEqual({ env: "prod" });

      const unmapped = expectOk(
        normalizeEvent(gatusSource({ pinnedLabels: { endpoint: "forced", region: "eu" } }), gatusBody(), NOW),
      );
      expect(unmapped.labels).toEqual({ endpoint: "forced", region: "eu" });
    });
  });

  describe("url", () => {
    it.each(["ftp://example.com/x", "javascript:alert(1)", "not a url", "//example.com", "data:text/html,hi"])(
      "drops non-http(s) url %j without failing the event",
      (url) => {
        const event = expectOk(normalizeEvent(gatusSource(), gatusBody({ url }), NOW));
        expect(event.url).toBeNull();
      },
    );

    it("keeps an http url and trims whitespace", () => {
      expect(expectOk(normalizeEvent(gatusSource(), gatusBody({ url: "http://203.0.113.5:8080/h" }), NOW)).url).toBe(
        "http://203.0.113.5:8080/h",
      );
      expect(expectOk(normalizeEvent(gatusSource(), gatusBody({ url: "  https://example.com/h  " }), NOW)).url).toBe(
        "https://example.com/h",
      );
    });

    it("yields null when no url is sent", () => {
      const { url: _url, ...body } = gatusBody();
      expect(expectOk(normalizeEvent(gatusSource(), body, NOW)).url).toBeNull();
    });

    it("rejects a url longer than 2048 characters", () => {
      const errors = expectErrors(normalizeEvent(gatusSource(), gatusBody({ url: `https://example.com/${"a".repeat(2100)}` }), NOW));
      expect(errors.some((error) => error.startsWith("url"))).toBe(true);
    });
  });

  it("sanitizes control characters out of a multi-line description without dropping its newlines", () => {
    const event = expectOk(normalizeEvent(gatusSource(), gatusBody({ description: "a\nb\u0000c" }), NOW));
    expect(event.summary).toBe("a\nbc");
  });

  it("flattens a title-breaking endpoint name to a single line", () => {
    const event = expectOk(normalizeEvent(gatusSource(), gatusBody({ group: "", name: "api\n# injected" }), NOW));
    expect(event.title).not.toMatch(/[\r\n]/);
    expect(event.title).toBe("Gatus: /api # injected is failing");
  });
});
