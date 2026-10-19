import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, issues } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import type { LabelledPair, LabelledPairRef } from "./duplicate-calibration.js";
import { duplicateDetectionService, type DuplicateDetectionService } from "./duplicate-detection.js";
import { prepareIssueText } from "./duplicate-lexical.js";
import { issueService } from "./issues.js";
import {
  JUDGE_API_KEY_SECRET_NAME,
  createJudgeClient,
  createJudgeUsageStore,
  readJudgeConfig,
  type JudgeClient,
  type JudgeKeyResolver,
  type JudgeTransport,
} from "./judge-client.js";
import { secretService } from "./secrets.js";

/**
 * Looks up the company's own gateway key in its secrets. A company without the secret gets
 * `undefined`, so its issue text is never sent anywhere. Each read is audited as a system access
 * by `consumerId`.
 */
export function createCompanySecretKeyResolver(db: Db, consumerId = "duplicate-detection"): JudgeKeyResolver {
  const secrets = secretService(db);
  return async (companyId) => {
    const secret = await secrets.getByName(companyId, JUDGE_API_KEY_SECRET_NAME);
    if (!secret) return undefined;
    const value = await secrets.resolveSecretValue(companyId, secret.id, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId,
        actorType: "system",
        actorId: consumerId,
      },
    });
    return value.trim() || undefined;
  };
}

/**
 * Wires duplicate detection for the running server: each company's own gateway key from its secrets,
 * the daily cap backed by the database, and system comments posted through the issue service.
 * Create it once so the pre-create check and the after-create check share one answer cache.
 */
export function createDuplicateDetection(db: Db): DuplicateDetectionService {
  const config = readJudgeConfig();
  const issues = issueService(db);
  return duplicateDetectionService({
    db,
    judge: createJudgeClient({
      config,
      usage: createJudgeUsageStore(db, config.dailyCallCap),
      resolveApiKey: createCompanySecretKeyResolver(db),
    }),
    postSystemComment: (issueId, body, tx) => issues.addComment(issueId, body, {}, { authorType: "system" }, tx),
  });
}

export type CompanyCalibrationSetup =
  | { ok: true; judge: JudgeClient; pairs: LabelledPair[] }
  | { ok: false; reason: string };

/**
 * Prepares model calibration for one company through the same governed path as production.
 * The company must exist and have opted in (mode not `off`). Every pair must name two of that
 * company's issues; their stored text is loaded here, so nothing from another company or from the
 * file itself is sent. The gateway key comes from that company's own secret (audited as
 * `duplicate-calibration`), and every call counts against that company's daily cap.
 * There is no environment-key fallback: without a readable company secret, setup is refused.
 */
export async function prepareCompanyCalibration(
  db: Db,
  companyId: string,
  refs: readonly LabelledPairRef[],
  options: { transportFor?: (apiKey: string) => JudgeTransport } = {},
): Promise<CompanyCalibrationSetup> {
  if (!isUuidLike(companyId)) return { ok: false, reason: "--company-id must be a company UUID." };
  const [company] = await db
    .select({ mode: companies.duplicateDetectionMode })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!company) return { ok: false, reason: `Company ${companyId} was not found.` };
  if (company.mode === "off") {
    return {
      ok: false,
      reason:
        "Duplicate detection is off for this company, so it has not opted in to sending issue text to the gateway. " +
        "Set its mode to suggest first, or pass --tier1-only.",
    };
  }

  const ids = [...new Set(refs.flatMap((ref) => [ref.aIssueId, ref.bIssueId]))];
  const rows = await db
    .select({ id: issues.id, title: issues.title, description: issues.description })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
  const textById = new Map(rows.map((row) => [row.id, prepareIssueText(row)]));
  const missing = ids.filter((id) => !textById.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `${missing.length} issue id(s) in the export are not issues of this company (first: ${missing[0]}). ` +
        "Calibrate one company at a time, with that company's issue ids.",
    };
  }

  const config = readJudgeConfig();
  const judge = createJudgeClient({
    config,
    usage: createJudgeUsageStore(db, config.dailyCallCap),
    resolveApiKey: createCompanySecretKeyResolver(db, "duplicate-calibration"),
    transportFor: options.transportFor,
  });
  if (!(await judge.isAvailable(companyId))) {
    return {
      ok: false,
      reason:
        `This company has no readable "${JUDGE_API_KEY_SECRET_NAME}" secret. Add it as a company secret, ` +
        "run the script where the instance's secrets are configured, or pass --tier1-only.",
    };
  }

  const pairs = refs.flatMap((ref): LabelledPair[] => {
    const a = textById.get(ref.aIssueId);
    const b = textById.get(ref.bIssueId);
    return a && b ? [{ id: ref.id, a, b, duplicate: ref.duplicate }] : [];
  });
  return { ok: true, judge, pairs };
}
