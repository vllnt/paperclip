import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import {
  createPersonalAgentSkillSchema,
  putPersonalAgentInstructionsSchema,
  updatePersonalAgentSchema,
  updatePersonalAgentSkillSchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";

interface UpdateOptions extends BaseClientOptions {
  name?: string;
  toolPolicyFile?: string;
}

interface InstructionsPutOptions extends BaseClientOptions {
  body?: string;
  bodyFile?: string;
  baseRevision?: string;
  changeSummary?: string;
}

interface SkillOptions extends BaseClientOptions {
  name?: string;
  description?: string;
  markdown?: string;
  markdownFile?: string;
  catalog?: string;
  enable?: boolean;
  disable?: boolean;
}

interface AuditOptions extends BaseClientOptions {
  limit?: string;
}

async function textInput(inline: string | undefined, file: string | undefined, label: string): Promise<string | undefined> {
  if (inline !== undefined && file !== undefined) throw new Error(`Pass either --${label} or --${label}-file, not both.`);
  return file !== undefined ? readFile(file, "utf8") : inline;
}

function parseInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer.`);
  return parsed;
}

function enabledFlag(opts: SkillOptions): boolean | undefined {
  if (opts.enable && opts.disable) throw new Error("Pass either --enable or --disable, not both.");
  if (opts.enable) return true;
  if (opts.disable) return false;
  return undefined;
}

async function run(opts: BaseClientOptions, call: (ctx: ResolvedClientContext) => Promise<unknown>): Promise<void> {
  try {
    const ctx = resolveCommandContext(opts);
    printOutput(await call(ctx), { json: ctx.json });
  } catch (err) {
    handleCommandError(err);
  }
}

/**
 * `paperclipai personal-agent …`: the signed-in user's personal agent
 * (instructions, skills, tool policy, audit log). Every command maps to one
 * `/api/personal-agent` route and prints its JSON with `--json`.
 *
 * @param program - The root CLI program.
 */
export function registerPersonalAgentCommands(program: Command): void {
  const group = program.command("personal-agent").description("Your personal agent: instructions, skills, tools and audit log");

  addCommonClientOptions(
    group
      .command("get")
      .description("Show your personal agent")
      .action((opts: BaseClientOptions) => run(opts, (ctx) => ctx.api.get("/api/personal-agent"))),
  );

  addCommonClientOptions(
    group
      .command("update")
      .description("Update your personal agent's name or tool policy")
      .option("--name <name>", "New name")
      .option("--tool-policy-file <path>", "JSON file with the full tool policy")
      .action((opts: UpdateOptions) =>
        run(opts, async (ctx) => {
          const toolPolicy: unknown = opts.toolPolicyFile ? JSON.parse(await readFile(opts.toolPolicyFile, "utf8")) : undefined;
          return ctx.api.patch("/api/personal-agent", updatePersonalAgentSchema.parse({ name: opts.name, toolPolicy }));
        }),
      ),
  );

  addCommonClientOptions(
    group
      .command("instructions:put")
      .description("Save new instructions as the next revision")
      .option("--body <markdown>", "Instructions markdown")
      .option("--body-file <path>", "Read the instructions from a file")
      .option("--base-revision <n>", "Fail with 409 if the current revision is not this one")
      .option("--change-summary <text>", "Short note stored with the revision")
      .action((opts: InstructionsPutOptions) =>
        run(opts, async (ctx) => {
          const body = await textInput(opts.body, opts.bodyFile, "body");
          if (body === undefined) throw new Error("Pass --body or --body-file.");
          return ctx.api.put(
            "/api/personal-agent/instructions",
            putPersonalAgentInstructionsSchema.parse({
              body,
              baseRevision: parseInteger(opts.baseRevision, "--base-revision"),
              changeSummary: opts.changeSummary,
            }),
          );
        }),
      ),
  );

  addCommonClientOptions(
    group
      .command("instructions:revisions")
      .description("List instruction revisions, newest first")
      .action((opts: BaseClientOptions) => run(opts, (ctx) => ctx.api.get("/api/personal-agent/instructions/revisions"))),
  );

  addCommonClientOptions(
    group
      .command("instructions:revision")
      .description("Show one instruction revision")
      .argument("<revision>", "Revision number")
      .action((revision: string, opts: BaseClientOptions) =>
        run(opts, (ctx) => ctx.api.get(apiPath`/api/personal-agent/instructions/revisions/${revision}`)),
      ),
  );

  addCommonClientOptions(
    group
      .command("skills:list")
      .description("List your personal agent's skills")
      .action((opts: BaseClientOptions) => run(opts, (ctx) => ctx.api.get("/api/personal-agent/skills"))),
  );

  addCommonClientOptions(
    group
      .command("skills:get")
      .description("Show one skill")
      .argument("<skillId>", "Skill ID")
      .action((skillId: string, opts: BaseClientOptions) =>
        run(opts, (ctx) => ctx.api.get(apiPath`/api/personal-agent/skills/${skillId}`)),
      ),
  );

  addCommonClientOptions(
    group
      .command("skills:add")
      .description("Add a custom skill, or copy a markdown-only skill from the app catalog with --catalog")
      .option("--catalog <ref>", "Catalog skill id or key (see `paperclipai skills catalog`)")
      .option("--name <name>", "Skill name")
      .option("--description <text>", "Skill description")
      .option("--markdown <markdown>", "Skill markdown")
      .option("--markdown-file <path>", "Read the skill markdown from a file")
      .option("--disable", "Add it disabled")
      .action((opts: SkillOptions) =>
        run(opts, async (ctx) => {
          const enabled = opts.disable ? false : undefined;
          if (opts.catalog) {
            return ctx.api.post(
              "/api/personal-agent/skills",
              createPersonalAgentSkillSchema.parse({ source: "catalog", catalogRef: opts.catalog, enabled }),
            );
          }
          const markdown = await textInput(opts.markdown, opts.markdownFile, "markdown");
          return ctx.api.post(
            "/api/personal-agent/skills",
            createPersonalAgentSkillSchema.parse({ source: "custom", name: opts.name, description: opts.description, markdown, enabled }),
          );
        }),
      ),
  );

  addCommonClientOptions(
    group
      .command("skills:update")
      .description("Edit a skill")
      .argument("<skillId>", "Skill ID")
      .option("--name <name>", "New name")
      .option("--description <text>", "New description")
      .option("--markdown <markdown>", "New markdown")
      .option("--markdown-file <path>", "Read the new markdown from a file")
      .option("--enable", "Enable the skill")
      .option("--disable", "Disable the skill")
      .action((skillId: string, opts: SkillOptions) =>
        run(opts, async (ctx) => {
          const markdown = await textInput(opts.markdown, opts.markdownFile, "markdown");
          return ctx.api.patch(
            apiPath`/api/personal-agent/skills/${skillId}`,
            updatePersonalAgentSkillSchema.parse({
              name: opts.name,
              description: opts.description,
              markdown,
              enabled: enabledFlag(opts),
            }),
          );
        }),
      ),
  );

  addCommonClientOptions(
    group
      .command("skills:remove")
      .description("Remove a skill")
      .argument("<skillId>", "Skill ID")
      .action((skillId: string, opts: BaseClientOptions) =>
        run(opts, async (ctx) => {
          await ctx.api.delete(apiPath`/api/personal-agent/skills/${skillId}`);
          return { ok: true, skillId };
        }),
      ),
  );

  addCommonClientOptions(
    group
      .command("tools")
      .description("List the tools a tool policy can allow, with their risk")
      .action((opts: BaseClientOptions) => run(opts, (ctx) => ctx.api.get("/api/personal-agent/tools"))),
  );

  addCommonClientOptions(
    group
      .command("audit-log")
      .description("Read your audit log, newest first")
      .option("--limit <n>", "Rows to return (1-200)", "50")
      .action((opts: AuditOptions) =>
        run(opts, (ctx) =>
          ctx.api.get(`/api/personal-agent/audit-log?limit=${encodeURIComponent(String(parseInteger(opts.limit, "--limit") ?? 50))}`),
        ),
      ),
  );
}
