import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { ApiRequestError } from "../../client/http.js";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  normalizeApiBase,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";

interface BrowserOptions extends BaseClientOptions {
  payloadJson?: string;
  yes?: boolean;
}

interface FrameOptions extends BaseClientOptions {
  out: string;
}

interface BrowserCommandSpec {
  name: string;
  description: string;
  method: "get" | "post" | "put" | "patch" | "delete";
  route: (companyId: string | undefined, profileId: string) => string;
  profile?: boolean;
  payload?: "required" | "optional";
  body?: unknown;
  confirm?: boolean;
}

const browserRoute = (companyId: string | undefined, rest: string): string =>
  `${apiPath`/api/companies/${companyId}/browser`}${rest}`;

const profileRoute = (companyId: string | undefined, profileId: string, rest = ""): string =>
  `${apiPath`/api/companies/${companyId}/browser/profiles/${profileId}`}${rest}`;

const BROWSER_COMMANDS: BrowserCommandSpec[] = [
  {
    name: "overview",
    description: "Show whether the shared browser is on, and its profiles (board)",
    method: "get",
    route: (companyId) => browserRoute(companyId, "/overview"),
  },
  {
    name: "enable",
    description: "Turn the company shared browser on (board)",
    method: "put",
    route: (companyId) => browserRoute(companyId, "/settings"),
    body: { enabled: true },
  },
  {
    name: "disable",
    description: "Turn the company shared browser off (board)",
    method: "put",
    route: (companyId) => browserRoute(companyId, "/settings"),
    body: { enabled: false },
  },
  {
    name: "agent-profiles",
    description: "List the profiles this agent may use (agent credential)",
    method: "get",
    route: (companyId) => browserRoute(companyId, "/agent-profiles"),
  },
  {
    name: "action",
    description: "Run one typed browser action on a profile: navigate, snapshot, click, fill, press, scroll, wait or close (agent credential)",
    method: "post",
    route: (companyId, profileId) => profileRoute(companyId, profileId, "/actions"),
    profile: true,
    payload: "required",
  },
];

const PROFILE_COMMANDS: BrowserCommandSpec[] = [
  {
    name: "create",
    description: "Create a profile from a JSON body with name and allowedDomains",
    method: "post",
    route: (companyId) => browserRoute(companyId, "/profiles"),
    payload: "required",
  },
  {
    name: "update",
    description: "Change a profile's name, allowedDomains or allowedAgentIds; each list you send replaces the old one",
    method: "patch",
    route: (companyId, profileId) => profileRoute(companyId, profileId),
    profile: true,
    payload: "required",
  },
  {
    name: "suspend",
    description: "Stop agents and sign-in from using a profile",
    method: "post",
    route: (companyId, profileId) => profileRoute(companyId, profileId, "/suspend"),
    profile: true,
  },
  {
    name: "resume",
    description: "Let a suspended profile be used again",
    method: "post",
    route: (companyId, profileId) => profileRoute(companyId, profileId, "/resume"),
    profile: true,
  },
  {
    name: "delete",
    description: "Delete a profile and its saved session",
    method: "delete",
    route: (companyId, profileId) => profileRoute(companyId, profileId),
    profile: true,
    confirm: true,
  },
];

const SIGNIN_COMMANDS: BrowserCommandSpec[] = [
  {
    name: "start",
    description: "Start a sign-in session; an optional JSON body may carry startUrl",
    method: "post",
    route: (companyId, profileId) => profileRoute(companyId, profileId, "/signin"),
    profile: true,
    payload: "optional",
  },
  {
    name: "state",
    description: "Show the sign-in page address, title and size",
    method: "get",
    route: (companyId, profileId) => profileRoute(companyId, profileId, "/signin/state"),
    profile: true,
  },
  {
    name: "input",
    description: "Send one click, key press, text, scroll or navigation to the sign-in page",
    method: "post",
    route: (companyId, profileId) => profileRoute(companyId, profileId, "/signin/input"),
    profile: true,
    payload: "required",
  },
  {
    name: "end",
    description: "End the sign-in session and save the session",
    method: "post",
    route: (companyId, profileId) => profileRoute(companyId, profileId, "/signin/end"),
    profile: true,
  },
];

