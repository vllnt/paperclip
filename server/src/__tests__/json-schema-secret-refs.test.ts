import { describe, expect, it } from "vitest";
import {
  collectSecretRefPaths,
  parseSecretRefBindingObject,
  redactSecretRefValues,
} from "../services/json-schema-secret-refs.ts";

describe("parseSecretRefBindingObject", () => {
  const secretId = "11111111-1111-1111-1111-111111111111";

  it("parses a binding object and defaults the version to latest", () => {
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId })).toEqual({
      secretId,
      version: "latest",
    });
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId, version: "latest" })).toEqual({
      secretId,
      version: "latest",
    });
  });

  it("parses a pinned numeric version", () => {
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId, version: 3 })).toEqual({
      secretId,
      version: 3,
    });
  });

  it("rejects non-binding values", () => {
    expect(parseSecretRefBindingObject(secretId)).toBeNull();
    expect(parseSecretRefBindingObject("raw-api-key")).toBeNull();
    expect(parseSecretRefBindingObject(null)).toBeNull();
    expect(parseSecretRefBindingObject([{ type: "secret_ref", secretId }])).toBeNull();
    expect(parseSecretRefBindingObject({ type: "user_secret_ref", secretId })).toBeNull();
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId: "not-a-uuid" })).toBeNull();
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId, version: 0 })).toBeNull();
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId, version: "2" })).toBeNull();
  });
});

describe("collectSecretRefPaths", () => {
  it("collects nested secret-ref paths from object properties", () => {
    expect(Array.from(collectSecretRefPaths({
      type: "object",
      properties: {
        credentials: {
          type: "object",
          properties: {
            apiKey: { type: "string", format: "secret-ref" },
          },
        },
      },
    }))).toEqual(["credentials.apiKey"]);
  });

  it("collects secret-ref paths from JSON Schema composition keywords", () => {
    expect(Array.from(collectSecretRefPaths({
      type: "object",
      allOf: [
        {
          properties: {
            apiKey: { type: "string", format: "secret-ref" },
          },
        },
        {
          properties: {
            nested: {
              oneOf: [
                {
                  properties: {
                    token: { type: "string", format: "secret-ref" },
                  },
                },
              ],
            },
          },
        },
      ],
    })).sort()).toEqual(["apiKey", "nested.token"]);
  });
});

describe("redactSecretRefValues", () => {
  const SECRET = "resolved-secret-value";
  const secretString = { type: "string", format: "secret-ref" };

  it("removes declared properties and keeps the rest", () => {
    const schema = {
      type: "object",
      properties: { region: { type: "string" }, apiKey: secretString },
    };
    expect(redactSecretRefValues({ region: "us", apiKey: SECRET }, schema)).toEqual({ region: "us" });
  });

  it("removes array elements declared as secret-ref", () => {
    const schema = {
      type: "object",
      properties: { region: { type: "string" }, tokens: { type: "array", items: secretString } },
    };
    const result = redactSecretRefValues({ region: "us", tokens: [SECRET, `${SECRET}-2`] }, schema);
    expect(result).toEqual({ region: "us" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("removes secret fields inside array items and nested arrays", () => {
    const schema = {
      type: "object",
      properties: {
        hosts: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, token: secretString } },
        },
        matrix: { type: "array", items: { type: "array", items: secretString } },
      },
    };
    const result = redactSecretRefValues(
      { hosts: [{ name: "a", token: SECRET }, { name: "b", token: SECRET }], matrix: [[SECRET], [SECRET]] },
      schema,
    );
    expect(result).toEqual({ hosts: [{ name: "a" }, { name: "b" }] });
  });

  it("follows local $ref into $defs and definitions", () => {
    const schema = {
      type: "object",
      $defs: {
        credential: { type: "object", properties: { id: { type: "string" }, token: secretString } },
        secret: secretString,
      },
      definitions: { legacy: secretString },
      properties: {
        primary: { $ref: "#/$defs/credential" },
        others: { type: "array", items: { $ref: "#/$defs/credential" } },
        apiKey: { $ref: "#/$defs/secret" },
        oldKey: { $ref: "#/definitions/legacy" },
      },
    };
    const result = redactSecretRefValues(
      {
        primary: { id: "p", token: SECRET },
        others: [{ id: "o", token: SECRET }],
        apiKey: SECRET,
        oldKey: SECRET,
      },
      schema,
    );
    expect(result).toEqual({ primary: { id: "p" }, others: [{ id: "o" }] });
  });

  it("removes a value when its $ref cannot be resolved, rather than keeping it", () => {
    const schema = {
      type: "object",
      properties: {
        remote: { $ref: "https://example.test/schema.json" },
        missing: { $ref: "#/$defs/nope" },
        loopA: { $ref: "#/$defs/b" },
        kept: { type: "string" },
      },
      $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } },
    };
    expect(
      redactSecretRefValues({ remote: SECRET, missing: SECRET, loopA: SECRET, kept: "ok" }, schema),
    ).toEqual({ kept: "ok" });
  });

  it("covers additionalProperties maps, patternProperties and tuple items", () => {
    const schema = {
      type: "object",
      properties: {
        label: { type: "string" },
        byRegion: { type: "object", additionalProperties: secretString },
        byPrefix: { type: "object", patternProperties: { "^key_": secretString } },
        pair: { type: "array", prefixItems: [{ type: "string" }, secretString] },
        legacyPair: { type: "array", items: [{ type: "string" }, secretString] },
      },
    };
    const result = redactSecretRefValues(
      {
        label: "x",
        byRegion: { us: SECRET, eu: SECRET },
        byPrefix: { key_a: SECRET, note: "n" },
        pair: ["name", SECRET],
        legacyPair: ["name", SECRET],
      },
      schema,
    );
    expect(result).toEqual({
      label: "x",
      byPrefix: { note: "n" },
      pair: ["name"],
      legacyPair: ["name"],
    });
  });

  it("covers allOf/anyOf/oneOf branches and then/else", () => {
    const schema = {
      type: "object",
      allOf: [{ properties: { a: secretString } }],
      anyOf: [{ properties: { b: secretString } }],
      oneOf: [{ properties: { c: secretString } }],
      then: { properties: { d: secretString } },
      else: { properties: { e: secretString } },
    };
    expect(
      redactSecretRefValues({ a: SECRET, b: SECRET, c: SECRET, d: SECRET, e: SECRET, f: "ok" }, schema),
    ).toEqual({ f: "ok" });
  });

  it("removes a container that the removal emptied but keeps one that was already empty", () => {
    const schema = {
      type: "object",
      properties: {
        connection: { type: "object", properties: { token: secretString } },
        tokens: { type: "array", items: secretString },
        untouched: { type: "object", properties: { token: secretString } },
      },
    };
    expect(
      redactSecretRefValues({ connection: { token: SECRET }, tokens: [SECRET], untouched: {} }, schema),
    ).toEqual({ untouched: {} });
  });

  it("does not change its input, and returns the value as is without a schema", () => {
    const schema = { type: "object", properties: { apiKey: secretString } };
    const input = { apiKey: SECRET, region: "us" };
    redactSecretRefValues(input, schema);
    expect(input).toEqual({ apiKey: SECRET, region: "us" });
    expect(redactSecretRefValues(input, null)).toEqual(input);
    expect(redactSecretRefValues(input, undefined)).toEqual(input);
  });
});
