/**
 * gh's argv grammar, shared by the server's classifier and the managed gh
 * launcher. The launcher has no access to this package at run time: it embeds
 * the source of {@link parseGhCommand} and {@link ghCommandMayWrite} as they
 * are (Function.prototype.toString). Both functions must therefore stay
 * self-contained: no references to anything outside their own body except
 * JavaScript built-ins, and no named inner functions.
 */

/** One `gh api` invocation as gh parses it. */
export interface GhApiRequest {
  /** `-X`/`--method`, uppercased; null when not given. */
  method: string | null;
  /** The endpoint argument as given (a path, `graphql` or a full URL). */
  path: string | null;
  /** `--hostname`, when given. */
  hostname: string | null;
  /** `-f`/`-F` fields; a typed (`-F`) value starting with `@` is read from a file or stdin. */
  fields: Array<{ name: string; value: string; typed: boolean }>;
  /** `--input`: the request body comes from a file or stdin. */
  input: boolean;
  /** A flag Paperclip does not know: it cannot tell what the command sends. */
  unknown: string | null;
}

export interface GhApiRoute {
  /** Normalized route without leading or duplicate slashes or `.` segments; null when it cannot be read. */
  route: string | null;
  /** Why the endpoint is refused, when it is. */
  problem?: string;
  /** `OWNER/REPO` of a `repos/` route, unless gh fills it from the checkout (`{owner}`, `:repo`…). */
  repository: string | null;
  /** The route names its repository with gh placeholders, which gh fills from the checkout. */
  placeholder: boolean;
}

/** A gh command line as gh reads it. */
export interface GhCommand {
  /** Why Paperclip cannot tell which command runs (an option before the command group, an empty argument); null when it can. */
  problem: string | null;
  /** argv with -R/--repo given before the command group moved after it, as gh reads it; empty with a problem. */
  args: string[];
  /** The command group (`pr`, `api`…); null when there is none. */
  group: string | null;
  /** Index of the verb in `args`; -1 when an option before it hides it (gh skips options it does not need when finding the verb). */
  verbIndex: number;
  /** Outside gh api: a cluster of short options with R inside it (`-dRowner/repo`), which gh reads as -R. */
  hidesRepo: boolean;
  /** The group only reads, or its verb is one of the group's read verbs. */
  reads: boolean;
  /** The command prints a GitHub credential (gh auth token, git-credential, status --show-token in any spelling, gh config reading a token). */
  printsToken: boolean;
  /** gh api: the request and its endpoint. */
  api: { request: GhApiRequest; endpoint: GhApiRoute } | null;
}

