import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import express, { type Express } from "express";
import type { UiHealthState } from "@paperclipai/shared";
import { precompressedStatic } from "../middleware/precompressed-static.js";
import { staticUiCacheControl } from "../static-ui-cache.js";
import { createNextChild, type NextChildLogger, type NextChildOptions } from "./next-child.js";
import { createNextHmrUpgradeHandler, createNextProxy } from "./next-proxy.js";

export type UiRuntime = "next" | "vite";

/** The placeholder in `ui/public/sw.js`; `ui/src/lib/vite-sw-build-id.ts` stamps the same one for the Vite build. */
const SERVICE_WORKER_BUILD_ID_PLACEHOLDER = "__PAPERCLIP_BUILD_ID__";

function readNextBuildId(uiRoot: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(uiRoot, ".next", "BUILD_ID"), "utf8").trim();
    // Keep only characters that are safe inside a Cache Storage name.
    return raw.replace(/[^A-Za-z0-9_-]/g, "-") || null;
  } catch {
    return null;
  }
}

/**
 * Picks the web app runtime from `PAPERCLIP_UI_RUNTIME`.
 *
 * - `vite`: today's path (`ui/dist`, or the Vite dev middleware in development).
 * - `next`: the Next.js child. Without a build (`ui/.next/BUILD_ID`) it falls
 *   back to `vite` with a warning. Development needs no build.
 * - unset: `next` when a build exists; `vite` otherwise, and always `vite` in
 *   development, where Next.js is an explicit opt-in.
 */
export function resolveUiRuntime(input: {
  env: NodeJS.ProcessEnv;
  uiRoot: string;
  dev: boolean;
  warn: (message: string) => void;
}): UiRuntime {
  const requested = input.env.PAPERCLIP_UI_RUNTIME?.trim().toLowerCase();
  if (requested === "vite") return "vite";
  if (requested && requested !== "next") {
    input.warn(`PAPERCLIP_UI_RUNTIME=${requested} is not "next" or "vite"; choosing by whether a Next.js build exists`);
  }
  const explicit = requested === "next";
  if (input.dev) return explicit ? "next" : "vite";
  if (readNextBuildId(input.uiRoot) !== null) return "next";
  if (explicit) {
    input.warn("PAPERCLIP_UI_RUNTIME=next but ui/.next/BUILD_ID does not exist; serving the Vite build instead");
  }
  return "vite";
}

/** The worker with the Next.js build id in place of the placeholder; unstamped in development, where it stays inert. */
function readServiceWorker(uiRoot: string, dev: boolean): string {
  const source = fs.readFileSync(path.join(uiRoot, "public", "sw.js"), "utf8");
  if (dev) return source;
  const buildId = readNextBuildId(uiRoot);
  if (!buildId) throw new Error("ui/.next/BUILD_ID is missing; the service worker cannot be stamped");
  if (!source.includes(SERVICE_WORKER_BUILD_ID_PLACEHOLDER)) {
    throw new Error(`ui/public/sw.js is missing the ${SERVICE_WORKER_BUILD_ID_PLACEHOLDER} placeholder`);
  }
  return source.split(SERVICE_WORKER_BUILD_ID_PLACEHOLDER).join(buildId);
}

export interface MountedNextUi {
  /** The `ui` value of `GET /api/health`. */
  health(): UiHealthState;
  /** Stops the child; resolves when it is gone. */
  stop(): Promise<void>;
  /** Development only: the `upgrade` listener that carries hot reload to the child. */
  upgrade: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null;
}

/**
 * Starts the Next.js child and mounts, in order: `/sw.js`, the static files
 * (`/_next/static` and `ui/public`, production only) and, last, the proxy. Call
 * it after every API and plugin route.
 */
export function mountNextUi(
  app: Express,
  input: {
    uiRoot: string;
    dev: boolean;
    logger: NextChildLogger;
    child?: Pick<NextChildOptions, "spawn" | "env" | "readyDeadlineMs" | "backoff" | "stopGraceMs" | "command" | "args">;
  },
): MountedNextUi {
  const { uiRoot, dev, logger } = input;
  const child = createNextChild({ uiRoot, dev, logger, ...input.child });
  child.start();

  // The route comes before the static files of `ui/public`, which hold the same
  // file, so the stamped copy is the one served.
  try {
    const serviceWorker = readServiceWorker(uiRoot, dev);
    app.get("/sw.js", (_req, res) => {
      res.type("js").set("Cache-Control", "no-cache").send(serviceWorker);
    });
  } catch (err) {
    logger.error({ err }, "service worker not served by the UI runtime");
  }

  if (!dev) {
    // Build output never changes under a name; `.br` and `.gz` siblings are
    // written by the build and served to clients that accept them.
    const nextStatic = path.join(uiRoot, ".next", "static");
    app.use(
      "/_next/static",
      precompressedStatic(nextStatic, { maxAge: "1y", immutable: true }),
      express.static(nextStatic, { maxAge: "1y", immutable: true }),
      (req, res, next) => {
        // A file that is not in the build is not something Next.js can serve.
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        res.status(404).set("Cache-Control", "no-store").end();
      },
    );
    const publicDir = path.join(uiRoot, "public");
    if (fs.existsSync(publicDir)) {
      app.use(
        express.static(publicDir, {
          index: false,
          maxAge: "1h",
          setHeaders(res, filePath) {
            const override = staticUiCacheControl(filePath);
            if (override) res.set("Cache-Control", override);
          },
        }),
      );
    }
  }

  app.use(createNextProxy({ child, dev, logger }));

  return {
    health: () => child.state(),
    stop: () => child.stop(),
    upgrade: dev ? createNextHmrUpgradeHandler({ child, logger }) : null,
  };
}
