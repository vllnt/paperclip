import { describe, expect, it } from "vitest";
import {
  companyArchiveExportQuerySchema,
  decodeCompanyArchiveCursor,
  encodeCompanyArchiveCursor,
} from "./company-archive.js";

const RUN_ID = "5d0c2f7e-8a41-4c0b-9f3e-2b6a1d4e7c90";

describe("company archive cursor", () => {
  it("round-trips a settle key with microseconds and a run id", () => {
    const token = encodeCompanyArchiveCursor({ t: "2026-10-09T12:34:56.123456Z", id: RUN_ID });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCompanyArchiveCursor(token)).toEqual({ t: "2026-10-09T12:34:56.123456Z", id: RUN_ID });
  });

  it("rejects malformed tokens", () => {
    const encode = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeCompanyArchiveCursor("not base64!")).toBeNull();
    expect(decodeCompanyArchiveCursor(encode("plain string"))).toBeNull();
    expect(decodeCompanyArchiveCursor(encode({ v: 2, t: "2026-10-09T12:34:56.123456Z", id: RUN_ID }))).toBeNull();
    // Millisecond precision would make the keyset skip or repeat rows.
    expect(decodeCompanyArchiveCursor(encode({ v: 1, t: "2026-10-09T12:34:56.123Z", id: RUN_ID }))).toBeNull();
    expect(decodeCompanyArchiveCursor(encode({ v: 1, t: "2026-10-09T12:34:56.123456Z", id: "x" }))).toBeNull();
    expect(decodeCompanyArchiveCursor(encode({ v: 1, t: "2026-13-45T25:61:61.000000Z", id: RUN_ID }))).toBeNull();
    expect(decodeCompanyArchiveCursor(encode({ v: 1, t: "2026-02-30T00:00:00.000000Z", id: RUN_ID }))).toBeNull();
  });
});

describe("company archive export query", () => {
  it("parses include lists and rejects unknown entities", () => {
    expect(companyArchiveExportQuerySchema.parse({ include: "run, events,events" }).include).toEqual(["run", "events"]);
    expect(companyArchiveExportQuerySchema.safeParse({ include: "run,secrets" }).success).toBe(false);
    expect(companyArchiveExportQuerySchema.safeParse({ include: "" }).success).toBe(false);
  });

  it("bounds the page size and rejects unknown parameters", () => {
    expect(companyArchiveExportQuerySchema.parse({ limit: "25" }).limit).toBe(25);
    expect(companyArchiveExportQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
    expect(companyArchiveExportQuerySchema.safeParse({ companyId: "x" }).success).toBe(false);
  });
});
