/** Infrastructure defaults do not grant access to another company's secrets. */
export function resolveCompanyEnvironmentDefault(
  settings: {
    defaultEnvironmentId?: string | null;
    general?: { companyEnvironmentDefaults?: Record<string, string> };
  } | null | undefined,
  companyId: string | null | undefined,
): string | null {
  const defaults = settings?.general?.companyEnvironmentDefaults;
  if (companyId && defaults && Object.hasOwn(defaults, companyId)) {
    return defaults[companyId] ?? null;
  }
  return settings?.defaultEnvironmentId ?? null;
}
