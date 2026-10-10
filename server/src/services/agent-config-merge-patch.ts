import {
  describeAgentConfigMergePatchViolation,
  findAgentConfigMergePatchViolation,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { readObject } from "../lib/objects.js";

/**
 * Applies a JSON merge patch (RFC 7396) to a stored agent config object.
 *
 * - Objects merge recursively, so only the keys named in the patch change.
 * - `null` removes a key.
 * - Arrays and scalars replace the stored value.
 * - Paths for which `isAtomic` returns true are replaced whole instead of merged.
 *   `adapterConfig.env.<KEY>` entries are atomic: an env binding such as
 *   `{ type: "secret_ref", secretId }` must never be mixed with a patch such as
 *   `{ type: "plain", value }`. `adapterConfig.workspaceStrategy` is atomic so a
 *   patch never keeps an admin-set host command under a changed strategy.
 * - A patch is refused with a 400 that names the path when it has a `__proto__`,
 *   `constructor` or `prototype` key anywhere (arrays included), is nested deeper
 *   than `AGENT_CONFIG_MERGE_PATCH_MAX_DEPTH`, or holds more than
 *   `AGENT_CONFIG_MERGE_PATCH_MAX_VALUES` values. The check runs before the merge
 *   and walks without recursion, so no input can overflow the stack.
 *
 * Keys the patch doesn't name keep their stored value, including secret
 * bindings, so a caller never has to resend a secret to change another field.
 *
 * @param target - the stored config (unredacted).
 * @param patch - the merge patch sent by the caller.
 * @param isAtomic - returns true for key paths that replace instead of merge.
 * @param root - the name of the config in error messages, for example `adapterConfig`.
 * @returns a new object; neither input is mutated.
 * @throws a 400 when the patch has a forbidden key or is too deep or too large.
 * @example
 * applyConfigMergePatch({ heartbeat: { enabled: true, maxDailyRuns: 10 } }, { heartbeat: { maxDailyRuns: 64 } })
 * // => { heartbeat: { enabled: true, maxDailyRuns: 64 } }
 */
export function applyConfigMergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
  isAtomic: (path: readonly string[]) => boolean = () => false,
  root = "config",
): Record<string, unknown> {
  const violation = findAgentConfigMergePatchViolation(patch);
  if (violation) throw badRequest(describeAgentConfigMergePatchViolation(violation, root), { path: violation.path });
  return mergeObjects(target, patch, isAtomic, []);
}

/** Recursion is safe here: the caller has bounded the depth of `patch`. */
function mergeObjects(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
  isAtomic: (path: readonly string[]) => boolean,
  path: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const childPath = [...path, key];
    if (value === null) {
      delete result[key];
      continue;
    }
    const patchObject = readObject(value);
    const targetObject = readObject(result[key]);
    result[key] =
      patchObject && !isAtomic(childPath)
        ? mergeObjects(targetObject ?? {}, patchObject, isAtomic, childPath)
        : value;
  }
  return result;
}

/** `adapterConfig.env.<KEY>` bindings and `adapterConfig.workspaceStrategy` are replaced whole. */
export function isAtomicAdapterConfigPath(path: readonly string[]): boolean {
  return (path.length === 2 && path[0] === "env") || (path.length === 1 && path[0] === "workspaceStrategy");
}
