import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";
import { GitHubError, type GitHubClient } from "./github.js";

/**
 * A person's authorization of the company's own GitHub App (a GitHub App
 * user-to-server token), obtained with the device flow so no callback URL is
 * needed. GitHub caps the token to the App's installation and permissions.
 *
 * - The access token expires after 8 hours and lives only in worker memory.
 * - The rotating refresh token lives only in the company secret bound at the
 *   `userRefreshToken` config path; the plugin writes each new one back with
 *   `ctx.secrets.storeOwn`. It is never sent to a run.
 * - Every change to the authorization (device-flow completion, refresh with
 *   refresh-token rotation, revocation, fence results) runs under one lock per
 *   company, so a refresh can never overwrite a revocation.
 * - GitHub must issue access tokens that expire within 8 hours and a refresh
 *   token that expires too; anything else is refused.
 */
export interface FenceStatus {
  ok: boolean;
  checkedAt: string;
  reason?: string;
  /** GitHub could not be reached; not drift. */
  transient?: boolean;
  installationId?: number;
  repositories?: string[];
  permissions?: Record<string, string>;
  /**
   * Repository IDs by name, pinned at the first good check: a fenced name that
   * later points at another repository (deleted and recreated, or renamed) is drift.
   * An administrator saving the policy re-pins them.
   */
  repositoryIds?: Record<string, number>;
}

export interface UserAuthorizationState {
  login: string;
  userId: string;
  authorizedAt: string;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  /** Set when the authorization stopped working; the reason says what to do. */
  needsReauthorization?: string;
  fence?: FenceStatus;
}

export type DevicePoll =
  | { status: "pending" | "expired" | "denied" }
  | { status: "authorized"; login: string; userId: string };

type UserConfig = { clientId: string; clientSecret: EnvSecretRefBinding; refreshToken: EnvSecretRefBinding };

const stateKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "identity", stateKey: "user-authorization" });
const REFRESH_MARGIN_MS = 5 * 60_000;
const USER_TOKEN = /^gh[ur]_[A-Za-z0-9_]{20,255}$/;

function isSecretRef(value: unknown): value is EnvSecretRefBinding {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "secret_ref" && typeof (value as { secretId?: unknown }).secretId === "string";
}
const expiry = (now: number, seconds: unknown) => Number.isSafeInteger(seconds) && Number(seconds) > 0 ? new Date(now + Number(seconds) * 1000).toISOString() : null;
/** GitHub App user access tokens last 8 hours; a little skew is tolerated. */
export const MAX_ACCESS_TOKEN_SECONDS = 8 * 3600 + 300;
/** GitHub App refresh tokens last 6 months. */
export const MAX_REFRESH_TOKEN_SECONDS = 184 * 24 * 3600;
const lifetime = (seconds: unknown, max: number) => Number.isSafeInteger(seconds) && Number(seconds) > 0 && Number(seconds) <= max;
const NO_USER_TOKEN = "GitHub did not return a user token.";
/** Null when GitHub's token answer has the expected shape and expiring lifetimes; otherwise why not. */
function tokenProblem(data: Record<string, unknown>): string | null {
  if (typeof data.access_token !== "string" || !USER_TOKEN.test(data.access_token)) return NO_USER_TOKEN;
  if (typeof data.refresh_token !== "string" || !USER_TOKEN.test(data.refresh_token) || data.expires_in === undefined || data.refresh_token_expires_in === undefined) {
    // Without expiry a leaked token stays valid until someone notices.
    return "Turn on \"Expire user authorization tokens\" in the GitHub App's settings, then authorize again.";
  }
  if (!lifetime(data.expires_in, MAX_ACCESS_TOKEN_SECONDS)) return "GitHub issued a user token valid for longer than 8 hours; Paperclip refuses it.";
  if (!lifetime(data.refresh_token_expires_in, MAX_REFRESH_TOKEN_SECONDS)) return "GitHub issued a refresh token without a valid expiry; Paperclip refuses it.";
  return null;
}

export class UserAuthorizationError extends Error {}

