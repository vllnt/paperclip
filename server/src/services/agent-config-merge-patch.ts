import { unprocessable } from "../errors.js";
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
 * - A `__proto__` key is rejected (422).
 *
 * Keys the patch doesn't name keep their stored value, including secret
 * bindings, so a caller never has to resend a secret to change another field.
 *
 * @param target - the stored config (unredacted).
 * @param patch - the merge patch sent by the caller.
 * @param isAtomic - returns true for key paths that replace instead of merge.
 * @returns a new object; neither input is mutated.
 * @example
 * applyConfigMergePatch({ heartbeat: { enabled: true, maxDailyRuns: 10 } }, { heartbeat: { maxDailyRuns: 64 } })
 * // => { heartbeat: { enabled: true, maxDailyRuns: 64 } }
 */
export function applyConfigMergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
  isAtomic: (path: readonly string[]) => boolean = () => false,
  path: readonly string[] = [],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const childPath = [...path, key];
    if (key === "__proto__") throw unprocessable(`Config key "__proto__" is not allowed (${childPath.join(".")})`);
    if (value === null) {
      delete result[key];
      continue;
    }
    const patchObject = readObject(value);
    const targetObject = readObject(result[key]);
    result[key] =
      patchObject && !isAtomic(childPath)
        ? applyConfigMergePatch(targetObject ?? {}, patchObject, isAtomic, childPath)
        : value;
  }
  return result;
}

/** `adapterConfig.env.<KEY>` bindings and `adapterConfig.workspaceStrategy` are replaced whole. */
export function isAtomicAdapterConfigPath(path: readonly string[]): boolean {
  return (path.length === 2 && path[0] === "env") || (path.length === 1 && path[0] === "workspaceStrategy");
}
