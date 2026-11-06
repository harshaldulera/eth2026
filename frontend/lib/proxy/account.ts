import { zgConfig } from "./config";

export type KeyKind = "inference" | "management" | "invalid" | "unreachable";

/**
 * Classify a 0G router key for free (no inference spent) by calling /v1/account/balance:
 *   200 → management key (mk-, has account:read) — can read balance, can't be used for chat
 *   403 insufficient_scope → valid inference key (sk-)
 *   401 → invalid
 */
export async function checkKey(key: string): Promise<{ kind: KeyKind; balance?: Balance }> {
  try {
    const res = await fetch(`${zgConfig.baseUrl}/account/balance`, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" });
    if (res.status === 200) return { kind: "management", balance: toBalance(await res.json()) };
    if (res.status === 403) return { kind: "inference" };
    if (res.status === 401) return { kind: "invalid" };
    return { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}

export interface Balance {
  /** Spendable now, in 0G (converted from neuron, 1e18). */
  total: number;
  deposit: number;
  address?: string;
}

const fromNeuron = (v: unknown) => {
  try {
    const n = BigInt(String(v ?? "0"));
    return Number(n / BigInt(1e12)) / 1e6; // keep 6 decimals without float overflow
  } catch {
    return 0;
  }
};

function toBalance(j: Record<string, unknown>): Balance {
  return { total: fromNeuron(j.total_balance), deposit: fromNeuron(j.deposit_balance), address: typeof j.address === "string" ? j.address : undefined };
}

/** Read the balance with a management key. Returns null if the key can't read it. */
export async function getBalance(mgmtKey: string): Promise<Balance | null> {
  const r = await checkKey(mgmtKey);
  return r.kind === "management" ? r.balance! : null;
}
