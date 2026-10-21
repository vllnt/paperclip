import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";

function isSlugPosition(value: unknown): value is { slug: string } {
  return typeof value === "object" && value !== null && "slug" in value && typeof value.slug === "string";
}

function isRunPosition(value: unknown): value is { at: string; id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "at" in value &&
    typeof value.at === "string" &&
    "id" in value &&
    typeof value.id === "string"
  );
}

describe("list cursors", () => {
  it("round-trips a position", () => {
    const cursor = encodeCursor({ at: "2026-10-09T12:00:00.000Z", id: "0b9f0e3e-6a8c-4c9c-9f2e-2f6e5a7d1c10" });
    expect(decodeCursor(cursor, isRunPosition)).toEqual({
      at: "2026-10-09T12:00:00.000Z",
      id: "0b9f0e3e-6a8c-4c9c-9f2e-2f6e5a7d1c10",
    });
  });

  it("is URL-safe", () => {
    const cursor = encodeCursor({ slug: "a?b/c+d=e&f~~~~~~~~~~~~~~>>>>>>>" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, isSlugPosition)).toEqual({ slug: "a?b/c+d=e&f~~~~~~~~~~~~~~>>>>>>>" });
  });

  it("reads a missing cursor as no position", () => {
    expect(decodeCursor(undefined, isSlugPosition)).toBeNull();
    expect(decodeCursor("", isSlugPosition)).toBeNull();
  });

  it("rejects text that is not a cursor", () => {
    expect(decodeCursor("not a cursor!!", isSlugPosition)).toBeNull();
    expect(decodeCursor(Buffer.from("plain text", "utf8").toString("base64url"), isSlugPosition)).toBeNull();
    expect(decodeCursor(Buffer.from("{broken", "utf8").toString("base64url"), isSlugPosition)).toBeNull();
  });

  it("rejects a cursor with a position of the wrong shape", () => {
    const slugCursor = encodeCursor({ slug: "triage" });
    expect(decodeCursor(slugCursor, isRunPosition)).toBeNull();
    expect(decodeCursor(Buffer.from('"just a string"', "utf8").toString("base64url"), isSlugPosition)).toBeNull();
    expect(decodeCursor(Buffer.from("null", "utf8").toString("base64url"), isSlugPosition)).toBeNull();
    expect(decodeCursor(Buffer.from('{"slug":7}', "utf8").toString("base64url"), isSlugPosition)).toBeNull();
  });

  it("rejects a cursor that was cut short or edited into something else", () => {
    const cursor = encodeCursor({ slug: "triage" });
    const flipped = `${cursor.slice(0, 4)}${cursor[4] === "A" ? "B" : "A"}${cursor.slice(5)}`;
    expect(decodeCursor(flipped, isSlugPosition)).toBeNull();
    expect(decodeCursor(cursor.slice(0, -3), isSlugPosition)).toBeNull();
  });
});
