import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  agents,
  browserProfileAgents,
  browserProfiles,
  companyBrowserSettings,
  type Db,
} from "@paperclipai/db";
import {
  BROWSER_SIGNIN_LEASE_MS,
  type BrowserAgentAction,
  type BrowserAgentActionResult,
  type BrowserProfile,
  type BrowserProfilesOverview,
  type BrowserSignInInput,
  type BrowserSignInState,
  type CompanyBrowserSettings,
  type CreateBrowserProfile,
  type UpdateBrowserProfile,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { logActivity } from "./activity-log.js";
import {
  BrowserActionError,
  createPlaywrightExecutor,
  type BrowserExecutor,
  type BrowserRuntime,
  type BrowserTab,
} from "./browser-executor.js";
import {
  auditUrl,
  isAgentNavigationAllowed,
  isSignInNavigationAllowed,
  redactSnapshot,
} from "./browser-profile-policy.js";
import {
  generateProfileKey,
  openProfileState,
  profileStateAad,
  sealProfileState,
} from "./browser-profile-seal.js";
import { secretService } from "./secrets.js";

const SIGN_IN_TAB = "signin";
const KEY_NAME_PREFIX = "browser-profile-key:";
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_LIVE = 3;
const SAVE_INTERVAL_MS = 2 * 60 * 1000;
const VIEWPORT = { width: 1280, height: 800 } as const;

type ProfileRow = typeof browserProfiles.$inferSelect;

export interface BrowserAgentActor {
  agentId: string;
  runId: string | null;
}

interface LiveProfile {
  runtime: BrowserRuntime;
  agentTabs: Set<string>;
  signIn: { userId: string; expiresAt: number } | null;
  idleTimer: NodeJS.Timeout | null;
  saveTimer: NodeJS.Timeout | null;
  chain: Promise<unknown>;
}

export interface BrowserProfileServiceOptions {
  executor?: BrowserExecutor;
  idleMs?: number;
  maxLiveProfiles?: number;
  now?: () => number;
}

/**
 * Company-scoped persistent browser profiles.
 *
 * Every read and write names the company, so a profile id from another company
 * is indistinguishable from a missing one. The saved session is encrypted with a
 * per-profile key kept as a company secret and is never returned by any method.
 * @param db - Database handle.
 * @param options - Test seams: executor, idle timeout, live-profile cap, clock.
 */
export function browserProfileService(db: Db, options: BrowserProfileServiceOptions = {}) {
  const executor = options.executor ?? createPlaywrightExecutor();
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const maxLive = options.maxLiveProfiles ?? DEFAULT_MAX_LIVE;
  const now = options.now ?? Date.now;
  const secrets = secretService(db);
  const live = new Map<string, LiveProfile>();
  const opening = new Map<string, Promise<LiveProfile>>();

  async function isEnabled(companyId: string): Promise<boolean> {
    const [row] = await db
      .select({ enabled: companyBrowserSettings.enabled })
      .from(companyBrowserSettings)
      .where(eq(companyBrowserSettings.companyId, companyId))
      .limit(1);
    return row?.enabled === true;
  }

  async function assertEnabled(companyId: string): Promise<void> {
    if (!(await isEnabled(companyId))) throw notFound("Not found");
  }

  async function getOwned(companyId: string, profileId: string): Promise<ProfileRow> {
    const [row] = await db
      .select()
      .from(browserProfiles)
      .where(and(eq(browserProfiles.id, profileId), eq(browserProfiles.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("Browser profile not found");
    return row;
  }

  async function agentIdsFor(companyId: string, profileIds: string[]): Promise<Map<string, string[]>> {
    const byProfile = new Map<string, string[]>();
    if (profileIds.length === 0) return byProfile;
    const rows = await db
      .select({ profileId: browserProfileAgents.profileId, agentId: browserProfileAgents.agentId })
      .from(browserProfileAgents)
      .where(and(eq(browserProfileAgents.companyId, companyId), inArray(browserProfileAgents.profileId, profileIds)));
    for (const row of rows) byProfile.set(row.profileId, [...(byProfile.get(row.profileId) ?? []), row.agentId]);
    return byProfile;
  }

  function toProfile(row: ProfileRow, allowedAgentIds: string[]): BrowserProfile {
    const entry = live.get(row.id);
    const lease = entry?.signIn && entry.signIn.expiresAt > now() ? entry.signIn : null;
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      status: row.status === "suspended" ? "suspended" : "active",
      allowedDomains: row.allowedDomains,
      allowedAgentIds,
      hasSavedSession: row.sealedState !== null,
      lastSavedAt: row.lastSealedAt?.toISOString() ?? null,
      signIn: {
        active: lease !== null,
        userId: lease?.userId ?? null,
        expiresAt: lease ? new Date(lease.expiresAt).toISOString() : null,
      },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function present(row: ProfileRow): Promise<BrowserProfile> {
    return toProfile(row, (await agentIdsFor(row.companyId, [row.id])).get(row.id) ?? []);
  }

  async function audit(
    companyId: string,
    actor: { type: "user" | "agent"; id: string; agentId?: string | null; runId?: string | null },
    action: string,
    profileId: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await logActivity(db, {
      companyId,
      actorType: actor.type,
      actorId: actor.id,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: `browser.${action}`,
      entityType: "browser_profile",
      entityId: profileId,
      details,
    });
  }

  async function readKey(profile: ProfileRow): Promise<string> {
    if (!profile.keySecretId) throw conflict("This profile has no encryption key; recreate it");
    return secrets.resolveSecretValue(profile.companyId, profile.keySecretId, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId: `browser-profile:${profile.id}`,
        actorType: "system",
        actorId: null,
      },
    });
  }

  function enqueue<T>(entry: LiveProfile, task: () => Promise<T>): Promise<T> {
    const run = entry.chain.then(task, task);
    entry.chain = run.catch(() => undefined);
    return run;
  }

  function armIdle(profileId: string, entry: LiveProfile): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void closeLive(profileId, true).catch((error) => {
        logger.warn({ profileId, errorName: error instanceof Error ? error.name : typeof error }, "idle browser close failed");
      });
    }, idleMs);
    entry.idleTimer.unref();
  }

  async function saveSession(profile: ProfileRow, entry: LiveProfile): Promise<void> {
    const [current] = await db
      .select({ generation: browserProfiles.stateGeneration })
      .from(browserProfiles)
      .where(and(eq(browserProfiles.id, profile.id), eq(browserProfiles.companyId, profile.companyId)))
      .limit(1);
    if (!current) return;
    const next = current.generation + 1;
    const sealed = sealProfileState(
      await readKey(profile),
      profileStateAad(profile.companyId, profile.id, next),
      await entry.runtime.exportSession(),
    );
    await db
      .update(browserProfiles)
      .set({ sealedState: sealed, stateGeneration: next, lastSealedAt: new Date(now()), updatedAt: new Date(now()) })
      .where(
        and(
          eq(browserProfiles.id, profile.id),
          eq(browserProfiles.companyId, profile.companyId),
          eq(browserProfiles.stateGeneration, current.generation),
        ),
      );
  }

  async function closeLive(profileId: string, save: boolean): Promise<void> {
    const entry = live.get(profileId);
    if (!entry) return;
    live.delete(profileId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.saveTimer) clearInterval(entry.saveTimer);
    try {
      if (save) {
        const [row] = await db.select().from(browserProfiles).where(eq(browserProfiles.id, profileId)).limit(1);
        if (row) await saveSession(row, entry);
      }
    } finally {
      await entry.runtime.close();
    }
  }

  async function ensureLive(profile: ProfileRow): Promise<LiveProfile> {
    const existing = live.get(profile.id);
    if (existing) return existing;
    const pending = opening.get(profile.id);
    if (pending) return pending;
    if (!executor.available) {
      throw Object.assign(unprocessable(executor.unavailableReason ?? "No browser runtime is configured"), {
        status: 503,
      });
    }
    if (live.size >= maxLive) throw conflict("The server is already running the maximum number of browsers");
    const started = (async () => {
      let session: string | null = null;
      if (profile.sealedState) {
        session = openProfileState(
          await readKey(profile),
          profileStateAad(profile.companyId, profile.id, profile.stateGeneration),
          profile.sealedState,
        );
      }
      const entry: LiveProfile = {
        runtime: await executor.launch(session),
        agentTabs: new Set(),
        signIn: null,
        idleTimer: null,
        saveTimer: null,
        chain: Promise.resolve(),
      };
      live.set(profile.id, entry);
      armIdle(profile.id, entry);
      entry.saveTimer = setInterval(() => {
        void enqueue(entry, async () => {
          const [row] = await db.select().from(browserProfiles).where(eq(browserProfiles.id, profile.id)).limit(1);
          if (row && live.get(profile.id) === entry) await saveSession(row, entry);
        }).catch((error) => {
          logger.warn({ profileId: profile.id, errorName: error instanceof Error ? error.name : typeof error }, "periodic browser session save failed");
        });
      }, SAVE_INTERVAL_MS);
      entry.saveTimer.unref();
      return entry;
    })();
    opening.set(profile.id, started);
    try {
      return await started;
    } finally {
      opening.delete(profile.id);
    }
  }

  function activeLease(entry: LiveProfile): LiveProfile["signIn"] {
    if (entry.signIn && entry.signIn.expiresAt <= now()) entry.signIn = null;
    return entry.signIn;
  }

  async function signInState(tab: BrowserTab, entry: LiveProfile): Promise<BrowserSignInState> {
    const page = await tab.state();
    return {
      ...page,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      expiresAt: new Date(entry.signIn?.expiresAt ?? now()).toISOString(),
    };
  }

  async function leaseTab(companyId: string, profileId: string, userId: string) {
    await assertEnabled(companyId);
    const profile = await getOwned(companyId, profileId);
    const entry = live.get(profileId);
    const lease = entry ? activeLease(entry) : null;
    if (!entry || !lease || lease.userId !== userId) {
      throw conflict("Start a sign-in session first", { code: "signin_not_active" });
    }
    const tab = await entry.runtime.openTab(SIGN_IN_TAB, { agentAllowedDomains: null });
    return { profile, entry, tab };
  }

  function actionError(error: unknown): never {
    if (error instanceof BrowserActionError) {
      const details = { code: error.code };
      if (error.code === "sensitive_field" || error.code === "navigation_blocked") throw forbidden(error.message, details);
      if (error.code === "too_many_tabs") throw conflict(error.message, details);
      throw unprocessable(error.message, details);
    }
    throw error;
  }

  return {
    runtimeStatus: () => ({ available: executor.available, reason: executor.unavailableReason }),

    async overview(companyId: string): Promise<BrowserProfilesOverview> {
      const rows = await db
        .select()
        .from(browserProfiles)
        .where(eq(browserProfiles.companyId, companyId))
        .orderBy(asc(browserProfiles.name));
      const agentIds = await agentIdsFor(companyId, rows.map((row) => row.id));
      return {
        enabled: await isEnabled(companyId),
        runtime: { available: executor.available, reason: executor.unavailableReason },
        profiles: rows.map((row) => toProfile(row, agentIds.get(row.id) ?? [])),
      };
    },

    async setEnabled(companyId: string, enabled: boolean, userId: string): Promise<CompanyBrowserSettings> {
      await db
        .insert(companyBrowserSettings)
        .values({ companyId, enabled, updatedByUserId: userId })
        .onConflictDoUpdate({
          target: companyBrowserSettings.companyId,
          set: { enabled, updatedByUserId: userId, updatedAt: new Date(now()) },
        });
      if (!enabled) {
        const rows = await db.select({ id: browserProfiles.id }).from(browserProfiles).where(eq(browserProfiles.companyId, companyId));
        for (const row of rows) await closeLive(row.id, true).catch(() => undefined);
      }
      await audit(companyId, { type: "user", id: userId }, "settings_updated", companyId, { enabled });
      return { enabled };
    },

    async create(companyId: string, input: CreateBrowserProfile, userId: string): Promise<BrowserProfile> {
      await assertEnabled(companyId);
      const id = randomUUID();
      const secret = await secrets.create(
        companyId,
        {
          name: `${KEY_NAME_PREFIX}${id}`,
          provider: getConfiguredSecretProvider(),
          value: generateProfileKey(),
          description: "Encrypts a saved browser login. Do not bind this secret to an agent.",
        },
        { userId },
      );
      try {
        const [row] = await db
          .insert(browserProfiles)
          .values({ id, companyId, name: input.name, allowedDomains: input.allowedDomains, keySecretId: secret.id, createdByUserId: userId })
          .returning();
        await audit(companyId, { type: "user", id: userId }, "profile_created", id, { name: input.name, allowedDomains: input.allowedDomains });
        return toProfile(row, []);
      } catch (error) {
        await secrets.remove(secret.id).catch(() => undefined);
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
          throw conflict("A browser profile with that name already exists");
        }
        throw error;
      }
    },

    async update(companyId: string, profileId: string, patch: UpdateBrowserProfile, userId: string): Promise<BrowserProfile> {
      await assertEnabled(companyId);
      const profile = await getOwned(companyId, profileId);
      if (patch.allowedAgentIds) {
        const found = patch.allowedAgentIds.length
          ? await db
              .select({ id: agents.id })
              .from(agents)
              .where(and(eq(agents.companyId, companyId), inArray(agents.id, patch.allowedAgentIds)))
          : [];
        if (found.length !== new Set(patch.allowedAgentIds).size) {
          throw unprocessable("Every allowed agent must belong to this company");
        }
        await db.transaction(async (tx) => {
          await tx
            .delete(browserProfileAgents)
            .where(and(eq(browserProfileAgents.profileId, profileId), eq(browserProfileAgents.companyId, companyId)));
          if (patch.allowedAgentIds && patch.allowedAgentIds.length > 0) {
            await tx.insert(browserProfileAgents).values(
              [...new Set(patch.allowedAgentIds)].map((agentId) => ({ profileId, agentId, companyId, createdByUserId: userId })),
            );
          }
        });
      }
      const [row] = await db
        .update(browserProfiles)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.allowedDomains !== undefined ? { allowedDomains: patch.allowedDomains } : {}),
          updatedAt: new Date(now()),
        })
        .where(and(eq(browserProfiles.id, profile.id), eq(browserProfiles.companyId, companyId)))
        .returning();
      await audit(companyId, { type: "user", id: userId }, "profile_updated", profileId, {
        fields: Object.keys(patch),
        ...(patch.allowedAgentIds ? { allowedAgentIds: patch.allowedAgentIds } : {}),
        ...(patch.allowedDomains ? { allowedDomains: patch.allowedDomains } : {}),
      });
      return present(row ?? profile);
    },

    async setSuspended(companyId: string, profileId: string, suspended: boolean, userId: string): Promise<BrowserProfile> {
      await assertEnabled(companyId);
      await getOwned(companyId, profileId);
      const [row] = await db
        .update(browserProfiles)
        .set({ status: suspended ? "suspended" : "active", updatedAt: new Date(now()) })
        .where(and(eq(browserProfiles.id, profileId), eq(browserProfiles.companyId, companyId)))
        .returning();
      if (suspended) await closeLive(profileId, true).catch((error) => logger.warn({ profileId, errorName: error instanceof Error ? error.name : typeof error }, "browser close on suspend failed"));
      await audit(companyId, { type: "user", id: userId }, suspended ? "profile_suspended" : "profile_resumed", profileId);
      return present(row);
    },

    async destroy(companyId: string, profileId: string, userId: string): Promise<void> {
      await assertEnabled(companyId);
      const profile = await getOwned(companyId, profileId);
      await closeLive(profileId, false).catch(() => undefined);
      await db.delete(browserProfiles).where(and(eq(browserProfiles.id, profileId), eq(browserProfiles.companyId, companyId)));
      if (profile.keySecretId) await secrets.remove(profile.keySecretId).catch(() => undefined);
      await audit(companyId, { type: "user", id: userId }, "profile_destroyed", profileId, { name: profile.name });
    },

    async startSignIn(companyId: string, profileId: string, userId: string, startUrl?: string): Promise<BrowserSignInState> {
      await assertEnabled(companyId);
      const profile = await getOwned(companyId, profileId);
      if (profile.status !== "active") throw forbidden("Profile is suspended");
      if (startUrl !== undefined && !isSignInNavigationAllowed(startUrl)) throw unprocessable("Use an https URL without credentials");
      const entry = await ensureLive(profile);
      return enqueue(entry, async () => {
        const lease = activeLease(entry);
        if (lease && lease.userId !== userId) throw conflict("Another board user is signing in to this profile");
        for (const key of entry.agentTabs) await entry.runtime.closeTab(key);
        entry.agentTabs.clear();
        entry.signIn = { userId, expiresAt: now() + BROWSER_SIGNIN_LEASE_MS };
        armIdle(profileId, entry);
        const tab = await entry.runtime.openTab(SIGN_IN_TAB, { agentAllowedDomains: null });
        if (startUrl) await tab.navigate(startUrl).catch(actionError);
        await audit(companyId, { type: "user", id: userId }, "signin_started", profileId, startUrl ? { startedAt: auditUrl(startUrl) } : {});
        return signInState(tab, entry);
      });
    },

    async signInStatus(companyId: string, profileId: string, userId: string): Promise<BrowserSignInState> {
      const { entry, tab } = await leaseTab(companyId, profileId, userId);
      return signInState(tab, entry);
    },

    async signInFrame(companyId: string, profileId: string, userId: string): Promise<Buffer> {
      const { entry, tab } = await leaseTab(companyId, profileId, userId);
      return enqueue(entry, () => tab.screenshot());
    },

    async signInInput(companyId: string, profileId: string, userId: string, input: BrowserSignInInput): Promise<BrowserSignInState> {
      const { profile, entry, tab } = await leaseTab(companyId, profileId, userId);
      return enqueue(entry, async () => {
        armIdle(profile.id, entry);
        if (input.type === "navigate") {
          if (!isSignInNavigationAllowed(input.url)) throw unprocessable("Use an https URL without credentials");
          await tab.navigate(input.url).catch(actionError);
        } else if (input.type === "click") {
          await tab.pointerClick(input.x, input.y);
        } else if (input.type === "type") {
          await tab.typeText(input.text);
        } else if (input.type === "key") {
          await tab.press(input.key);
        } else {
          await tab.scroll(input.deltaY);
        }
        return signInState(tab, entry);
      });
    },

    async endSignIn(companyId: string, profileId: string, userId: string): Promise<BrowserProfile> {
      const { profile, entry } = await leaseTab(companyId, profileId, userId);
      await enqueue(entry, async () => {
        await entry.runtime.closeTab(SIGN_IN_TAB);
        entry.signIn = null;
        await saveSession(profile, entry);
        armIdle(profile.id, entry);
      });
      await audit(companyId, { type: "user", id: userId }, "signin_ended", profileId);
      return present(await getOwned(companyId, profileId));
    },

    async listForAgent(companyId: string, agentId: string): Promise<Array<{ id: string; name: string; allowedDomains: string[] }>> {
      if (!(await isEnabled(companyId))) return [];
      const rows = await db
        .select({ id: browserProfiles.id, name: browserProfiles.name, allowedDomains: browserProfiles.allowedDomains })
        .from(browserProfiles)
        .innerJoin(
          browserProfileAgents,
          and(eq(browserProfileAgents.profileId, browserProfiles.id), eq(browserProfileAgents.companyId, browserProfiles.companyId)),
        )
        .where(
          and(
            eq(browserProfiles.companyId, companyId),
            eq(browserProfiles.status, "active"),
            eq(browserProfileAgents.agentId, agentId),
          ),
        )
        .orderBy(asc(browserProfiles.name));
      return rows;
    },

    async agentAction(
      companyId: string,
      profileId: string,
      actor: BrowserAgentActor,
      action: BrowserAgentAction,
    ): Promise<BrowserAgentActionResult> {
      await assertEnabled(companyId);
      const profile = await getOwned(companyId, profileId);
      const agentActor = { type: "agent" as const, id: actor.agentId, agentId: actor.agentId, runId: actor.runId };
      const [grant] = await db
        .select({ agentId: browserProfileAgents.agentId })
        .from(browserProfileAgents)
        .where(
          and(
            eq(browserProfileAgents.profileId, profileId),
            eq(browserProfileAgents.companyId, companyId),
            eq(browserProfileAgents.agentId, actor.agentId),
          ),
        )
        .limit(1);
      if (!grant) {
        await audit(companyId, agentActor, "access_denied", profileId, { reason: "agent_not_allowed", action: action.action });
        throw forbidden("This agent is not allowed to use this browser profile");
      }
      if (profile.status !== "active") throw forbidden("Profile is suspended");
      if (action.action === "navigate" && !isAgentNavigationAllowed(action.url, profile.allowedDomains)) {
        await audit(companyId, agentActor, "navigation_denied", profileId, { target: auditUrl(action.url) });
        throw forbidden("That address is not in this profile's allowed domains", { code: "navigation_blocked" });
      }
      const entry = await ensureLive(profile);
      const tabKey = actor.runId ?? actor.agentId;
      return enqueue(entry, async () => {
        const fresh = await getOwned(companyId, profileId);
        if (fresh.status !== "active") throw forbidden("Profile is suspended");
        if (activeLease(entry)) throw conflict("A board user is signing in to this profile", { code: "profile_busy" });
        armIdle(profileId, entry);
        try {
          if (action.action === "close") {
            await entry.runtime.closeTab(tabKey);
            entry.agentTabs.delete(tabKey);
            await saveSession(fresh, entry);
            return { ok: true as const, url: "", title: "", snapshot: null, note: "Tab closed" };
          }
          const tab = await entry.runtime.openTab(tabKey, { agentAllowedDomains: fresh.allowedDomains });
          entry.agentTabs.add(tabKey);
          let snapshot: string | null = null;
          let note: string | null = null;
          if (action.action === "navigate") {
            await tab.navigate(action.url);
            snapshot = redactSnapshot(await tab.snapshot());
          } else if (action.action === "snapshot") {
            snapshot = redactSnapshot(await tab.snapshot());
          } else if (action.action === "click") {
            await tab.click(action.ref);
            note = "Clicked; take a snapshot to see the result";
          } else if (action.action === "fill") {
            await tab.fill(action.ref, action.value);
            note = "Filled";
          } else if (action.action === "press") {
            await tab.press(action.key);
            note = "Key pressed";
          } else if (action.action === "scroll") {
            await tab.scroll(action.direction === "down" ? 600 : -600);
            note = "Scrolled";
          } else {
            await tab.wait(action.ms);
            note = "Waited";
          }
          const page = await tab.state();
          await audit(companyId, agentActor, "agent_action", profileId, {
            action: action.action,
            page: auditUrl(page.url),
            ...(action.action === "click" || action.action === "fill" ? { ref: action.ref } : {}),
          });
          return { ok: true as const, url: auditUrl(page.url), title: page.title, snapshot, note };
        } catch (error) {
          return actionError(error);
        }
      });
    },

    /** Saves and closes every live browser; call on server shutdown. */
    async closeAll(): Promise<void> {
      for (const profileId of [...live.keys()]) {
        await closeLive(profileId, true).catch(() => undefined);
      }
    },

    /** Test seam: whether a profile currently has a live browser. */
    isLive: (profileId: string) => live.has(profileId),
  };
}

export type BrowserProfileService = ReturnType<typeof browserProfileService>;
