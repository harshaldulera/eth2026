/**
 * HashScan links. Pure, safe to import anywhere (no env access): Siege runs on Hedera testnet.
 * Stub references (ids starting with "stub:" or containing "stub-") have no explorer page:
 * their url is "#stub" so an <a href> stays harmless; check isStubRef() to render plain text.
 */

export const HASHSCAN_BASE = "https://hashscan.io/testnet";
export const STUB_URL = "#stub";

export function isStubRef(id: string | null | undefined): boolean {
  if (!id) return false;
  return id.startsWith("stub:") || id.includes(".stub-") || id.startsWith("stub-");
}

/** "0.0.5@1700000000.000000001" -> "0.0.5-1700000000-000000001" (mirror node / HashScan format). */
export function normalizeTxId(txId: string): string {
  const at = txId.indexOf("@");
  if (at < 0) return txId;
  return `${txId.slice(0, at)}-${txId.slice(at + 1).replace(".", "-")}`;
}

/** Hedera tx id ("0.0.5@sec.nanos" or "0.0.5-sec-nanos") or EVM tx hash ("0x…"). */
export function txUrl(txId: string): string {
  if (isStubRef(txId)) return STUB_URL;
  return `${HASHSCAN_BASE}/transaction/${txId.startsWith("0x") ? txId : normalizeTxId(txId)}`;
}

export function accountUrl(id: string): string {
  return isStubRef(id) ? STUB_URL : `${HASHSCAN_BASE}/account/${id}`;
}

/** Contract by EVM address ("0x…") or contract id ("0.0.x"). */
export function contractUrl(addr: string): string {
  return isStubRef(addr) ? STUB_URL : `${HASHSCAN_BASE}/contract/${addr}`;
}

export function topicUrl(id: string): string {
  return isStubRef(id) ? STUB_URL : `${HASHSCAN_BASE}/topic/${id}`;
}
