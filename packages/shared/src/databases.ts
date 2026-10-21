import { z } from "zod";

/** Most databases one company may keep that are not archived. */
export const MAX_DATABASES_PER_COMPANY = 1_000;
/** Most properties one database may define, archived ones included. */
export const MAX_DATABASE_PROPERTIES = 100;
/** Most options one select property may define. */
export const MAX_DATABASE_SELECT_OPTIONS = 200;
/** Most rows one database may hold that are not deleted. */
export const MAX_DATABASE_ROWS = 50_000;
/** Largest serialized `cells` object of one row, in bytes. */
export const MAX_DATABASE_ROW_CELLS_BYTES = 64 * 1024;
/** Longest value of a text property, in characters. */
export const MAX_DATABASE_TEXT_LENGTH = 10_000;
/** Longest row title, in characters. */
export const MAX_DATABASE_ROW_TITLE_LENGTH = 500;
/** Longest caller-supplied row key, in characters. */
export const MAX_DATABASE_ROW_KEY_LENGTH = 255;
export const DEFAULT_DATABASE_PAGE_LIMIT = 50;
export const MAX_DATABASE_PAGE_LIMIT = 200;
/** A page of rows stops early once its serialized rows reach this many bytes, so it fits the sandbox bridge. */
export const MAX_DATABASE_ROWS_PAGE_BYTES = 4 * 1024 * 1024;

/** A database key is a lowercase slug, unique in its company. */
export const DATABASE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** A property key is a lowercase slug, unique in its database (archived properties included) and never changed. */
export const DATABASE_PROPERTY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** Select option ids are short slugs the server assigns. */
export const DATABASE_SELECT_OPTION_ID_PATTERN = /^[a-z0-9]{1,32}$/;
/** Every database has exactly one title property, with this key. Its value lives in the row's `title`. */
export const DATABASE_TITLE_PROPERTY_KEY = "title";

export const DATABASE_PROPERTY_TYPES = ["title", "text", "number", "select"] as const;
export type DatabasePropertyType = (typeof DATABASE_PROPERTY_TYPES)[number];

export const DATABASE_NUMBER_FORMATS = ["plain", "percent", "currency"] as const;
export type DatabaseNumberFormat = (typeof DATABASE_NUMBER_FORMATS)[number];

/** `read` locks a database against agent writes. It never hides the database. */
export const DATABASE_AGENT_ACCESS_MODES = ["write", "read"] as const;
export type DatabaseAgentAccess = (typeof DATABASE_AGENT_ACCESS_MODES)[number];

export const databaseKeySchema = z
  .string()
  .trim()
  .regex(DATABASE_KEY_PATTERN, "Database keys are lowercase letters, digits and hyphens, start with a letter (max 64)");

export const databasePropertyKeySchema = z
  .string()
  .trim()
  .regex(
    DATABASE_PROPERTY_KEY_PATTERN,
    "Property keys are lowercase letters, digits and underscores, start with a letter (max 64)",
  );

const propertyNameSchema = z.string().trim().min(1).max(100);
const optionNameSchema = z.string().trim().min(1).max(100);

export const databaseSelectOptionSchema = z
  .object({
    id: z.string().regex(DATABASE_SELECT_OPTION_ID_PATTERN),
    name: optionNameSchema,
  })
  .strict();
export type DatabaseSelectOption = z.infer<typeof databaseSelectOptionSchema>;

const numberConfigSchema = z
  .object({
    format: z.enum(DATABASE_NUMBER_FORMATS).default("plain"),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "Currency is a three-letter ISO 4217 code")
      .nullable()
      .default(null),
  })
  .strict();

const emptyConfigSchema = z.object({}).strict();

const storedPropertyBase = {
  key: databasePropertyKeySchema,
  name: propertyNameSchema,
  archivedAt: z.string().datetime({ offset: true }).nullable().default(null),
};

