import { isDeepStrictEqual } from "node:util";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidSecretRef(value: string): boolean {
  return UUID_RE.test(value);
}

export type SecretRefBindingObject = {
  secretId: string;
  version: "latest" | number;
};

/**
 * Parses the `{ type: "secret_ref", secretId, version? }` binding object that
 * secret pickers submit for `format: "secret-ref"` config fields. Returns null
 * for anything else (raw values, bare secret-id strings, malformed objects).
 */
export function parseSecretRefBindingObject(value: unknown): SecretRefBindingObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "secret_ref") return null;
  if (typeof record.secretId !== "string" || !isUuidSecretRef(record.secretId.trim())) return null;
  const version = record.version;
  if (version === undefined || version === null || version === "latest") {
    return { secretId: record.secretId.trim(), version: "latest" };
  }
  if (typeof version === "number" && Number.isInteger(version) && version > 0) {
    return { secretId: record.secretId.trim(), version };
  }
  return null;
}

export function collectSecretRefPaths(
  schema: Record<string, unknown> | null | undefined,
): Set<string> {
  const paths = new Set<string>();
  if (!schema || typeof schema !== "object") return paths;

  function walk(node: Record<string, unknown>, prefix: string): void {
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (!branch || typeof branch !== "object" || Array.isArray(branch)) continue;
        walk(branch as Record<string, unknown>, prefix);
      }
    }

    const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
    if (!properties || typeof properties !== "object") return;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!propertySchema || typeof propertySchema !== "object") continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (propertySchema.format === "secret-ref") {
        paths.add(path);
      }
      walk(propertySchema, path);
    }
  }

  walk(schema, "");
  return paths;
}

type SchemaNode = Record<string, unknown>;

// Bounds `$ref` and composition hops that do not move down the value, so a
// `$ref` cycle ends instead of looping.
const MAX_SAME_LOCATION_HOPS = 32;

// Bounds on the value being redacted. Provider output is untrusted: without a
// bound, a deeply nested value overflows the stack in `structuredClone` and in
// the walk, and a huge one costs unbounded time. Real metadata is far smaller.
const MAX_VALUE_DEPTH = 64;
const MAX_VALUE_NODES = 100_000;

/** The value is nested too deeply or has too many nodes to check for secrets. */
export class SecretRefRedactionLimitError extends Error {
  constructor() {
    super("Value is nested too deeply or is too large to check for secrets");
  }
}

// Iterative, so the check itself cannot overflow the stack. A cyclic value
// keeps going deeper until it passes the depth limit.
function assertWithinValueLimits(value: unknown): void {
  const stack: Array<[unknown, number]> = [[value, 1]];
  let nodes = 0;
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (!current || typeof current !== "object") continue;
    if (depth > MAX_VALUE_DEPTH) throw new SecretRefRedactionLimitError();
    const children: unknown[] = Array.isArray(current) ? current : Object.values(current);
    nodes += children.length;
    if (nodes > MAX_VALUE_NODES) throw new SecretRefRedactionLimitError();
    for (const child of children) {
      if (child && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
}

function isSchemaNode(value: unknown): value is SchemaNode {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveLocalSchemaRef(root: SchemaNode, ref: string): SchemaNode | null {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return null;
  let cursor: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    let key: string;
    try {
      key = decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return null;
    }
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return isSchemaNode(cursor) ? cursor : null;
}

function patternMatcher(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return /[\s\S]*/;
  }
}

function arrayItemSchema(schema: SchemaNode, index: number): unknown {
  const tuple = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : null;
  if (tuple && index < tuple.length) return tuple[index];
  return Array.isArray(schema.items) ? schema.additionalItems : schema.items;
}

/**
 * Removes in place every part of `value` that `schema` declares
 * `format: "secret-ref"`. Returns true when `value` itself must be removed by
 * the caller: it is a secret, a `$ref` it depends on cannot be resolved, or its
 * container was emptied by the removal. Each value removed as a secret is also
 * pushed to `sink`, when given.
 */
function redactNode(
  value: unknown,
  schema: unknown,
  root: SchemaNode,
  hops: number,
  sink?: unknown[],
): boolean {
  if (!isSchemaNode(schema)) return false;
  if (schema.format === "secret-ref" || hops > MAX_SAME_LOCATION_HOPS) {
    sink?.push(value);
    return true;
  }

  // Subschemas that apply to this same value.
  const sameLocation: unknown[] = [];
  if (typeof schema.$ref === "string") {
    const target = resolveLocalSchemaRef(root, schema.$ref);
    if (!target) {
      sink?.push(value);
      return true;
    }
    sameLocation.push(target);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) sameLocation.push(...branches);
  }
  sameLocation.push(schema.then, schema.else);
  if (isSchemaNode(schema.dependentSchemas)) sameLocation.push(...Object.values(schema.dependentSchemas));
  for (const branch of sameLocation) {
    if (redactNode(value, branch, root, hops + 1, sink)) return true;
  }

  let removedChild = false;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (redactNode(value[index], arrayItemSchema(schema, index), root, 0, sink)) {
        value.splice(index, 1);
        removedChild = true;
      }
    }
    return removedChild && value.length === 0;
  }

  if (isSchemaNode(value)) {
    const properties = isSchemaNode(schema.properties) ? schema.properties : {};
    const patterns = isSchemaNode(schema.patternProperties)
      ? Object.entries(schema.patternProperties).map(([pattern, sub]) => [patternMatcher(pattern), sub] as const)
      : [];
    for (const key of Object.keys(value)) {
      const applicable: unknown[] = [];
      if (Object.prototype.hasOwnProperty.call(properties, key)) applicable.push(properties[key]);
      for (const [matcher, sub] of patterns) {
        if (matcher.test(key)) applicable.push(sub);
      }
      if (applicable.length === 0) applicable.push(schema.additionalProperties);
      if (applicable.some((sub) => redactNode(value[key], sub, root, 0, sink))) {
        delete value[key];
        removedChild = true;
      }
    }
    return removedChild && Object.keys(value).length === 0;
  }

  return false;
}

