import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexApiError, ConvexClient, type FetchLike } from "../src/convex-client.js";
import { isDefinitive, isTransport } from "../src/service.js";
import { COMPANY_A, PREVIEW_KEY, PROJECT_TOKEN, baseConfig, ref, run, setup } from "./fixture.js";
import { deployment } from "./fakes.js";

const PROBE = "cvx_probe_TOPSECRET_1111111111";
const respond = (status: number, body: unknown = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const fail = async (promise: Promise<unknown>): Promise<ConvexApiError> => {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(ConvexApiError); return error as ConvexApiError; }
  throw new Error("The call did not fail.");
};

afterEach(() => { vi.useRealTimers(); });

describe("an answer Convex gives", () => {
  // status, whether the owner of the credential should be told it was rejected, and how a caller must treat the failure.
  const table: Array<[number, "definitive" | "transport"]> = [
    [400, "definitive"], [401, "definitive"], [403, "definitive"], [404, "definitive"], [409, "definitive"], [422, "definitive"],
    [408, "transport"], [429, "transport"], [500, "transport"], [502, "transport"], [503, "transport"],
  ];

  it.each(table)("with status %i is a %s failure, with a message that carries no credential", async (status, kind) => {
    const unauthorized = vi.fn();
    const client = new ConvexClient(async () => respond(status, { code: "SomeCode", message: `refused Bearer ${PROBE} and Convex ${PROBE} and ${PROBE}` }));
    client.onUnauthorized = unauthorized;
    const error = await fail(client.getDeployment(PROBE, "x"));
    expect(error.status).toBe(status);
    expect(error.message).toBe(`Convex answered ${status}: SomeCode: refused [redacted] and [redacted] and [redacted].`);
    expect(isDefinitive(error)).toBe(kind === "definitive");
    expect(isTransport(error)).toBe(kind === "transport");
    expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    if (status === 401) expect(unauthorized).toHaveBeenCalledWith(PROBE);
  });

  it("shows only the status when the body is not JSON, however long or hostile", async () => {
    const error = await fail(new ConvexClient(async () => respond(500, `<html>${"x".repeat(10_000)} ${PROBE}</html>`)).getDeployment(PROBE, "x"));
    expect(error.message).toBe("Convex answered 500.");
  });

  it("is cut to 200 characters when the message is long", async () => {
    const error = await fail(new ConvexClient(async () => respond(400, { code: "Long", message: "m".repeat(5_000) })).getDeployment(PROBE, "x"));
    expect(error.message.length).toBeLessThan(260);
  });

  it("with status 200 and no JSON is a failure that is neither definitive nor transport", async () => {
    const error = await fail(new ConvexClient(async () => respond(200, "<html>not json</html>")).getDeployment(PROBE, "x"));
    expect(error).toMatchObject({ status: 200, message: "Convex returned a response that is not JSON." });
    expect(isDefinitive(error) || isTransport(error)).toBe(false);
  });

  it("is read as nothing when it is empty or 204", async () => {
    await expect(new ConvexClient(async () => new Response(null, { status: 204 })).setExpiry(PROBE, "x", 1)).resolves.toBeUndefined();
    await expect(new ConvexClient(async () => respond(200, "")).deleteDeployment(PROBE, "x")).resolves.toBeUndefined();
  });

  it("is refused when the body is larger than the limit, without reading all of it", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(1_000_000)); } });
    const error = await fail(new ConvexClient(async () => new Response(body, { status: 200 })).getDeployment(PROBE, "x"));
    expect(error).toMatchObject({ status: 200, message: "Convex returned a response that is too large." });
    expect(pulled).toBeLessThan(10);
  });
});

