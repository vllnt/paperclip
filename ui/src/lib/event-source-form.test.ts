import { describe, expect, it } from "vitest";
import type { EventSource } from "@/api/eventSources";
import {
  buildCreateInput,
  buildUpdateInput,
  emptyFormState,
  formFromSource,
  newPinnedRow,
  parseEndpointMap,
  sampleTestPayload,
  validateSourceForm,
} from "./event-source-form";

function valid() {
  return { ...emptyFormState(), name: "Gatus" };
}

describe("validateSourceForm", () => {
  it("requires a name", () => {
    const result = validateSourceForm(emptyFormState());
    expect(result.valid).toBe(false);
    expect(result.errors.name).toBeTruthy();
    expect(validateSourceForm(valid()).valid).toBe(true);
  });

  it("checks the replay window range only for signed sources", () => {
    expect(validateSourceForm({ ...valid(), replayWindowSec: "10" }).errors.replayWindowSec).toBeTruthy();
    expect(validateSourceForm({ ...valid(), replayWindowSec: "86401" }).errors.replayWindowSec).toBeTruthy();
    expect(validateSourceForm({ ...valid(), replayWindowSec: "30" }).valid).toBe(true);
    expect(validateSourceForm({ ...valid(), replayWindowSec: "86400" }).valid).toBe(true);
    expect(validateSourceForm({ ...valid(), signingMode: "bearer", replayWindowSec: "1" }).valid).toBe(true);
  });

  it("checks the numeric limits", () => {
    expect(validateSourceForm({ ...valid(), rateLimitPerMinute: "0" }).errors.rateLimitPerMinute).toBeTruthy();
    expect(validateSourceForm({ ...valid(), maxNewIssuesPerHour: "1.5" }).errors.maxNewIssuesPerHour).toBeTruthy();
    expect(validateSourceForm({ ...valid(), retentionDays: "abc" }).errors.retentionDays).toBeTruthy();
  });

  it("validates pinned labels", () => {
    const errorFor = (rows: ReturnType<typeof newPinnedRow>[]) =>
      validateSourceForm({ ...valid(), pinned: rows }).errors.pinned;
    expect(errorFor([newPinnedRow("", "x")])).toContain("name");
    expect(errorFor([newPinnedRow("Relay", "x")])).toContain("Relay");
    expect(errorFor([newPinnedRow("relay", "")])).toContain("value");
    expect(errorFor([newPinnedRow("relay", "a"), newPinnedRow("relay", "b")])).toContain("twice");
    expect(errorFor([newPinnedRow("relay", "security-host")])).toBeUndefined();
  });

  it("validates the gatus endpoint map", () => {
    const gatus = { ...valid(), normalizer: "gatus" as const };
    expect(validateSourceForm({ ...gatus, endpointMapText: "{" }).errors.endpointMap).toContain("JSON");
    expect(validateSourceForm({ ...gatus, endpointMapText: "[]" }).errors.endpointMap).toBeTruthy();
    expect(validateSourceForm({ ...gatus, endpointMapText: '{"core/a": 3}' }).errors.endpointMap).toContain("core/a");
    expect(
      validateSourceForm({ ...gatus, endpointMapText: '{"core/a": {"type": "disk.usage", "labels": {"host_id": "vm1"}}}' })
        .valid,
    ).toBe(true);
    // The map is ignored for the generic normalizer.
    expect(validateSourceForm({ ...valid(), endpointMapText: "{" }).valid).toBe(true);
  });
});

describe("parseEndpointMap", () => {
  it("treats blank as no map", () => {
    expect(parseEndpointMap("  ")).toEqual({ map: null });
  });
});

describe("build inputs", () => {
  it("omits blank numeric fields so server defaults apply", () => {
    expect(buildCreateInput(valid())).toEqual({
      name: "Gatus",
      signingMode: "hmac_sha256",
      normalizer: "generic_v1",
      normalizerConfig: null,
      pinnedLabels: {},
    });
  });

  it("sends set values, pinned labels and the gatus map", () => {
    const input = buildCreateInput({
      ...valid(),
      name: "  Gatus  ",
      normalizer: "gatus",
      endpointMapText: '{"core/a": {"type": "disk.usage"}}',
      pinned: [newPinnedRow(" relay ", " security-host ")],
      replayWindowSec: "120",
      rateLimitPerMinute: "60",
      maxNewIssuesPerHour: "5",
      retentionDays: "7",
    });
    expect(input).toMatchObject({
      name: "Gatus",
      normalizer: "gatus",
      normalizerConfig: { endpointMap: { "core/a": { type: "disk.usage" } } },
      pinnedLabels: { relay: "security-host" },
      replayWindowSec: 120,
      rateLimitPerMinute: 60,
      maxNewIssuesPerHour: 5,
      retentionDays: 7,
    });
  });

  it("never sends the signing mode or replay window when editing a bearer source", () => {
    const update = buildUpdateInput({ ...valid(), signingMode: "bearer", replayWindowSec: "120" });
    expect(update).not.toHaveProperty("signingMode");
    expect(update).not.toHaveProperty("replayWindowSec");
  });
});

describe("formFromSource", () => {
  it("round-trips a stored source", () => {
    const source = {
      id: "s1",
      name: "Upkeep",
      signingMode: "hmac_sha256",
      normalizer: "gatus",
      normalizerConfig: { endpointMap: { "core/a": { type: "disk.usage" } } },
      pinnedLabels: { relay: "security-host" },
      replayWindowSec: 300,
      rateLimitPerMinute: 600,
      maxNewIssuesPerHour: 20,
      retentionDays: 30,
    } as unknown as EventSource;
    const form = formFromSource(source);
    expect(form.name).toBe("Upkeep");
    expect(form.pinned.map((row) => [row.key, row.value])).toEqual([["relay", "security-host"]]);
    expect(JSON.parse(form.endpointMapText)).toEqual(source.normalizerConfig?.endpointMap);
    expect(validateSourceForm(form).valid).toBe(true);
  });
});

describe("sampleTestPayload", () => {
  it("offers a generic_v1 sample and no invented gatus body", () => {
    expect(sampleTestPayload("generic_v1")).toMatchObject({ schema: "paperclip.event.v1", source: "upkeep" });
    expect(sampleTestPayload("gatus")).toEqual({});
  });
});