/** A property as the database stores it and the API returns it. Array order is display order. */
export const databasePropertySchema = z.discriminatedUnion("type", [
  z.object({ ...storedPropertyBase, type: z.literal("title"), config: emptyConfigSchema.default({}) }).strict(),
  z.object({ ...storedPropertyBase, type: z.literal("text"), config: emptyConfigSchema.default({}) }).strict(),
  z.object({ ...storedPropertyBase, type: z.literal("number"), config: numberConfigSchema.default({ format: "plain", currency: null }) }).strict(),
  z
    .object({
      ...storedPropertyBase,
      type: z.literal("select"),
      config: z
        .object({ options: z.array(databaseSelectOptionSchema).max(MAX_DATABASE_SELECT_OPTIONS).default([]) })
        .strict()
        .default({ options: [] }),
    })
    .strict(),
]);
export type DatabaseProperty = z.infer<typeof databasePropertySchema>;

const inputPropertyBase = {
  key: databasePropertyKeySchema,
  name: propertyNameSchema,
  archived: z.boolean().optional(),
};

/**
 * A property as a caller sends it on create or in a full schema update. A select option without
 * an `id` is new; the server assigns its id. An option with an `id` keeps it.
 */
export const databasePropertyInputSchema = z.discriminatedUnion("type", [
  z.object({ ...inputPropertyBase, type: z.literal("title"), config: emptyConfigSchema.optional() }).strict(),
  z.object({ ...inputPropertyBase, type: z.literal("text"), config: emptyConfigSchema.optional() }).strict(),
  z.object({ ...inputPropertyBase, type: z.literal("number"), config: numberConfigSchema.partial().optional() }).strict(),
  z
    .object({
      ...inputPropertyBase,
      type: z.literal("select"),
      config: z
        .object({
          options: z
            .array(
              z
                .object({ id: z.string().regex(DATABASE_SELECT_OPTION_ID_PATTERN).optional(), name: optionNameSchema })
                .strict(),
            )
            .max(MAX_DATABASE_SELECT_OPTIONS)
            .default([]),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export type DatabasePropertyInput = z.infer<typeof databasePropertyInputSchema>;

const propertyInputListSchema = z.array(databasePropertyInputSchema).max(MAX_DATABASE_PROPERTIES);

export const createDatabaseSchema = z
  .object({
    key: databaseKeySchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4_000).nullable().optional(),
    projectId: z.string().guid().nullable().optional(),
    properties: propertyInputListSchema.optional(),
  })
  .strict();
export type CreateDatabase = z.infer<typeof createDatabaseSchema>;

export const updateDatabaseSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(4_000).nullable().optional(),
    projectId: z.string().guid().nullable().optional(),
    agentAccess: z.enum(DATABASE_AGENT_ACCESS_MODES).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Send at least one field to update");
export type UpdateDatabase = z.infer<typeof updateDatabaseSchema>;

export const putDatabaseSchemaSchema = z
  .object({
    expectedSchemaRevision: z.number().int().min(1),
    properties: propertyInputListSchema,
  })
  .strict();
export type PutDatabaseSchema = z.infer<typeof putDatabaseSchemaSchema>;

const booleanQuerySchema = z.enum(["true", "false"]).transform((value) => value === "true");

export const listDatabasesQuerySchema = z
  .object({
    projectId: z.string().guid().optional(),
    key: databaseKeySchema.optional(),
    archived: booleanQuerySchema.optional(),
    q: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_DATABASE_PAGE_LIMIT).default(DEFAULT_DATABASE_PAGE_LIMIT),
  })
  .strict();
export type ListDatabasesQuery = z.infer<typeof listDatabasesQuerySchema>;

const rowKeySchema = z.string().trim().min(1).max(MAX_DATABASE_ROW_KEY_LENGTH);
const rowTitleSchema = z.string().max(MAX_DATABASE_ROW_TITLE_LENGTH);
const rowCellsInputSchema = z.record(z.string(), z.unknown());

export const createDatabaseRowSchema = z
  .object({
    key: rowKeySchema.nullable().optional(),
    title: rowTitleSchema.optional(),
    cells: rowCellsInputSchema.optional(),
  })
  .strict();
export type CreateDatabaseRow = z.infer<typeof createDatabaseRowSchema>;

export const updateDatabaseRowSchema = z
  .object({
    key: rowKeySchema.nullable().optional(),
    title: rowTitleSchema.optional(),
    cells: rowCellsInputSchema.optional(),
    expectedRevision: z.number().int().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => value.key !== undefined || value.title !== undefined || value.cells !== undefined,
    "Send at least one of key, title or cells",
  );
export type UpdateDatabaseRow = z.infer<typeof updateDatabaseRowSchema>;

export const listDatabaseRowsQuerySchema = z
  .object({
    cursor: z.string().regex(/^\d{1,18}$/, "The cursor is the seq of the last row of the previous page").optional(),
    limit: z.coerce.number().int().min(1).max(MAX_DATABASE_PAGE_LIMIT).default(DEFAULT_DATABASE_PAGE_LIMIT),
  })
  .strict();
export type ListDatabaseRowsQuery = z.infer<typeof listDatabaseRowsQuerySchema>;

export interface DatabaseActor {
  agentId: string | null;
  userId: string | null;
  runId: string | null;
}

export interface Database {
  id: string;
  companyId: string;
  projectId: string | null;
  key: string;
  title: string;
  description: string | null;
  properties: DatabaseProperty[];
  schemaRevision: number;
  agentAccess: DatabaseAgentAccess;
  rowCount: number;
  createdBy: DatabaseActor;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseListPage {
  databases: Database[];
  nextCursor: string | null;
}

/** A select cell as the API returns it. */
export interface DatabaseSelectCell {
  id: string;
  name: string;
}

export type DatabaseCellOutput = string | number | DatabaseSelectCell | null;

export interface DatabaseRow {
  id: string;
  companyId: string;
  databaseId: string;
  seq: number;
  key: string | null;
  title: string;
  cells: Record<string, DatabaseCellOutput>;
  revision: number;
  createdBy: DatabaseActor;
  updatedBy: DatabaseActor;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseRowPage {
  rows: DatabaseRow[];
  nextCursor: string | null;
}

/** One problem found while checking a property list or a row's cells against a database schema. */
export interface DatabaseSchemaIssue {
  key: string | null;
  message: string;
}

export type DatabaseCheckResult<T> = { ok: true; value: T } | { ok: false; issues: DatabaseSchemaIssue[] };

function activeProperties(properties: readonly DatabaseProperty[]): DatabaseProperty[] {
  return properties.filter((property) => property.archivedAt === null);
}

/** The properties a reader sees: not archived, in display order. */
export function visibleDatabaseProperties(properties: readonly DatabaseProperty[]): DatabaseProperty[] {
  return activeProperties(properties);
}

/**
 * Checks one property list as a whole: exactly one title property keyed `title` and never
 * archived, unique keys, unique option names per select property (case-insensitive), unique
 * option ids, and the property cap.
 */
export function checkDatabasePropertyList(properties: readonly DatabaseProperty[]): DatabaseSchemaIssue[] {
  const issues: DatabaseSchemaIssue[] = [];
  if (properties.length > MAX_DATABASE_PROPERTIES) {
    issues.push({ key: null, message: `A database has at most ${MAX_DATABASE_PROPERTIES} properties` });
  }
  const seen = new Set<string>();
  for (const property of properties) {
    if (seen.has(property.key)) issues.push({ key: property.key, message: "Property keys must be unique" });
    seen.add(property.key);
    if (property.type === "title" && property.key !== DATABASE_TITLE_PROPERTY_KEY) {
      issues.push({ key: property.key, message: `The title property must use the key "${DATABASE_TITLE_PROPERTY_KEY}"` });
    }
    if (property.key === DATABASE_TITLE_PROPERTY_KEY && property.type !== "title") {
      issues.push({ key: property.key, message: `The key "${DATABASE_TITLE_PROPERTY_KEY}" is reserved for the title property` });
    }
    if (property.type === "title" && property.archivedAt !== null) {
      issues.push({ key: property.key, message: "The title property cannot be archived" });
    }
    if (property.type === "select") {
      const names = new Set<string>();
      const ids = new Set<string>();
      for (const option of property.config.options) {
        const folded = option.name.toLowerCase();
        if (names.has(folded)) issues.push({ key: property.key, message: `Option names must be unique: "${option.name}"` });
        if (ids.has(option.id)) issues.push({ key: property.key, message: `Option ids must be unique: "${option.id}"` });
        names.add(folded);
        ids.add(option.id);
      }
    }
  }
  const titles = properties.filter((property) => property.type === "title");
  if (titles.length !== 1) issues.push({ key: null, message: "A database has exactly one title property" });
  return issues;
}

/** The default schema of a new database that names no properties: just the title. */
export function defaultDatabaseProperties(): DatabaseProperty[] {
  return [{ key: DATABASE_TITLE_PROPERTY_KEY, name: "Name", type: "title", config: {}, archivedAt: null }];
}

function resolveSelectOption(
  property: Extract<DatabaseProperty, { type: "select" }>,
  raw: string,
): DatabaseSelectOption | undefined {
  const byId = property.config.options.find((option) => option.id === raw);
  if (byId) return byId;
  const folded = raw.trim().toLowerCase();
  return property.config.options.find((option) => option.name.toLowerCase() === folded);
}

/**
 * Checks the cells a caller sends against a database's properties and returns them in stored form:
 * select cells become option ids. A key that is unknown, archived or the title is refused; send
 * the title in the row's `title` field. `null` clears a cell.
 */
export function normalizeDatabaseRowCells(
  properties: readonly DatabaseProperty[],
  cells: Record<string, unknown>,
): DatabaseCheckResult<Record<string, string | number | null>> {
  const issues: DatabaseSchemaIssue[] = [];
  const byKey = new Map(properties.map((property) => [property.key, property]));
  const normalized: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(cells)) {
    const property = byKey.get(key);
    if (!property) {
      issues.push({ key, message: "Unknown property" });
      continue;
    }
    if (property.archivedAt !== null) {
      issues.push({ key, message: "The property is archived" });
      continue;
    }
    if (property.type === "title") {
      issues.push({ key, message: "Send the title in the row's title field, not in cells" });
      continue;
    }
    if (value === null) {
      normalized[key] = null;
      continue;
    }
    if (property.type === "text") {
      if (typeof value !== "string") issues.push({ key, message: "Expected a string" });
      else if (value.length > MAX_DATABASE_TEXT_LENGTH) {
        issues.push({ key, message: `Text is at most ${MAX_DATABASE_TEXT_LENGTH} characters` });
      } else normalized[key] = value;
    } else if (property.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) issues.push({ key, message: "Expected a finite number" });
      else normalized[key] = value;
    } else {
      const option = typeof value === "string" ? resolveSelectOption(property, value) : undefined;
      if (!option) issues.push({ key, message: "Expected the id or the name of an existing option" });
      else normalized[key] = option.id;
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: normalized };
}

/**
 * Turns stored cells into API output for the current schema. Archived and unknown properties are
 * left out, select cells become `{ id, name }`, and a select cell whose option was removed reads as
 * `null`.
 */
export function presentDatabaseRowCells(
  properties: readonly DatabaseProperty[],
  stored: Record<string, unknown>,
): Record<string, DatabaseCellOutput> {
  const output: Record<string, DatabaseCellOutput> = {};
  for (const property of activeProperties(properties)) {
    if (property.type === "title") continue;
    const value = stored[property.key];
    if (value === undefined || value === null) {
      output[property.key] = null;
    } else if (property.type === "select") {
      const option = typeof value === "string" ? property.config.options.find((entry) => entry.id === value) : undefined;
      output[property.key] = option ? { id: option.id, name: option.name } : null;
    } else if (property.type === "number") {
      output[property.key] = typeof value === "number" ? value : null;
    } else {
      output[property.key] = typeof value === "string" ? value : null;
    }
  }
  return output;
}

/** Bytes of a cells object once serialized, the measure the per-row cap uses. */
export function databaseRowCellsByteLength(cells: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(cells)).length;
}

function storedFromInput(
  input: DatabasePropertyInput,
  previous: DatabaseProperty | undefined,
  now: string,
  newOptionId: () => string,
  issues: DatabaseSchemaIssue[],
): DatabaseProperty {
  const archivedAt =
    input.archived === true ? previous?.archivedAt ?? now : input.archived === false ? null : previous?.archivedAt ?? null;
  const base = { key: input.key, name: input.name, archivedAt };
  if (input.type === "select") {
    const previousOptions = previous?.type === "select" ? previous.config.options : [];
    const options = (input.config?.options ?? []).map((option) => {
      if (option.id === undefined) return { id: newOptionId(), name: option.name };
      if (!previousOptions.some((entry) => entry.id === option.id)) {
        issues.push({ key: input.key, message: `Unknown option id "${option.id}"; leave the id out to add an option` });
      }
      return { id: option.id, name: option.name };
    });
    return { ...base, type: "select", config: { options } };
  }
  if (input.type === "number") {
    const previousConfig = previous?.type === "number" ? previous.config : { format: "plain" as const, currency: null };
    return { ...base, type: "number", config: { ...previousConfig, ...input.config } };
  }
  return { ...base, type: input.type, config: {} };
}

/**
 * Applies a full property list to a database's current schema. The list must name every existing
 * property: leaving one out is refused, because archiving is explicit. A property keeps its type.
 * New properties, renames, reordering, option edits and archiving are allowed. Options without an
 * `id` get a new one.
 */
export function applyDatabaseSchemaUpdate(
  current: readonly DatabaseProperty[],
  input: readonly DatabasePropertyInput[],
  options: { now: string; newOptionId: () => string },
): DatabaseCheckResult<DatabaseProperty[]> {
  const issues: DatabaseSchemaIssue[] = [];
  const currentByKey = new Map(current.map((property) => [property.key, property]));
  const inputKeys = new Set(input.map((property) => property.key));
  for (const property of current) {
    if (!inputKeys.has(property.key)) {
      issues.push({ key: property.key, message: "The list leaves this property out; archive it instead" });
    }
  }
  const next = input.map((property) => {
    const previous = currentByKey.get(property.key);
    if (previous && previous.type !== property.type) {
      issues.push({ key: property.key, message: `A property keeps its type (${previous.type})` });
    }
    return storedFromInput(property, previous, options.now, options.newOptionId, issues);
  });
  issues.push(...checkDatabasePropertyList(next));
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: next };
}

/**
 * The schema of a new database. With no list, the database gets only the title property. A list
 * without a title property gets one first.
 */
export function buildInitialDatabaseProperties(
  input: readonly DatabasePropertyInput[] | undefined,
  options: { now: string; newOptionId: () => string },
): DatabaseCheckResult<DatabaseProperty[]> {
  if (!input || input.length === 0) return { ok: true, value: defaultDatabaseProperties() };
  const withTitle = input.some((property) => property.key === DATABASE_TITLE_PROPERTY_KEY)
    ? input
    : [{ key: DATABASE_TITLE_PROPERTY_KEY, name: "Name", type: "title" as const }, ...input];
  return applyDatabaseSchemaUpdate([], withTitle, options);
}