describe("a call that does not get an answer", () => {
  it("is a transport failure with a fixed message, whatever the runtime said", async () => {
    const error = await fail(new ConvexClient(async () => { throw new Error(`connect ECONNREFUSED 203.0.113.7:443 Bearer ${PROBE}`); }).getDeployment(PROBE, "x"));
    expect(error).toMatchObject({ status: 0, message: "Convex could not be reached." });
    expect(isTransport(error)).toBe(true);
    expect(isDefinitive(error)).toBe(false);
  });

  it("is abandoned after twenty seconds when the fetch honours the signal", async () => {
    vi.useFakeTimers();
    const hang: FetchLike = (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); });
    const pending = fail(new ConvexClient(hang).getDeployment(PROBE, "x"));
    await vi.advanceTimersByTimeAsync(19_999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 0 });
  });

  it("does not follow a redirect, and sends the scheme, client name and body it should", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const client = new ConvexClient(async (url, init) => { seen.push({ url, init: init! }); return respond(200, {}); });
    await client.getDeployment(PROBE, "x");
    await client.setExpiry(PROBE, "x", 5);
    await client.deploymentGet(PROBE, { name: "x", deploymentUrl: "https://x.convex.cloud" }, "get_current_usage");
    const [get, patch, cloud] = seen;
    expect(get.init).toMatchObject({ method: "GET", redirect: "error" });
    expect(new Headers(get.init.headers).get("authorization")).toBe(`Bearer ${PROBE}`);
    expect(new Headers(get.init.headers).get("content-type")).toBeNull();
    expect(new Headers(get.init.headers).get("convex-client")).toBe("paperclip-convex-plugin");
    expect(patch.init).toMatchObject({ method: "PATCH", body: JSON.stringify({ expiresAt: 5 }) });
    expect(new Headers(patch.init.headers).get("content-type")).toBe("application/json");
    expect(new Headers(cloud.init.headers).get("authorization")).toBe(`Convex ${PROBE}`);
    expect(cloud.url).toBe("https://x.convex.cloud/api/v1/get_current_usage");
  });

  it("never reaches the network for a deployment URL that is not the deployment's own host", async () => {
    const fetchImpl = vi.fn(async () => respond(200, {}));
    const client = new ConvexClient(fetchImpl);
    for (const deploymentUrl of ["https://other.convex.cloud", "http://x.convex.cloud", "https://x.convex.cloud:8443", "https://user:pw@x.convex.cloud", "https://x.convex.cloud.evil.example", "https://evil.example/x.convex.cloud", "not a url"]) {
      await fail(client.deploymentGet(PROBE, { name: "x", deploymentUrl }, "deployment_info"));
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("credentials of another project", () => {
  const withKeys = () => baseConfig({
    projects: [{ convexProjectId: "100", name: "app", repository: "org/app", token: ref("s-project"), previewDeployKey: ref("s-preview"), environments: { production: ["prod-app"], staging: ["staging-app"] } }],
  });

  it("move a call on to the next credential when Convex answers 403, and the one that worked is tried first from then on", async () => {
    const f = await setup({ configs: { [COMPANY_A]: withKeys() } });
    f.convex.validTokens.add(PREVIEW_KEY);
    f.convex.scopes.set(PREVIEW_KEY, new Set([200]));
    f.convex.add(deployment("feat-x"));
    for (let i = 0; i < 2; i++) expect((await f.h.executeTool<any>("convex_get_deployment", { name: "feat-x" }, run("observer"))).data.name).toBe("feat-x");
    const used = f.convex.calls.filter(call => call.url.endsWith("/deployments/feat-x")).map(call => call.authorization);
    expect(used).toEqual([`Bearer ${PREVIEW_KEY}`, `Bearer ${PROJECT_TOKEN}`, `Bearer ${PROJECT_TOKEN}`]);
  });

  it("end with the not-available message, not a credential error, when every credential is refused", async () => {
    const f = await setup({ configs: { [COMPANY_A]: withKeys() } });
    f.convex.add(deployment("feat-x"));
    f.convex.scopes.set(PROJECT_TOKEN, new Set([200]));
    f.convex.scopes.set("cvx_team_TOPSECRET_0123456789", new Set([200]));
    const result = await f.h.executeTool<any>("convex_get_deployment", { name: "feat-x" }, run("observer"));
    expect(result.error).toMatch(/not available for this company/);
    expect(JSON.stringify(result)).not.toMatch(/TOPSECRET|Bearer/);
  });
});
