import type { Request, Response } from "express";
import type { accessService } from "../services/index.js";

/**
 * Company-wide read guard for aggregate data (costs, observability). It allows board members and
 * the same-company agents that `company_scope:read` allows, and denies low-trust agents.
 *
 * @param access - The access service.
 * @param req - The request whose actor is checked.
 * @param res - The response; a 403 with `deniedMessage` is sent when the actor is not allowed.
 * @param companyId - The company whose data is read.
 * @param deniedMessage - The error text for a denied actor.
 * @returns True when allowed. When false, the response has already been sent.
 */
export async function assertCompanyScopeReadAllowed(
  access: Pick<ReturnType<typeof accessService>, "decide">,
  req: Request,
  res: Response,
  companyId: string,
  deniedMessage: string,
): Promise<boolean> {
  const decision = await access.decide({
    actor: req.actor,
    action: "company_scope:read",
    resource: { type: "company", companyId },
  });
  if (decision.allowed) return true;
  res.status(403).json({ error: deniedMessage });
  return false;
}
