import { runProfileSchema, type RunProfile } from "@paperclipai/shared";

/** The run profile flags shared by `issue create` and `issue update`. */
export interface RunProfileOptions {
  runProfile?: string;
  adapterType?: string;
  model?: string;
  effort?: string;
  clearRunProfile?: boolean;
}

export type IssueOverrides = Record<string, unknown>;

/** True when any run profile flag was given. */
export function hasRunProfileOptions(opts: RunProfileOptions): boolean {
  return Boolean(opts.runProfile || opts.adapterType || opts.model || opts.effort || opts.clearRunProfile);
}

/**
 * Builds the `assigneeAdapterOverrides` value for the run profile flags. The
 * profile replaces only the `runProfile` key: the issue's other overrides
 * stay. The server decides who may set it and re-checks the harness and model.
 *
 * @param opts - The parsed flags.
 * @param existing - The issue's current overrides, or null for a new issue.
 * @returns The overrides to send, `null` to clear them all, or undefined when no flag was given.
 */
export function buildRunProfileOverrides(
  opts: RunProfileOptions,
  existing: IssueOverrides | null | undefined,
): IssueOverrides | null | undefined {
  if (!hasRunProfileOptions(opts)) return undefined;
  const explicit = Boolean(opts.adapterType || opts.model || opts.effort);
  if (opts.clearRunProfile && (opts.runProfile || explicit)) {
    throw new Error("--clear-run-profile cannot be combined with --run-profile, --adapter-type, --model or --effort");
  }
  const { runProfile: _previous, ...others } = existing ?? {};
  if (opts.clearRunProfile) return Object.keys(others).length > 0 ? others : null;
  if (opts.runProfile && explicit) {
    throw new Error("Use either --run-profile <tier> or --adapter-type/--model/--effort, not both");
  }
  const candidate = opts.runProfile
    ? { tier: opts.runProfile }
    : {
        ...(opts.adapterType ? { adapterType: opts.adapterType } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
      };
  const parsed = runProfileSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const profile: RunProfile = parsed.data;
  return { ...others, runProfile: profile };
}
