import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { redactSensitiveText } from "../../redaction.js";
import type { JudgeClient } from "../../services/judge-client.js";
import { createJudgeAdapter } from "./adapters/judge.js";
import { createPostgresEvalsRepository } from "./adapters/postgres.js";
import { createPostgresRunContext } from "./adapters/run-context.js";
import type { EvalsRuntime, EvalsSettings } from "./application/ports.js";
import { createEvalsService, sweepExpiredEvalInputs } from "./application/use-cases.js";

export type { EvalsService, RunCallerContext } from "./application/use-cases.js";
export type { EvalActor, RejectedInputDetails } from "./application/types.js";
export type { EvalsSettings } from "./application/ports.js";
export { EvalInputRejectedError, EvalsApplicationError } from "./application/types.js";

function defaultRuntime(): EvalsRuntime {
  return {
    now: () => new Date(),
    monotonicMs: () => performance.now(),
    newId: () => randomUUID(),
    sha256Hex: (text) => createHash("sha256").update(text).digest("hex"),
    redactText: redactSensitiveText,
  };
}

/**
 * Wires company evals for the running server. `judge` is the one Jev client; the module never builds
 * its own.
 */
export function createEvalsModule(options: { db: Db; judge: JudgeClient; settings: EvalsSettings }) {
  return createEvalsService({
    repo: createPostgresEvalsRepository(options.db),
    judge: createJudgeAdapter(options.judge),
    runContext: createPostgresRunContext(options.db),
    runtime: defaultRuntime(),
    settings: options.settings,
  });
}

/** The retention sweep. It clears stored eval inputs past their expiry and keeps the hash and size. */
export function createEvalInputRetention(db: Db) {
  const repo = createPostgresEvalsRepository(db);
  const runtime = defaultRuntime();
  return {
    sweep: (): Promise<number> => sweepExpiredEvalInputs({ repo, runtime }),
  };
}
