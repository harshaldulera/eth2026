import { z } from "zod";
import { env, isStub } from "@/lib/config/env";
import { getCastle } from "@/lib/castles";
import { createPayerFetch, isSpendControlRefusal, SpendControlError } from "@/lib/pay";
import { vaultStateOf } from "@/lib/vault";
import { err, errorMessage, internalFetch, json, readBody } from "../../_lib/http";

/**
 * POST /api/play/start — the browser's "Lay siege" button. The SERVER pays from the arena's demo
 * raider wallet with a real x402 client against /api/siege/start (402 -> sign -> retry), so the
 * browser never holds a key. Stub mode pays as "0.0.stub-raider".
 */

const Body = z.object({ castleId: z.string().min(1).max(120), free: z.boolean().optional() });

const STUB_DEMO_RAIDER = "0.0.stub-raider";

function demoRaider(): { accountId: string; privateKey?: string } | null {
  if (isStub()) return { accountId: STUB_DEMO_RAIDER };
  const e = env();
  if (!e.RAIDER_OPERATOR_ID || !e.RAIDER_OPERATOR_KEY) return null;
  return { accountId: e.RAIDER_OPERATOR_ID, privateKey: e.RAIDER_OPERATOR_KEY };
}

export async function POST(req: Request) {
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  const { castleId, free } = body.data;

  const castle = getCastle(castleId);
  if (!castle) return err(404, "castle_not_found");
  // Same rule as /api/siege/start, checked before the demo wallet signs anything.
  const state = vaultStateOf(castleId);
  if (state !== "guarding" && castle.status === "open") return err(409, "not_guarding", { vaultState: state });
  const raider = demoRaider();
  if (!raider) return err(503, "demo_raider_not_configured", { message: "Set RAIDER_OPERATOR_ID / RAIDER_OPERATOR_KEY." });

  const payerFetch = createPayerFetch({ ...raider, perPaymentCap: castle.fee }, internalFetch());
  let res: Response;
  try {
    res = await payerFetch(new URL("/api/siege/start", req.url), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(free ? { castleId, free: true, wallet: raider.accountId } : { castleId }),
    });
  } catch (e) {
    // Stub: SpendControlError. Testnet: the x402 client's "…rejected by spendControls.allowedAssets maxAmountPerPayment…".
    if (e instanceof SpendControlError || isSpendControlRefusal(e)) {
      return err(402, "spend_control", { message: errorMessage(e) });
    }
    return err(502, "payment_failed", { message: errorMessage(e) });
  }

  const data = (await res.json().catch(() => null)) as { siegeId?: string; receipt?: unknown; error?: string } | null;
  if (res.ok && data?.siegeId) return json({ siegeId: data.siegeId, receipt: data.receipt });
  // 402 here means the payment itself was rejected after signing.
  if (res.status === 402) return err(502, "payment_failed", { detail: data });
  return json(data && typeof data === "object" && "error" in data ? data : { error: `start_failed_${res.status}`, detail: data }, res.status);
}
