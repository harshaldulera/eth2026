/**
 * Browser-side store for a red teamer's unit operator keys (`rk_…`, shown once at creation).
 *
 *   localStorage "siege.operatorKeys" = { "<agentId>": "rk_…" }       keys of created units
 *   localStorage "siege.operatorDraftKeys" = { "<draftId>": "rk_…" }  keys saved the moment they were shown,
 *                                                                      before the deposit made the unit
 *
 * Every read and write is wrapped: private windows and blocked storage just mean "no keys here".
 * Client-safe (no server imports); the API client attaches these as `x-siege-operator-key`.
 */

export const OPERATOR_KEYS_STORAGE = "siege.operatorKeys";
export const OPERATOR_DRAFT_KEYS_STORAGE = "siege.operatorDraftKeys";
/** Fired on this window after every write (the `storage` event only reaches other tabs). */
export const OPERATOR_KEYS_EVENT = "siege:operator-keys";
export const OPERATOR_KEY_HEADER = "x-siege-operator-key";
const RK = /^rk_[A-Za-z0-9_-]{24}$/;

type KeyMap = Record<string, string>;

function read(name: string): KeyMap {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(name);
    const v: unknown = raw ? JSON.parse(raw) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: KeyMap = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === "string" && RK.test(val)) out[k] = val;
    return out;
  } catch {
    return {};
  }
}

function write(name: string, map: KeyMap): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(name, JSON.stringify(map));
      window.dispatchEvent(new Event(OPERATOR_KEYS_EVENT));
    }
  } catch {
    /* storage unavailable: the key is shown once and the red teamer keeps their own copy */
  }
}

/** Unit id -> operator key, for created units. */
export function operatorKeys(): KeyMap {
  return read(OPERATOR_KEYS_STORAGE);
}

/** The operator key for this unit, if this browser holds it. */
export function operatorKeyFor(agentId: string): string | null {
  return operatorKeys()[agentId] ?? null;
}

/** Every operator key in this browser (created units and pending drafts), deduplicated. */
export function allOperatorKeys(): string[] {
  return [...new Set([...Object.values(operatorKeys()), ...Object.values(read(OPERATOR_DRAFT_KEYS_STORAGE))])].slice(0, 32);
}

export function hasOperatorKeys(): boolean {
  return allOperatorKeys().length > 0;
}

export function saveOperatorKey(agentId: string, key: string): void {
  if (RK.test(key)) write(OPERATOR_KEYS_STORAGE, { ...operatorKeys(), [agentId]: key });
}

/** Save the key before its unit exists (the moment it is shown). */
export function saveDraftKey(draftId: string, key: string): void {
  if (RK.test(key)) write(OPERATOR_DRAFT_KEYS_STORAGE, { ...read(OPERATOR_DRAFT_KEYS_STORAGE), [draftId]: key });
}

/** The unit exists now: move the draft's key to `siege.operatorKeys[agentId]`. */
export function promoteDraftKey(draftId: string, agentId: string): void {
  const drafts = read(OPERATOR_DRAFT_KEYS_STORAGE);
  const key = drafts[draftId];
  if (!key) return;
  saveOperatorKey(agentId, key);
  delete drafts[draftId];
  write(OPERATOR_DRAFT_KEYS_STORAGE, drafts);
}

export function forgetOperatorKey(agentId: string): void {
  const m = operatorKeys();
  delete m[agentId];
  write(OPERATOR_KEYS_STORAGE, m);
}

/** Headers for a call about one unit: its key, else none (the owner cookie may still apply). */
export function unitHeaders(agentId: string): Record<string, string> {
  const k = operatorKeyFor(agentId);
  return k ? { [OPERATOR_KEY_HEADER]: k } : {};
}

/** Headers for list calls (agents?mine, approvals): every key in this browser, comma-separated. */
export function allUnitHeaders(): Record<string, string> {
  const ks = allOperatorKeys();
  return ks.length ? { [OPERATOR_KEY_HEADER]: ks.join(",") } : {};
}
