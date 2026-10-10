import type { CommandActionUsage } from "@paperclipai/shared/command-action-rank";

const STORAGE_PREFIX = "paperclip.commandActionUsage.v1:";

/**
 * Launcher frecency is stored per browser, per company and per user. It
 * holds action ids and use times only, never entity names.
 */
export function getCommandActionUsageStorageKey(companyId: string, userId: string | null | undefined): string {
  return `${STORAGE_PREFIX}${companyId}:${userId ?? "__local_board__"}`;
}

function isUsage(value: unknown): value is CommandActionUsage {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<CommandActionUsage>;
  return typeof entry.count === "number"
    && Number.isFinite(entry.count)
    && typeof entry.lastUsedAt === "number"
    && Number.isFinite(entry.lastUsedAt);
}

export function readCommandActionUsage(storageKey: string): Record<string, CommandActionUsage> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, CommandActionUsage] => isUsage(entry[1])));
  } catch {
    return {};
  }
}

export function writeCommandActionUsage(storageKey: string, usage: Record<string, CommandActionUsage>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(usage));
  } catch {
    // Storage can be full or disabled; ranking then simply has no history.
  }
}
