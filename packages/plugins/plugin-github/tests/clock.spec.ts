import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubClock } from "../src/clock.js";
import { GitHubClient, GitHubError } from "../src/github.js";

const HOUR = 3_600_000;
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" }).toString();
const app = { id: 12, slug: "paperclip", name: "Paperclip", permissions: {} };

/** GitHub refusing JWTs dated outside its own clock (`Date.now() + offset`), serving what the App callers read. */
function skewedGitHub(offset: number) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const jwt = String((init.headers as Record<string, string>).Authorization ?? "").replace(/^Bearer /, "");
    const headers = { date: new Date(Date.now() + offset).toUTCString(), "content-type": "application/json" };
    if (url.startsWith("https://github.com/login/oauth")) return new Response(JSON.stringify({ error: "bad_refresh_token" }), { status: 200, headers });
    const { iat, exp } = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
    const now = Math.floor((Date.now() + offset) / 1000);
    if (iat > now || exp <= now) return new Response(JSON.stringify({ message: "JWT time claims refused" }), { status: 401, headers });
    if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_" + "a".repeat(36) }), { status: 201, headers });
    if (url.includes("/app/installations")) return new Response(JSON.stringify([{ id: 101, account: { login: "Anthm-FR", id: 1, type: "Organization" }, permissions: {} }]), { status: 200, headers });
    return new Response(JSON.stringify(app), { status: 200, headers });
  });
}

/** A clock whose host time and monotonic time the test moves by hand. */
function manualClock() {
  const t = { local: Date.parse("2026-10-18T03:00:00.000Z"), mono: 1_000 };
  const clock = new GitHubClock(() => t.local, () => t.mono);
  const changes: number[] = [];
  clock.onSkewChange = skew => changes.push(skew);
  return { t, clock, changes };
}

describe("GitHub's clock (VLL-1192)", () => {
  it("learns GitHub's offset from Date headers, ignores the header's one-second noise and reports crossing a minute", () => {
    const { t, clock, changes } = manualClock();
    clock.observe(new Date(t.local + 1_200).toUTCString(), clock.started());
    expect(clock.skewMs()).toBe(0);
    expect(clock.now()).toBe(t.local);
    // This host lags 4.5 hours behind (a VM paused and resumed).
    clock.observe(new Date(t.local + 4.5 * HOUR).toUTCString(), clock.started());
    expect(Math.abs(clock.skewMs() - 4.5 * HOUR)).toBeLessThanOrEqual(500);
    expect(Math.abs(clock.now() - (t.local + 4.5 * HOUR))).toBeLessThanOrEqual(500);
    clock.observe(new Date(t.local + 4.5 * HOUR).toUTCString(), clock.started());
    expect(changes).toHaveLength(1);
    // Corrected: reported once more, back in agreement.
    t.local += 4.5 * HOUR;
    clock.observe(new Date(t.local).toUTCString(), clock.started());
    expect(clock.skewMs()).toBe(0);
    expect(changes).toEqual([expect.any(Number), 0]);
    // Nothing usable: unchanged.
    clock.observe(null, clock.started());
    clock.observe("not a date", clock.started());
    clock.observe(new Date(t.local + 400 * 24 * HOUR).toUTCString(), clock.started());
    expect(clock.skewMs()).toBe(0);
  });

  it("is not misled by a host clock step during a request, and ignores a slow answer", () => {
    const { t, clock } = manualClock();
    const github = t.local + 4.5 * HOUR;
    // chrony steps the host clock forward 4.5 hours while the request is in flight (300 ms).
    const started = clock.started();
    t.local += 4.5 * HOUR + 300; t.mono += 300;
    clock.observe(new Date(github + 150).toUTCString(), started);
    expect(Math.abs(clock.skewMs())).toBeLessThan(2_000);
    // An answer 12 seconds late dates GitHub's clock too loosely: not learned.
    const slow = clock.started();
    t.local += 12_000; t.mono += 12_000;
    clock.observe(new Date(t.local - 3 * HOUR).toUTCString(), slow);
    expect(Math.abs(clock.skewMs())).toBeLessThan(2_000);
  });

  it("never fails a request when the skew listener throws", () => {
    const { t, clock } = manualClock();
    clock.onSkewChange = () => { throw new Error("logger down"); };
    expect(() => clock.observe(new Date(t.local + HOUR).toUTCString(), clock.started())).not.toThrow();
    expect(clock.skewMs()).toBeGreaterThan(HOUR - 2_000);
  });

  it("reads the Date of error answers and of OAuth answers", async () => {
    const github = Date.now() + 4.5 * HOUR;
    const refused = new GitHubClient((async () => new Response("{}", { status: 401, headers: { date: new Date(github).toUTCString() } })) as unknown as typeof fetch);
    await expect(refused.request("/user", "ghu_token")).rejects.toBeInstanceOf(GitHubError);
    expect(Math.abs(refused.clock.skewMs() - 4.5 * HOUR)).toBeLessThan(2_000);
    const oauth = new GitHubClient((async () => new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200, headers: { date: new Date(github).toUTCString(), "content-type": "application/json" } })) as unknown as typeof fetch);
    await oauth.oauth("/login/oauth/access_token", { client_id: "Iv23liAbcdef12" });
    expect(Math.abs(oauth.clock.skewMs() - 4.5 * HOUR)).toBeLessThan(2_000);
  });

  it.each([
    ["ahead by 2 hours (iat in GitHub's future)", -2 * HOUR],
    ["behind by 4.5 hours (exp in GitHub's past)", 4.5 * HOUR],
  ])("signs App JWTs by GitHub's clock when this host's is %s: refused once, signed again, then right first time", async (_label, offset) => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const jwt = String((init.headers as Record<string, string>).Authorization).replace(/^Bearer /, "");
      const { iat, exp } = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
      const headers = { date: new Date(Date.now() + offset).toUTCString(), "content-type": "application/json" };
      const now = Math.floor((Date.now() + offset) / 1000);
      if (iat > now || exp <= now) return new Response(JSON.stringify({ message: "JWT time claims refused" }), { status: 401, headers });
      return new Response(JSON.stringify(app), { status: 200, headers });
    });
    const client = new GitHubClient(fetcher as unknown as typeof fetch);
    await expect(client.verify("12", pem)).resolves.toMatchObject({ id: "12" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(client.verify("12", pem)).resolves.toMatchObject({ id: "12" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([["behind by 4.5 hours", 4.5 * HOUR], ["ahead by 2 hours", -2 * HOUR]])("every App JWT caller follows GitHub's clock when this host's is %s", async (_l, offset) => {
    const calls: Array<[string, (c: GitHubClient) => Promise<unknown>]> = [
      ["catalog", c => c.catalog("12", pem)],
      ["hasInstallation", c => c.hasInstallation("12", pem, 101)],
      ["scopedToken", c => c.scopedToken("12", pem, 101, { metadata: "read" }, [5])],
      ["resolveOwners", c => c.resolveOwners("12", pem, ["Anthm-FR"])],
    ];
    for (const [name, call] of calls) {
      const fetcher = skewedGitHub(offset);
      const client = new GitHubClient(fetcher as unknown as typeof fetch);
      await expect(call(client), name).resolves.toBeDefined();
    }
  });

  it("does not sign again when a 401 did not move the clock (the App's credentials are wrong)", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 401, headers: { date: new Date().toUTCString() } }));
    const client = new GitHubClient(fetcher as unknown as typeof fetch);
    await expect(client.verify("12", pem)).rejects.toBeInstanceOf(GitHubError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