/** Parses gh argv (without the executable). Self-contained: the managed launcher embeds this source. */
export function parseGhCommand(original: readonly string[]): GhCommand {
  const EMPTY_ARGUMENT = "Remove the empty argument: gh skips it when it finds the command, so Paperclip cannot tell which command runs.";
  // -R/--repo may come before the command group; gh reads it after.
  const leading: string[] = [];
  let start = 0;
  let problem: string | null = null;
  while (start < original.length && (original[start]!.startsWith("-") || original[start] === "")) {
    const arg = original[start]!;
    if (arg === "-R" || arg === "--repo") { leading.push(arg, original[start + 1] ?? ""); start += 2; continue; }
    if (/^(--repo=|-R.)/.test(arg)) { leading.push(arg); start += 1; continue; }
    if (original.length === 1 && ["--version", "--help", "-h"].includes(arg)) {
      return { problem: null, args: [arg], group: arg, verbIndex: 1, hidesRepo: false, reads: true, printsToken: false, api: null };
    }
    problem = arg === "" ? EMPTY_ARGUMENT : "Put the gh command first (gh pr …, gh api …): Paperclip cannot tell which command runs after a leading option.";
    break;
  }
  if (problem === null && start >= original.length) {
    if (!leading.length) return { problem: null, args: [], group: null, verbIndex: -1, hidesRepo: false, reads: true, printsToken: false, api: null };
    problem = "Name a gh command after -R OWNER/REPO.";
  }
  const args = problem === null ? [original[start]!, ...leading, ...original.slice(start + 1)] : [];
  // The verb comes right after the group, or after an -R/--repo given first.
  let verbIndex = 1;
  while (verbIndex < args.length) {
    const arg = args[verbIndex]!;
    if (arg === "-R" || arg === "--repo") { verbIndex += 2; continue; }
    if (/^(--repo=|-R.)/.test(arg)) { verbIndex += 1; continue; }
    if (arg.startsWith("-") || arg === "") verbIndex = -1;
    break;
  }
  if (verbIndex > args.length) verbIndex = args.length;
  if (problem === null && args.slice(1, verbIndex < 0 ? args.length : verbIndex + 1).includes("")) problem = EMPTY_ARGUMENT;
  if (problem !== null) return { problem, args: [], group: null, verbIndex: -1, hidesRepo: false, reads: false, printsToken: false, api: null };
  const group = args[0]!;
  const hidesRepo = group !== "api" && args.some(arg => /^-[A-Za-z]{2,}/.test(arg) && !arg.startsWith("--") && !arg.startsWith("-R") && arg.slice(1).includes("R"));
  // Groups that never write, and each group's read verbs (any other verb writes).
  const readGroups = ["auth", "browse", "completion", "config", "alias", "help", "status", "search", "version", "extension", "org", "attestation", "ruleset"];
  const readVerbs = new Map<string, string[]>([
    ["pr", ["list", "view", "status", "diff", "checks", "checkout"]],
    ["issue", ["list", "view", "status"]],
    ["release", ["list", "view", "download", "verify", "verify-asset"]],
    ["workflow", ["list", "view"]],
    ["run", ["list", "view", "watch", "download"]],
    ["repo", ["view", "list", "clone", "set-default", "gitignore", "license"]],
    ["label", ["list"]],
    ["project", ["list", "view", "item-list", "field-list"]],
    ["cache", ["list"]],
    ["secret", ["list"]],
    ["variable", ["list", "get"]],
    ["gist", ["list", "view", "clone"]],
  ]);
  const verbs = readVerbs.get(group);
  const verb = verbIndex >= 0 ? args[verbIndex] : undefined;
  const reads = readGroups.includes(group) || (verbIndex >= 0 && verbs !== undefined && (verb === undefined || verbs.includes(verb)));
  const printsToken = group === "auth"
    ? args.includes("token") || args.includes("git-credential")
      || args.some(arg => (/^--show-token(=|$)/.test(arg) && arg !== "--show-token=false") || (/^-[A-Za-z]*t/.test(arg) && !arg.startsWith("--")))
    : group === "config" && args.some(arg => /token/i.test(arg));
  if (group !== "api") return { problem: null, args, group, verbIndex, hidesRepo, reads, printsToken, api: null };

  // gh api: flags that take a value (short and long), and its boolean flags.
  const shortValue = ["X", "f", "F", "H", "q", "t", "p"], shortBoolean = ["i", "h"];
  const longValue = ["method", "field", "raw-field", "header", "jq", "template", "preview", "hostname", "cache", "input"];
  const longBoolean = ["include", "paginate", "silent", "slurp", "verbose", "help", "allow-escape-sequences"];
  const request: GhApiRequest = { method: null, path: null, hostname: null, fields: [], input: false, unknown: null };
  const values: Array<[string, string]> = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") { request.path ??= args[index + 1] ?? null; break; }
    if (arg.startsWith("--")) {
      const [name, ...rest] = arg.slice(2).split("=");
      if (longValue.includes(name!)) { values.push([name!, rest.length ? rest.join("=") : (args[++index] ?? "")]); continue; }
      if (!longBoolean.includes(name!)) request.unknown ??= arg;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      // A cluster of short flags: booleans, then at most one flag whose value is the rest (`-XPOST`, `-X=POST`, `-iXPOST`) or the next argument.
      for (let at = 1; at < arg.length; at += 1) {
        const flag = arg[at]!;
        if (shortBoolean.includes(flag)) continue;
        if (shortValue.includes(flag)) {
          values.push([flag, at + 1 < arg.length ? arg.slice(at + 1).replace(/^=/, "") : (args[++index] ?? "")]);
          break;
        }
        request.unknown ??= arg;
        break;
      }
      continue;
    }
    // gh may skip an empty argument when it finds the endpoint; Paperclip cannot tell which one it uses.
    if (arg === "") { request.unknown ??= '""'; continue; }
    request.path ??= arg;
  }
  for (const [flag, value] of values) {
    if (flag === "X" || flag === "method") request.method = value.toUpperCase();
    else if (flag === "f" || flag === "raw-field" || flag === "F" || flag === "field") {
      const equals = value.indexOf("=");
      // gh rejects a field without `=`; record it so it is never ignored.
      request.fields.push(equals > 0
        ? { name: value.slice(0, equals), value: value.slice(equals + 1), typed: flag === "F" || flag === "field" }
        : { name: value, value: "", typed: flag === "F" || flag === "field" });
    } else if (flag === "hostname") request.hostname = value;
    else if (flag === "input") request.input = true;
  }

  // The endpoint, the way GitHub routes it. A full URL must be https://api.github.com.
  let endpoint: GhApiRoute;
  let path = request.path ?? "";
  let hostProblem: string | null = null;
  if (path.includes("://")) {
    let url: URL | null = null;
    try { url = new URL(path); } catch { url = null; }
    if (!url || url.protocol !== "https:" || url.hostname.toLowerCase() !== "api.github.com" || url.port || url.username || url.password) {
      hostProblem = `gh api would send this request to ${(url?.host || path).slice(0, 100)}; Paperclip hands GitHub credentials only to github.com (api.github.com).`;
    } else path = url.pathname;
  }
  let decoded: string | null = null;
  try { decoded = decodeURIComponent(path.split(/[?#]/)[0]!); } catch { decoded = null; }
  const placeholder = /^(\{(owner|repo|branch)\}|:(owner|repo|branch))$/;
  if (hostProblem !== null) endpoint = { route: null, problem: hostProblem, repository: null, placeholder: false };
  else if (decoded === null) endpoint = { route: null, problem: "Paperclip cannot read this endpoint's encoding.", repository: null, placeholder: false };
  else {
    const segments = decoded.split("/").filter(segment => segment !== "" && segment !== ".");
    // GitHub routes GraphQL case-insensitively (REST paths are case-sensitive).
    const route = segments.length === 1 && segments[0]!.toLowerCase() === "graphql" ? "graphql" : segments.join("/");
    const owner = segments[0] === "repos" ? segments[1] : undefined, name = segments[0] === "repos" ? segments[2] : undefined;
    const ownerPlaceholder = owner !== undefined && placeholder.test(owner), namePlaceholder = name !== undefined && placeholder.test(name);
    if (segments.includes("..")) endpoint = { route: null, problem: "Paperclip cannot check an endpoint path that contains '..'.", repository: null, placeholder: false };
    else if (/^repositories(\/|$)/i.test(route)) endpoint = { route, problem: "Name the repository as repos/OWNER/REPO; Paperclip cannot check a repository named by ID.", repository: null, placeholder: false };
    // gh fills each placeholder from the checkout: one filled and one literal names a repository Paperclip cannot see.
    else if (owner !== undefined && name !== undefined && ownerPlaceholder !== namePlaceholder) {
      endpoint = { route, problem: "Use the {owner} and {repo} placeholders together or not at all; Paperclip cannot tell which repository a half-filled path names.", repository: null, placeholder: true };
    } else {
      const filled = ownerPlaceholder || namePlaceholder;
      endpoint = { route, repository: owner && name && !filled ? `${owner}/${name}` : null, placeholder: filled };
    }
  }
  return { problem: null, args, group, verbIndex, hidesRepo, reads, printsToken: false, api: { request, endpoint } };
}

/**
 * Whether a parsed gh command may write to GitHub or print a credential: true
 * for anything the launcher must not run without a managed credential. The
 * classifier answers a plain, unrefused read for every command this is false
 * for. Self-contained: the managed launcher embeds this source.
 */
export function ghCommandMayWrite(command: GhCommand): boolean {
  if (command.problem !== null || command.printsToken) return true;
  if (command.group === null || command.group.startsWith("-")) return false;
  if (command.hidesRepo) return true;
  if (command.reads) return false;
  if (command.api === null) return true;
  const request = command.api.request, endpoint = command.api.endpoint;
  // gh api sends GET unless a method, a field or a body is given. An explicit GET or HEAD reads, its fields
  // becoming the query string (gh api -X GET search/issues -f q=…); any other method, or no method with fields, may write.
  if (request.unknown !== null || request.input) return true;
  if (request.method !== null ? request.method !== "GET" && request.method !== "HEAD" : request.fields.length > 0) return true;
  if (request.hostname !== null && request.hostname.trim().toLowerCase() !== "github.com") return true;
  return endpoint.route === null || endpoint.problem !== undefined || endpoint.route === "graphql";
}