/**
 * Returns a copy of `value` without anything `schema` declares
 * `format: "secret-ref"`, at any depth: object properties, array items
 * (including tuples), `additionalProperties` and `patternProperties` maps,
 * allOf/anyOf/oneOf/then/else branches and local `$ref`s. It fails closed: a
 * value behind a `$ref` it cannot resolve (remote, missing or cyclic) is removed.
 * Containers the removal emptied are removed too. Returns undefined when the
 * whole value is a secret. It reads the schema only, so a secret copied under an
 * undeclared key stays. Throws SecretRefRedactionLimitError, before it copies
 * anything, when the value is nested deeper than 64 levels or has more than
 * 100,000 nodes.
 */
export function redactSecretRefValues(
  value: unknown,
  schema: Record<string, unknown> | null | undefined,
): unknown {
  assertWithinValueLimits(value);
  const copy = structuredClone(value);
  if (!isSchemaNode(schema)) return copy;
  return redactNode(copy, schema, schema, 0) ? undefined : copy;
}

export function readConfigValueAtPath(
  config: Record<string, unknown>,
  dotPath: string,
): unknown {
  let current: unknown = config;
  for (const key of dotPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function writeConfigValueAtPath(
  config: Record<string, unknown>,
  dotPath: string,
  value: unknown,
): Record<string, unknown> {
  const result = structuredClone(config) as Record<string, unknown>;
  const keys = dotPath.split(".");
  let cursor: Record<string, unknown> = result;

  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]!;
    const next = cursor[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }

  const leafKey = keys[keys.length - 1]!;
  if (value === undefined) {
    delete cursor[leafKey];
  } else {
    cursor[leafKey] = value;
  }
  return result;
}

const WITHHELD_METADATA_TEXT =
  "Provider metadata is withheld because it is nested too deeply or is too large to check for secrets.";

/**
 * Redacts provider-returned metadata by `schema` for storage or an API response.
 * A value over the limits is replaced by a constant marker and not thrown: the
 * provider has already acted, so failing here would strand what it acquired.
 */
export function redactProviderMetadata(
  value: Record<string, unknown> | null | undefined,
  schema: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  try {
    return (redactSecretRefValues(value ?? {}, schema) ?? {}) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SecretRefRedactionLimitError) return { withheld: WITHHELD_METADATA_TEXT };
    throw error;
  }
}

function extractSecretRefValues(value: unknown, schema: Record<string, unknown> | null | undefined): unknown[] {
  assertWithinValueLimits(value);
  const found: unknown[] = [];
  if (isSchemaNode(schema)) redactNode(structuredClone(value), schema, schema, 0, found);
  return found;
}

/**
 * True when `before` and `after` hold the same values at the positions `schema`
 * declares `format: "secret-ref"`, in any order. Other fields may differ. Throws
 * SecretRefRedactionLimitError when either value is over the limits.
 */
export function haveSameSecretRefValues(
  before: unknown,
  after: unknown,
  schema: Record<string, unknown> | null | undefined,
): boolean {
  const expected = extractSecretRefValues(before, schema);
  const remaining = extractSecretRefValues(after, schema);
  if (expected.length !== remaining.length) return false;
  for (const value of expected) {
    const index = remaining.findIndex((candidate) => isDeepStrictEqual(candidate, value));
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}
