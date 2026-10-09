import { describe, expect, it } from "vitest";
import {
  SecretRefRedactionLimitError,
  collectSecretRefPaths,
  haveSameSecretRefValues,
  parseSecretRefBindingObject,
  redactProviderMetadata,
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

describe("redactSecretRefValues limits", () => {
  const schema = {
    type: "object",
    properties: { apiKey: { type: "string", format: "secret-ref" } },
  };

  function nestedObject(depth: number): unknown {
    let value: unknown = "leaf";
    for (let level = 0; level < depth; level += 1) value = { child: value };
    return value;
  }

  function nestedArray(depth: number): unknown {
    let value: unknown = "leaf";
    for (let level = 0; level < depth; level += 1) value = [value];
    return value;
  }

  it("throws a limit error, not a RangeError, for values nested far past the depth limit", () => {
    for (const depth of [65, 5_000, 10_000]) {
      expect(() => redactSecretRefValues(nestedObject(depth), schema)).toThrow(SecretRefRedactionLimitError);
      expect(() => redactSecretRefValues(nestedArray(depth), schema)).toThrow(SecretRefRedactionLimitError);
    }
  });

  it("accepts a value nested exactly at the depth limit", () => {
    expect(() => redactSecretRefValues(nestedObject(64), schema)).not.toThrow();
  });

  it("throws a limit error for a cyclic value", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => redactSecretRefValues(cyclic, schema)).toThrow(SecretRefRedactionLimitError);
  });

  it("throws a limit error for a value with too many nodes, and still handles a large flat one", () => {
    expect(() => redactSecretRefValues(new Array(100_001).fill(1), schema)).toThrow(SecretRefRedactionLimitError);
    const flat: Record<string, unknown> = { apiKey: "resolved-secret-value" };
    for (let index = 0; index < 20_000; index += 1) flat[`key${index}`] = "x";
    const result = redactSecretRefValues(flat, schema) as Record<string, unknown>;
    expect(result).not.toHaveProperty("apiKey");
    expect(Object.keys(result)).toHaveLength(20_000);
  });

  it("redactProviderMetadata withholds an over-limit value behind a constant marker and redacts the rest", () => {
    const marker = redactProviderMetadata({ deep: nestedObject(10_000), apiKey: "resolved-secret-value" }, schema);
    expect(marker).toEqual({ withheld: expect.any(String) });
    expect(JSON.stringify(marker)).not.toContain("resolved-secret-value");
    expect(redactProviderMetadata({ region: "us", apiKey: "resolved-secret-value" }, schema)).toEqual({ region: "us" });
    expect(redactProviderMetadata(null, schema)).toEqual({});
    expect(redactProviderMetadata({ apiKey: "resolved-secret-value" }, schema)).toEqual({});
  });
});

describe("haveSameSecretRefValues", () => {
  const secretString = { type: "string", format: "secret-ref" };
  const schema = {
    type: "object",
    $defs: { credential: { type: "object", properties: { host: { type: "string" }, token: secretString } } },
    properties: {
      template: { type: "string" },
      apiKey: secretString,
      tokens: { type: "array", items: secretString },
      replicas: { type: "array", items: { $ref: "#/$defs/credential" } },
    },
  };
  const before = {
    template: "Base",
    apiKey: "id-1",
    tokens: ["id-2", "id-3"],
    replicas: [{ host: "a", token: "id-4" }],
  };

  it("ignores non-secret changes, key order and the order of secret array items", () => {
    expect(
      haveSameSecretRefValues(
        before,
        {
          replicas: [{ token: "id-4", host: "renamed" }],
          tokens: ["id-3", "id-2"],
          apiKey: "id-1",
          template: "base",
          extra: "added",
        },
        schema,
      ),
    ).toBe(true);
  });

  it("detects a changed, added, removed or reordered-into-another-field secret value", () => {
    expect(haveSameSecretRefValues(before, { ...before, apiKey: "resolved-secret-value" }, schema)).toBe(false);
    expect(haveSameSecretRefValues(before, { ...before, tokens: ["id-2", "id-3", "resolved-secret-value"] }, schema)).toBe(false);
    expect(haveSameSecretRefValues(before, { ...before, tokens: ["id-2"] }, schema)).toBe(false);
    expect(
      haveSameSecretRefValues(before, { ...before, replicas: [{ host: "a", token: "resolved-secret-value" }] }, schema),
    ).toBe(false);
    expect(haveSameSecretRefValues({ template: "x" }, { template: "x", apiKey: "resolved-secret-value" }, schema)).toBe(false);
  });

  it("treats everything as equal when the schema declares no secret-ref field", () => {
    expect(haveSameSecretRefValues({ a: 1 }, { a: 2 }, { type: "object", properties: { a: { type: "number" } } })).toBe(true);
    expect(haveSameSecretRefValues({ a: 1 }, { a: 2 }, null)).toBe(true);
  });

  it("throws the limit error for an over-limit value on either side", () => {
    let deep: unknown = "leaf";
    for (let level = 0; level < 10_000; level += 1) deep = { child: deep };
    expect(() => haveSameSecretRefValues(before, { deep }, schema)).toThrow(SecretRefRedactionLimitError);
    expect(() => haveSameSecretRefValues({ deep }, before, schema)).toThrow(SecretRefRedactionLimitError);
  });
});
