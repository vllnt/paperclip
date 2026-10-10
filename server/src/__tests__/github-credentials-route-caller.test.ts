import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/index.js";
import { CallerGaveUp } from "../services/github-operation-credentials.js";

// The launcher stops waiting after 10 seconds and asks again. The route tells the resolver when its caller is gone, so no
// secret-store read, plugin call or GitHub request starts for a connection that nobody listens to. The resolver is replaced
// here by a recorder: this file needs no database.

const access = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../services/github-operation-access.js", () => ({ resolveGitHubOperationAccess: access.resolve }));

type Seen = { operation: unknown; signal: AbortSignal | undefined };
const operation = { program: "git", args: ["fetch"], remote: "https://github.com/o/r.git" };

describe("the GitHub credentials route and a caller that gave up", () => {
  let server: http.Server | null = null;
  const port = () => (server!.address() as AddressInfo).port;

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "github-credentials-route-caller-secret");
    access.resolve.mockReset();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); });
    server = null;
  });

  async function start() {
    const app = express();
    app.use(express.json());
    app.use(runtimeConnectionIntentRoutes({} as Db));
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  }
  const capability = () => createRuntimeToolsToken({ agentId: "agent-1", companyId: "company-1", runId: "run-1", responsibleUserId: "user-1", scope: "github_credentials" })!.token;

  /** A raw request that the test can abandon. */
  function ask(body: unknown = { operation }, headers: Record<string, string> = { "x-paperclip-github-capability": capability() }) {
    const payload = JSON.stringify(body);
    let request!: http.ClientRequest;
    const answered = new Promise<{ status: number; body: string }>((resolve, reject) => {
      request = http.request({ host: "127.0.0.1", port: port(), path: "/runtime-tools/github/credentials", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers } }, response => {
        let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      });
      request.on("error", reject);
      request.end(payload);
    });
    return { request, answered, abandon: () => { request.destroy(); answered.catch(() => undefined); } };
  }

  it("answers with the resolver's decision, and hands it the run, the operation and a live signal", async () => {
    await start();
    let seen: Seen | null = null;
    access.resolve.mockImplementation(async (_db: unknown, run: unknown, reported: unknown, options?: { signal?: AbortSignal }) => {
      seen = { operation: reported, signal: options?.signal };
      expect(run).toEqual({ companyId: "company-1", agentId: "agent-1", runId: "run-1" });
      return { status: "available", env: { GH_TOKEN: "t" } };
    });

    const response = await ask().answered;

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "available", env: { GH_TOKEN: "t" } });
    expect((seen as Seen | null)?.operation).toEqual(operation);
    expect((seen as Seen | null)?.signal?.aborted).toBe(false);
  });

  it("does not abort the signal when the answer has been sent and the connection then closes", async () => {
    await start();
    let signal: AbortSignal | undefined;
    access.resolve.mockImplementation(async (_db: unknown, _run: unknown, _reported: unknown, options?: { signal?: AbortSignal }) => { signal = options?.signal; return { status: "absent", env: {} }; });

    await ask().answered;
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(signal?.aborted).toBe(false);
  });

  it("aborts the signal when the caller closes the connection before the answer", async () => {
    await start();
    let started: () => void = () => {};
    const resolverStarted = new Promise<void>(resolve => { started = resolve; });
    let signal: AbortSignal | undefined;
    const aborted = new Promise<void>(resolve => {
      access.resolve.mockImplementation((_db: unknown, _run: unknown, _reported: unknown, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        signal?.addEventListener("abort", () => resolve(), { once: true });
        started();
        return new Promise(() => undefined); // never answers
      });
    });
    const call = ask();
    await resolverStarted;

    call.abandon();

    await aborted;
    expect(signal?.aborted).toBe(true);
  });

  it("ends quietly when the resolver stops for a caller that is gone: no error response, no failure for the next request", async () => {
    await start();
    let started: () => void = () => {};
    const resolverStarted = new Promise<void>(resolve => { started = resolve; });
    let finish: () => void = () => {};
    const finished = new Promise<void>(resolve => { finish = resolve; });
    access.resolve.mockImplementationOnce((_db: unknown, _run: unknown, _reported: unknown, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      started();
      options?.signal?.addEventListener("abort", () => { reject(new CallerGaveUp()); finish(); }, { once: true });
    }));
    access.resolve.mockResolvedValueOnce({ status: "available", env: {} });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const call = ask();
      await resolverStarted;
      call.abandon();
      await finished;
      await new Promise(resolve => setTimeout(resolve, 50));

      expect((await ask().answered).status).toBe(200);
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });

  it("still reports an ordinary failure of the resolver as an error", async () => {
    await start();
    access.resolve.mockRejectedValue(new Error("the database is down"));

    const response = await ask().answered;

    expect(response.status).toBe(500);
  });

  it("does not call the resolver for a request without a valid capability", async () => {
    await start();

    const missing = await ask({ operation }, {}).answered;
    const wrong = await ask({ operation }, { "x-paperclip-github-capability": "not-a-token" }).answered;

    expect([missing.status, wrong.status]).toEqual([401, 401]);
    expect(access.resolve).not.toHaveBeenCalled();
  });
});