export class UserAuthorization {
  private tokens = new Map<string, { token: string; expires: number }>();
  private refreshing = new Map<string, Promise<string>>();
  private devices = new Map<string, { deviceCode: string; expires: number; interval: number; nextPoll: number }>();
  /** Bumped as soon as a revocation is requested; a refresh that started before one hands out nothing. */
  private generations = new Map<string, number>();
  /** One authorization change at a time per company (refresh, rotation, revocation, state updates). */
  private locks = new Map<string, Promise<unknown>>();
  private ctx: PluginContext;
  private github: GitHubClient;
  private now: () => number;

  constructor(ctx: PluginContext, github: GitHubClient, now: () => number = () => Date.now()) {
    this.ctx = ctx; this.github = github; this.now = now;
  }

  async state(companyId: string): Promise<UserAuthorizationState | null> {
    const stored = await this.ctx.state.get(stateKey(companyId));
    return stored && typeof stored === "object" ? stored as UserAuthorizationState : null;
  }

  private async writeState(companyId: string, state: UserAuthorizationState | null): Promise<void> {
    if (state) await this.ctx.state.set(stateKey(companyId), state);
    else await this.ctx.state.delete(stateKey(companyId));
  }

  /** Runs `change` after every earlier change for the company has finished. */
  private serialize<T>(companyId: string, change: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(companyId) ?? Promise.resolve()).catch(() => {}).then(change);
    this.locks.set(companyId, next);
    void next.finally(() => { if (this.locks.get(companyId) === next) this.locks.delete(companyId); }).catch(() => {});
    return next;
  }

  /** Updates the stored state under the lock, from its latest value; a revocation recorded meanwhile is kept. */
  async updateState(companyId: string, update: (state: UserAuthorizationState) => UserAuthorizationState): Promise<UserAuthorizationState | null> {
    return this.serialize(companyId, async () => {
      const state = await this.state(companyId);
      if (!state) return null;
      const next = update(state);
      const saved = state.needsReauthorization ? { ...next, needsReauthorization: state.needsReauthorization } : next;
      await this.writeState(companyId, saved);
      return saved;
    });
  }

  private async config(companyId: string): Promise<UserConfig> {
    const config = await this.ctx.config.get(companyId);
    if (typeof config.userClientId !== "string" || !/^[A-Za-z0-9.]{8,100}$/.test(config.userClientId)) {
      throw new UserAuthorizationError("Save the GitHub App's client ID (userClientId) in this company's plugin config.");
    }
    if (!isSecretRef(config.userClientSecret) || !isSecretRef(config.userRefreshToken)) {
      throw new UserAuthorizationError("Bind company secrets for userClientSecret and userRefreshToken in this company's plugin config.");
    }
    return { clientId: config.userClientId, clientSecret: config.userClientSecret, refreshToken: config.userRefreshToken };
  }

  /** Starts the device flow. The person enters `userCode` at `verificationUri` as the expected GitHub user. */
  async start(companyId: string) {
    const config = await this.config(companyId);
    const data = await this.github.oauth("/login/device/code", { client_id: config.clientId });
    if (typeof data.device_code !== "string" || typeof data.user_code !== "string" || data.verification_uri !== "https://github.com/login/device"
      || !Number.isSafeInteger(data.expires_in) || !Number.isSafeInteger(data.interval)) {
      throw new UserAuthorizationError(data.error === "device_flow_disabled"
        ? "Enable Device Flow in the GitHub App's settings, then start again."
        : "GitHub did not start the device flow. Check the App's client ID.");
    }
    const now = this.now(), interval = Number(data.interval);
    this.devices.set(companyId, { deviceCode: data.device_code, expires: now + Number(data.expires_in) * 1000, interval, nextPoll: now + interval * 1000 });
    return { userCode: data.user_code, verificationUri: data.verification_uri, expiresIn: Number(data.expires_in), interval };
  }

  /**
   * Polls a started device flow once. On success the GitHub user must be
   * `expectedLogin`; the refresh token is stored and the access token cached.
   */
  async poll(companyId: string, expectedLogin: string): Promise<DevicePoll> {
    // A revocation while GitHub answers this poll wins: the result is discarded, not stored.
    const generation = this.generations.get(companyId) ?? 0;
    const device = this.devices.get(companyId);
    const now = this.now();
    if (!device || device.expires <= now) { this.devices.delete(companyId); return { status: "expired" }; }
    if (device.nextPoll > now) return { status: "pending" };
    const config = await this.config(companyId);
    const data = await this.github.oauth("/login/oauth/access_token", {
      client_id: config.clientId, device_code: device.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    device.nextPoll = now + device.interval * 1000;
    if (data.error === "authorization_pending") return { status: "pending" };
    if (data.error === "slow_down") { device.interval += 5; device.nextPoll = now + device.interval * 1000; return { status: "pending" }; }
    if (data.error === "expired_token") { this.devices.delete(companyId); return { status: "expired" }; }
    if (data.error === "access_denied") { this.devices.delete(companyId); return { status: "denied" }; }
    const problem = tokenProblem(data);
    if (problem === NO_USER_TOKEN) throw new UserAuthorizationError(`${problem} Start the authorization again.`);
    this.devices.delete(companyId);
    if (problem) throw new UserAuthorizationError(problem);
    const accessToken = data.access_token as string, refreshToken = data.refresh_token as string;
    const { data: user } = await this.github.request<{ login?: unknown; id?: unknown }>("/user", accessToken);
    if (typeof user.login !== "string" || !Number.isSafeInteger(user.id) || user.login.toLowerCase() !== expectedLogin.toLowerCase()) {
      throw new UserAuthorizationError(`Authorize as GitHub user ${expectedLogin}; GitHub reported another account.`);
    }
    const login = user.login, userId = String(user.id);
    await this.serialize(companyId, async () => {
      if ((this.generations.get(companyId) ?? 0) !== generation) {
        throw new UserAuthorizationError("The GitHub user authorization was revoked while it was being completed. Start the authorization again.");
      }
      await this.ctx.secrets.storeOwn(refreshToken, { companyId, configPath: "userRefreshToken" });
      this.tokens.set(companyId, { token: accessToken, expires: now + Number(data.expires_in) * 1000 });
      await this.writeState(companyId, {
        login, userId, authorizedAt: new Date(now).toISOString(),
        accessTokenExpiresAt: expiry(now, data.expires_in), refreshTokenExpiresAt: expiry(now, data.refresh_token_expires_in),
      });
    });
    return { status: "authorized", login, userId };
  }

  /** A valid access token, refreshed when it expires within 5 minutes. Throws a user-facing reason. */
  async accessToken(companyId: string): Promise<string> {
    const cached = this.tokens.get(companyId);
    if (cached && cached.expires - REFRESH_MARGIN_MS > this.now()) return cached.token;
    const pending = this.refreshing.get(companyId);
    if (pending) return pending;
    const generation = this.generations.get(companyId) ?? 0;
    const refresh = this.serialize(companyId, () => this.refresh(companyId, generation)).finally(() => this.refreshing.delete(companyId));
    this.refreshing.set(companyId, refresh);
    return refresh;
  }

  /** Runs under the company's lock. `generation` is the revocation count when the token was asked for. */
  private async refresh(companyId: string, generation: number): Promise<string> {
    const revokedMeanwhile = () => (this.generations.get(companyId) ?? 0) !== generation;
    if (revokedMeanwhile()) throw new UserAuthorizationError("The GitHub user authorization was revoked. Authorize the GitHub user again.");
    // Another refresh may have finished while this one waited for the lock.
    const fresh = this.tokens.get(companyId);
    if (fresh && fresh.expires - REFRESH_MARGIN_MS > this.now()) return fresh.token;
    const state = await this.state(companyId);
    if (!state) throw new UserAuthorizationError("Authorize the GitHub user for this company first.");
    if (state.needsReauthorization) throw new UserAuthorizationError(state.needsReauthorization);
    const config = await this.config(companyId);
    const refreshToken = await this.ctx.secrets.resolve(config.refreshToken, { companyId, configPath: "userRefreshToken" });
    if (!USER_TOKEN.test(refreshToken.trim())) return this.reauthorize(companyId, "Authorize the GitHub user for this company again.");
    const clientSecret = await this.ctx.secrets.resolve(config.clientSecret, { companyId, configPath: "userClientSecret" });
    const now = this.now();
    const data = await this.github.oauth("/login/oauth/access_token", {
      client_id: config.clientId, client_secret: clientSecret.trim(), grant_type: "refresh_token", refresh_token: refreshToken.trim(),
    });
    if (data.error !== undefined || typeof data.access_token !== "string") {
      // bad_refresh_token after a revocation or 6 months without use.
      return this.reauthorize(companyId, "GitHub refused to refresh the user authorization (revoked or expired). Authorize the GitHub user again.");
    }
    const problem = tokenProblem(data);
    if (problem) return this.reauthorize(companyId, `${problem} Authorize the GitHub user again.`);
    // Revoked while the refresh was in flight: keep nothing it returned. GitHub already
    // rotated the refresh token, so the old one is dead too.
    if (revokedMeanwhile()) throw new UserAuthorizationError("The GitHub user authorization was revoked. Authorize the GitHub user again.");
    try {
      await this.ctx.secrets.storeOwn(data.refresh_token as string, { companyId, configPath: "userRefreshToken" });
    } catch (error) {
      // GitHub already invalidated the old refresh token. The access token still
      // works for 8 hours; after that a new authorization is needed.
      this.ctx.logger.error("Could not store the rotated GitHub refresh token", { companyId, error: error instanceof Error ? error.name : "unknown" });
    }
    const latest = await this.state(companyId);
    await this.writeState(companyId, { ...(latest ?? state), accessTokenExpiresAt: expiry(now, data.expires_in), refreshTokenExpiresAt: expiry(now, data.refresh_token_expires_in) });
    // A revocation requested meanwhile waits for this lock and then overwrites the stored token; hand out nothing.
    if (revokedMeanwhile()) throw new UserAuthorizationError("The GitHub user authorization was revoked. Authorize the GitHub user again.");
    const accessToken = data.access_token as string;
    this.tokens.set(companyId, { token: accessToken, expires: now + Number(data.expires_in) * 1000 });
    return accessToken;
  }

  /** Runs under the lock (from a refresh). */
  private async reauthorize(companyId: string, reason: string): Promise<never> {
    this.generations.set(companyId, (this.generations.get(companyId) ?? 0) + 1);
    await this.markRevoked(companyId, reason);
    throw new UserAuthorizationError(reason);
  }

  /** Runs under the lock. */
  private async markRevoked(companyId: string, reason: string): Promise<void> {
    this.tokens.delete(companyId);
    const state = await this.state(companyId);
    if (state && state.needsReauthorization !== reason) await this.writeState(companyId, { ...state, needsReauthorization: reason });
  }

  /** Called when GitHub rejects the user token: stop using it until someone authorizes again. */
  async revoked(companyId: string, reason: string): Promise<void> {
    // Counted at once, so a refresh already waiting or in flight hands out nothing.
    this.generations.set(companyId, (this.generations.get(companyId) ?? 0) + 1);
    this.tokens.delete(companyId);
    await this.serialize(companyId, () => this.markRevoked(companyId, reason));
  }

  /** Forgets every token held for the company and overwrites the stored refresh token, after any refresh in flight. */
  async forget(companyId: string, reason: string): Promise<void> {
    this.generations.set(companyId, (this.generations.get(companyId) ?? 0) + 1);
    this.tokens.delete(companyId);
    this.devices.delete(companyId);
    await this.serialize(companyId, async () => {
      await this.markRevoked(companyId, reason);
      try { await this.ctx.secrets.storeOwn("revoked", { companyId, configPath: "userRefreshToken" }); }
      catch { /* No bound secret: nothing to overwrite. */ }
    });
  }

  /** True when GitHub's error means the user token no longer works. */
  static rejected(error: unknown): boolean {
    return error instanceof GitHubError && error.status === 401;
  }
}
