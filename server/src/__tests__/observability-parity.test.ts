import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildOpenApiSpec } from "../routes/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const PREFIX = "/api/companies/{companyId}/observability/";

const CLI_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "cli/src/commands/client/observability.ts"), "utf8");
const UI_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "ui/src/api/observability.ts"), "utf8");

const specSchema = z.object({ paths: z.record(z.string(), z.unknown()) });
const segments = Object.keys(specSchema.parse(buildOpenApiSpec()).paths)
  .filter((route) => route.startsWith(PREFIX))
  .map((route) => route.slice(PREFIX.length))
  .sort();

/**
 * Every observability route must work from the API, the CLI and the UI client, so an agent can do
 * what a person does. A new route under the prefix fails this test until it has a CLI command
 * (`paperclipai observability <segment>`) and a method in the UI client.
 */
describe("observability surface parity", () => {
  it("finds the routes this slice ships, so the checks below are not empty", () => {
    expect(segments).toEqual(expect.arrayContaining(["health", "usage", "failures"]));
  });

  it.each(segments)("has a CLI command for %s", (segment) => {
    expect(CLI_SOURCE).toContain(`.command("${segment}")`);
  });

  it.each(segments)("has a UI client method for %s", (segment) => {
    expect(UI_SOURCE).toMatch(new RegExp(`/observability/${segment}(?![\\w-])`));
  });
});
