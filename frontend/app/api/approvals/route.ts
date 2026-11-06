import { listApprovals } from "@/lib/pay";
import type { ApprovalStatus } from "@/lib/types";
import { atRequestTime, json } from "../_lib/http";

const STATUSES = ["pending", "approved", "denied", "all"] as const;

/** GET /api/approvals?status=pending|approved|denied|all (default pending). Readable without the owner cookie. */
export async function GET(req: Request) {
  await atRequestTime();
  const q = new URL(req.url).searchParams.get("status") ?? "pending";
  const status = (STATUSES as readonly string[]).includes(q) ? (q as ApprovalStatus | "all") : "pending";
  return json({ approvals: await listApprovals(status) });
}
