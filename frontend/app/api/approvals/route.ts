import { hashKey } from "@/lib/auth/keys";
import { listApprovals, type ApprovalScope } from "@/lib/pay";
import type { ApprovalStatus } from "@/lib/types";
import { atRequestTime, isOwner, json, readOperatorKeys } from "../_lib/http";

const STATUSES = ["pending", "approved", "denied", "all"] as const;

/**
 * GET /api/approvals?status=pending|approved|denied|all (default pending).
 *  - operator key(s) (`x-siege-operator-key`, comma list): only those units' asks;
 *  - the owner cookie: every ask;
 *  - neither: the arena's own units only (a red teamer's asks are for that red teamer).
 */
export async function GET(req: Request) {
  await atRequestTime();
  const q = new URL(req.url).searchParams.get("status") ?? "pending";
  const status = (STATUSES as readonly string[]).includes(q) ? (q as ApprovalStatus | "all") : "pending";
  const keys = readOperatorKeys(req);
  const scope: ApprovalScope = isOwner(req)
    ? { kind: "all" }
    : keys.length
      ? { kind: "operator", hashes: keys.map(hashKey) }
      : { kind: "public" };
  return json({ approvals: await listApprovals(status, scope) });
}