/**
 * Registers `paperclipai browser ...`. Each command calls exactly one route of the
 * shared browser API, so permissions are the API's: board commands need a board
 * credential, `agent-profiles` and `action` need an agent credential.
 * @param program - The root command to attach the `browser` group to.
 */
export function registerBrowserCommands(program: Command): void {
  const browser = program
    .command("browser")
    .description("Shared browser: profiles, board sign-in and agent actions");
  for (const spec of BROWSER_COMMANDS) addBrowserCommand(browser, spec);

  const profile = browser.command("profile").description("Browser profile operations (board)");
  for (const spec of PROFILE_COMMANDS) addBrowserCommand(profile, spec);

  const signin = browser.command("signin").description("Board sign-in session operations");
  for (const spec of SIGNIN_COMMANDS) addBrowserCommand(signin, spec);
  addFrameCommand(signin);
}

function addBrowserCommand(parent: Command, spec: BrowserCommandSpec): void {
  const command = parent.command(spec.name).description(spec.description);
  if (spec.profile) command.argument("<profileId>", "Browser profile ID");
  if (spec.payload === "required") command.requiredOption("--payload-json <json>", "JSON request body");
  if (spec.payload === "optional") command.option("--payload-json <json>", "JSON request body");
  if (spec.confirm) command.option("--yes", "Confirm deletion");
  addCommonClientOptions(command, { includeCompany: true });

  const execute = async (profileId: string, opts: BrowserOptions): Promise<void> => {
    try {
      if (spec.confirm && !opts.yes) {
        throw new Error("Deleting a profile erases its saved session and requires --yes.");
      }
      const ctx = resolveCommandContext(opts, { requireCompany: true });
      const body: unknown = opts.payloadJson === undefined ? spec.body : JSON.parse(opts.payloadJson);
      const result = await send(ctx, spec.method, spec.route(ctx.companyId, profileId), body);
      printOutput(result, { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  };
  command.action(spec.profile ? execute : (opts: BrowserOptions) => execute("", opts));
}

function send(
  ctx: ResolvedClientContext,
  method: BrowserCommandSpec["method"],
  route: string,
  body: unknown,
): Promise<unknown> {
  switch (method) {
    case "get":
      return ctx.api.get(route);
    case "delete":
      return ctx.api.delete(route);
    case "post":
      return ctx.api.post(route, body);
    case "put":
      return ctx.api.put(route, body);
    case "patch":
      return ctx.api.patch(route, body);
  }
}

function addFrameCommand(parent: Command): void {
  const command = parent
    .command("frame")
    .description("Save the current sign-in page as a JPEG image")
    .argument("<profileId>", "Browser profile ID")
    .requiredOption("--out <path>", "File to write the JPEG image to");
  addCommonClientOptions(command, { includeCompany: true });
  command.action(async (profileId: string, opts: FrameOptions) => {
    try {
      const ctx = resolveCommandContext(opts, { requireCompany: true });
      const bytes = await downloadFrame(ctx, profileRoute(ctx.companyId, profileId, "/signin/frame"));
      await writeFile(opts.out, bytes, { mode: 0o600 });
      printOutput({ ok: true, out: opts.out, bytes: bytes.length }, { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  });
}

async function downloadFrame(ctx: ResolvedClientContext, route: string): Promise<Buffer> {
  const response = await fetch(`${normalizeApiBase(ctx.api.apiBase)}${route}`, {
    headers: ctx.api.apiKey ? { authorization: `Bearer ${ctx.api.apiKey}` } : undefined,
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, await errorMessage(response));
  }
  return Buffer.from(await response.arrayBuffer());
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await response.text());
    if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    return `Request failed with status ${response.status}`;
  }
  return `Request failed with status ${response.status}`;
}
